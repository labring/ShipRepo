import { NextRequest, NextResponse } from 'next/server'
import { finalizeActiveTurnFailure, reconcileIncompleteTurnSafely } from '@/lib/codex-gateway/completion'
import { getCodexGatewayEventStreamUrl } from '@/lib/codex-gateway/client'
import { diagnoseCodexTurnFailure } from '@/lib/codex-gateway/failure-diagnostics'
import { getTaskGatewayContext } from '@/lib/codex-gateway/task'
import type { CodexGatewayState } from '@/lib/codex-gateway/types'
import { closeTaskStream, getTaskStream, recordTaskEvent, touchTaskStream } from '@/lib/task-events'
import { formatKeyTaskLogMessage, TASK_FLOW_LOGS } from '@/lib/utils/task-flow-logs'
import { getServerSession } from '@/lib/session/get-server-session'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 1800

const STREAM_HEARTBEAT_INTERVAL_MS = 10_000

interface RouteParams {
  params: Promise<{
    taskId: string
  }>
}

function mapGatewayEventKind(eventName: string) {
  switch (eventName) {
    case 'session':
      return 'gateway.session.opened' as const
    case 'state':
      return 'gateway.state.snapshot' as const
    case 'notification':
      return 'gateway.notification' as const
    case 'server-request':
      return 'gateway.server_request' as const
    case 'warning':
      return 'gateway.warning' as const
    case 'session-closed':
      return 'gateway.session.closed' as const
    default:
      return null
  }
}

function parseSseBlock(block: string): {
  dataText: string
  eventName: string
} | null {
  if (!block.trim()) {
    return null
  }

  let eventName = 'message'
  const dataLines: string[] = []

  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith('event:')) {
      eventName = line.slice('event:'.length).trim() || 'message'
      continue
    }

    if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trimStart())
    }
  }

  return {
    eventName,
    dataText: dataLines.join('\n'),
  }
}

function encodeSseBlock(encoder: TextEncoder, block: string): Uint8Array {
  return encoder.encode(`${block}\n\n`)
}

async function persistGatewayEvent(input: {
  eventName: string
  payload: Record<string, unknown> | null
  sessionId: string
  streamId: string
  taskId: string
  transcriptCursor: number | null
}) {
  const eventKind = mapGatewayEventKind(input.eventName)

  if (!eventKind) {
    return
  }

  if (eventKind === 'gateway.session.opened') {
    const nextSessionId =
      typeof input.payload?.id === 'string' && input.payload.id.trim() ? input.payload.id.trim() : input.sessionId

    await touchTaskStream(input.streamId, { sessionId: nextSessionId })
    await recordTaskEvent({
      taskId: input.taskId,
      streamId: input.streamId,
      kind: eventKind,
      sessionId: nextSessionId,
      payload: input.payload,
    })
    return
  }

  if (eventKind === 'gateway.state.snapshot') {
    const state = (input.payload || {}) as CodexGatewayState & Record<string, unknown>

    await touchTaskStream(input.streamId, {
      threadId: state.threadId || null,
      turnId: state.currentTurnId || null,
    })

    await recordTaskEvent({
      taskId: input.taskId,
      streamId: input.streamId,
      kind: eventKind,
      sessionId: input.sessionId,
      threadId: state.threadId || null,
      turnId: state.currentTurnId || null,
      payload: {
        ...state,
        transcriptCursor: input.transcriptCursor,
      },
    })

    if (!state.activeTurn && state.lastTurnStatus) {
      await closeTaskStream(input.streamId, 'closed')
      await reconcileIncompleteTurnSafely(input.taskId, 2_500).catch(() => {
        console.error('Failed to reconcile chat v2 stream terminal state')
      })
    }

    return
  }

  await recordTaskEvent({
    taskId: input.taskId,
    streamId: input.streamId,
    kind: eventKind,
    sessionId: input.sessionId,
    payload: input.payload,
  })

  if (eventKind === 'gateway.session.closed') {
    await closeTaskStream(input.streamId, 'closed')
    await reconcileIncompleteTurnSafely(input.taskId, 2_500).catch(() => {
      console.error('Failed to reconcile chat v2 session closure')
    })
  }
}

async function persistMissingSessionFailure(taskId: string, sessionId: string) {
  await finalizeActiveTurnFailure({
    taskId,
    sessionId,
    error: 'Codex gateway session is no longer available',
    clearGatewaySession: true,
  }).catch(() => {
    console.error('Failed to persist missing Codex gateway session')
  })
}

async function logStreamFailureDiagnostic(input: {
  fallbackError: string
  httpStatus?: number
  sessionId?: string | null
  taskId: string
  turnStatus?: string | null
}) {
  const diagnostic = await diagnoseCodexTurnFailure({
    taskId: input.taskId,
    sessionId: input.sessionId,
    fallbackError: input.fallbackError,
    httpStatus: input.httpStatus,
    turnStatus: input.turnStatus,
  })

  console.info(
    formatKeyTaskLogMessage(TASK_FLOW_LOGS.GATEWAY_STREAM_RECONNECTING, {
      sessionId: input.sessionId ?? null,
      streamState: 'errored',
      errorSource: diagnostic.source,
      httpStatus: input.httpStatus,
      turnStatus: input.turnStatus ?? null,
    }),
  )
  console.error('Chat v2 stream upstream failed', diagnostic)
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let streamId: string | null = null
  let streamSessionId: string | null = null
  let taskId: string | null = null

  try {
    const session = await getServerSession()
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    ;({ taskId } = await params)
    const resolvedTaskId = taskId
    streamId = request.nextUrl.searchParams.get('streamId')

    if (!streamId) {
      return NextResponse.json({ error: 'Missing stream id' }, { status: 400 })
    }

    const resolvedStreamId = streamId

    const stream = await getTaskStream(resolvedStreamId)
    if (!stream || stream.taskId !== resolvedTaskId || stream.status !== 'active') {
      return NextResponse.json({ error: 'Stream not found' }, { status: 404 })
    }
    streamSessionId = stream.sessionId

    const { task, gatewayUrl, gatewayAuthToken } = await getTaskGatewayContext(resolvedTaskId, session.user.id)

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 })
    }

    if (!gatewayUrl) {
      return NextResponse.json({ error: 'Gateway URL is not configured' }, { status: 400 })
    }

    if (task.activeTurnSessionId && task.activeTurnSessionId !== stream.sessionId) {
      await closeTaskStream(resolvedStreamId, 'errored')
      return NextResponse.json({ error: 'Stream session is no longer active' }, { status: 410 })
    }

    const streamState =
      stream.lastEventAt.getTime() > stream.startedAt.getTime() ? ('resumed' as const) : ('connected' as const)
    console.info(
      formatKeyTaskLogMessage(
        streamState === 'resumed' ? TASK_FLOW_LOGS.GATEWAY_STREAM_RESUMED : TASK_FLOW_LOGS.GATEWAY_STREAM_CONNECTED,
        {
          sessionId: stream.sessionId,
          streamState,
        },
      ),
    )

    const upstream = await fetch(getCodexGatewayEventStreamUrl(gatewayUrl, stream.sessionId, gatewayAuthToken), {
      headers: {
        accept: 'text/event-stream',
      },
      cache: 'no-store',
    })

    if (!upstream.ok || !upstream.body) {
      await closeTaskStream(resolvedStreamId, 'errored')
      await logStreamFailureDiagnostic({
        taskId: resolvedTaskId,
        sessionId: stream.sessionId,
        fallbackError: 'Codex gateway turn failed',
        httpStatus: upstream.status,
      })

      if (upstream.status === 404 || upstream.status === 410) {
        await persistMissingSessionFailure(resolvedTaskId, stream.sessionId)
      } else if (upstream.status >= 500 && upstream.status < 600) {
        await finalizeActiveTurnFailure({
          taskId: resolvedTaskId,
          sessionId: stream.sessionId,
          error: 'Codex gateway turn failed',
          clearGatewaySession: true,
        }).catch(() => {
          console.error('Failed to force finalize chat v2 stream connection error')
        })
      } else {
        await reconcileIncompleteTurnSafely(resolvedTaskId, 2_500).catch(() => {
          console.error('Failed to reconcile chat v2 stream connection error')
        })
      }

      return NextResponse.json({ error: 'Failed to connect to Codex gateway events' }, { status: 502 })
    }

    const headers = new Headers()
    headers.set('content-type', 'text/event-stream; charset=utf-8')
    headers.set('cache-control', 'no-cache, no-transform')
    headers.set('connection', 'keep-alive')
    headers.set('x-accel-buffering', 'no')

    const transcriptCursor =
      task.activeTurnSessionId === stream.sessionId && typeof task.activeTurnTranscriptCursor === 'number'
        ? task.activeTurnTranscriptCursor
        : null

    const reader = upstream.body.getReader()
    let sseBuffer = ''
    const heartbeatChunk = encoder.encode(': ping\n\n')

    const handleSseBlock = async (block: string) => {
      const parsedBlock = parseSseBlock(block)
      if (!parsedBlock || !parsedBlock.dataText) {
        return encodeSseBlock(encoder, block)
      }

      try {
        const payload = JSON.parse(parsedBlock.dataText) as Record<string, unknown>
        await persistGatewayEvent({
          taskId: resolvedTaskId,
          streamId: resolvedStreamId,
          sessionId: stream.sessionId,
          eventName: parsedBlock.eventName,
          payload,
          transcriptCursor,
        })
      } catch (error) {
        console.error('Failed to persist gateway stream event', error)
      }

      return encodeSseBlock(encoder, block)
    }

    const flushBufferedEvents = async (flushAll: boolean) => {
      const encodedBlocks: Uint8Array[] = []

      while (true) {
        const separatorMatch = sseBuffer.match(/\r?\n\r?\n/)
        if (!separatorMatch || separatorMatch.index === undefined) {
          break
        }

        const block = sseBuffer.slice(0, separatorMatch.index)
        sseBuffer = sseBuffer.slice(separatorMatch.index + separatorMatch[0].length)
        encodedBlocks.push(await handleSseBlock(block))
      }

      if (flushAll && sseBuffer.trim()) {
        console.error('Chat v2 stream ended with incomplete SSE block')
        sseBuffer = ''
      }

      return encodedBlocks
    }

    const streamResponse = new ReadableStream<Uint8Array>({
      async start(controller) {
        let closed = false
        const heartbeatTimer = setInterval(() => {
          if (closed || sseBuffer.trim()) {
            return
          }

          try {
            controller.enqueue(heartbeatChunk)
          } catch {
            // Ignore enqueue errors after stream shutdown.
          }
        }, STREAM_HEARTBEAT_INTERVAL_MS)

        try {
          while (true) {
            const { done, value } = await reader.read()

            if (done) {
              break
            }

            if (!value) {
              continue
            }

            sseBuffer += decoder.decode(value, { stream: true })
            const encodedBlocks = await flushBufferedEvents(false)
            for (const encodedBlock of encodedBlocks) {
              controller.enqueue(encodedBlock)
            }
          }

          sseBuffer += decoder.decode()
          const encodedBlocks = await flushBufferedEvents(true)
          for (const encodedBlock of encodedBlocks) {
            controller.enqueue(encodedBlock)
          }
          closed = true
          controller.close()
        } catch (error) {
          await closeTaskStream(resolvedStreamId, 'errored')
          await logStreamFailureDiagnostic({
            taskId: resolvedTaskId,
            sessionId: stream.sessionId,
            fallbackError: 'Codex gateway turn failed',
          })
          await finalizeActiveTurnFailure({
            taskId: resolvedTaskId,
            sessionId: stream.sessionId,
            error: 'Codex gateway turn failed',
            clearGatewaySession: true,
          }).catch(() => {
            console.error('Failed to force finalize chat v2 stream reader error')
          })
          try {
            closed = true
            controller.close()
          } catch {
            // Ignore close errors after upstream socket termination.
          }
        } finally {
          closed = true
          clearInterval(heartbeatTimer)
          reader.releaseLock()
        }
      },
      async cancel() {
        await reader.cancel()
      },
    })

    return new Response(streamResponse, {
      status: 200,
      headers,
    })
  } catch (error) {
    if (streamId) {
      await closeTaskStream(streamId, 'errored').catch(() => {
        console.error('Failed to close chat v2 stream after proxy error')
      })
    }

    if (taskId) {
      await logStreamFailureDiagnostic({
        taskId,
        sessionId: streamSessionId,
        fallbackError: 'Codex gateway turn failed',
      }).catch(() => {
        console.error('Failed to log chat v2 stream proxy diagnostic')
      })
      await finalizeActiveTurnFailure({
        taskId,
        sessionId: streamSessionId,
        error: 'Codex gateway turn failed',
        clearGatewaySession: true,
      }).catch(() => {
        console.error('Failed to force finalize chat v2 stream proxy error')
      })
    }

    console.error('Failed to proxy chat v2 stream:', error)
    return NextResponse.json({ error: 'Failed to proxy chat stream' }, { status: 500 })
  }
}
