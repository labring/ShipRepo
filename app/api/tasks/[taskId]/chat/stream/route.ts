import { NextRequest, NextResponse } from 'next/server'
import { getCodexGatewayEventStreamUrl } from '@/lib/codex-gateway/client'
import {
  buildCodexAssistantMessageId,
  getAssistantContentAfterCursor,
  persistAssistantMessage,
} from '@/lib/codex-gateway/completion'
import { readChatStreamTicket } from '@/lib/codex-gateway/stream-ticket'
import { getTaskGatewayContext } from '@/lib/codex-gateway/task'
import type { CodexGatewayState } from '@/lib/codex-gateway/types'
import { getServerSession } from '@/lib/session/get-server-session'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

interface RouteParams {
  params: Promise<{
    taskId: string
  }>
}

function shouldPersistAssistantContentUpdate(input: {
  content: string
  isFinal: boolean
  lastPersistedAt: number
  lastPersistedContent: string
}): boolean {
  const trimmedContent = input.content.trim()

  if (!trimmedContent) {
    return false
  }

  if (trimmedContent === input.lastPersistedContent) {
    return false
  }

  if (trimmedContent.length < input.lastPersistedContent.length) {
    return false
  }

  if (input.isFinal || !input.lastPersistedContent) {
    return true
  }

  if (trimmedContent.length - input.lastPersistedContent.length >= 96) {
    return true
  }

  return Date.now() - input.lastPersistedAt >= 1000
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const session = await getServerSession()
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { taskId } = await params
    const ticket = request.nextUrl.searchParams.get('ticket')

    if (!ticket) {
      return NextResponse.json({ error: 'Missing stream ticket' }, { status: 400 })
    }

    const payload = await readChatStreamTicket(ticket)
    if (!payload || payload.taskId !== taskId || payload.userId !== session.user.id) {
      return NextResponse.json({ error: 'Invalid stream ticket' }, { status: 401 })
    }

    const { task, gatewayUrl, gatewayAuthToken } = await getTaskGatewayContext(taskId, session.user.id)

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 })
    }

    if (task.gatewaySessionId !== payload.sessionId && task.activeTurnSessionId !== payload.sessionId) {
      return NextResponse.json({ error: 'Stream session is no longer active' }, { status: 410 })
    }

    if (!gatewayUrl) {
      return NextResponse.json({ error: 'Gateway URL is not configured' }, { status: 400 })
    }

    const upstream = await fetch(getCodexGatewayEventStreamUrl(gatewayUrl, payload.sessionId, gatewayAuthToken), {
      headers: {
        accept: 'text/event-stream',
      },
      cache: 'no-store',
    })

    if (!upstream.ok || !upstream.body) {
      return NextResponse.json({ error: 'Failed to connect to Codex gateway events' }, { status: 502 })
    }

    const headers = new Headers()
    headers.set('content-type', 'text/event-stream; charset=utf-8')
    headers.set('cache-control', 'no-cache, no-transform')
    headers.set('connection', 'keep-alive')
    headers.set('x-accel-buffering', 'no')

    const transcriptCursor =
      task.activeTurnSessionId === payload.sessionId && typeof task.activeTurnTranscriptCursor === 'number'
        ? task.activeTurnTranscriptCursor
        : null

    if (transcriptCursor === null) {
      return new Response(upstream.body, {
        status: 200,
        headers,
      })
    }

    const reader = upstream.body.getReader()
    const decoder = new TextDecoder()
    let sseBuffer = ''
    let lastPersistedContent = ''
    let lastPersistedAt = 0

    const persistAssistantContent = async (state: CodexGatewayState) => {
      const assistantContent = getAssistantContentAfterCursor(transcriptCursor, state.transcript)
      const isFinal = !state.activeTurn && Boolean(state.lastTurnStatus)

      if (
        !shouldPersistAssistantContentUpdate({
          content: assistantContent,
          isFinal,
          lastPersistedAt,
          lastPersistedContent,
        })
      ) {
        return
      }

      await persistAssistantMessage(taskId, assistantContent, {
        messageId: buildCodexAssistantMessageId(payload.sessionId, transcriptCursor),
      })

      lastPersistedContent = assistantContent.trim()
      lastPersistedAt = Date.now()
    }

    const handleSseBlock = async (block: string) => {
      if (!block.trim()) {
        return
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

      if (eventName !== 'state' || dataLines.length === 0) {
        return
      }

      try {
        const state = JSON.parse(dataLines.join('\n')) as CodexGatewayState
        await persistAssistantContent(state)
      } catch {
        // Ignore malformed upstream state events while continuing to proxy the stream.
      }
    }

    const flushBufferedEvents = async (flushAll: boolean) => {
      while (true) {
        const separatorMatch = sseBuffer.match(/\r?\n\r?\n/)
        if (!separatorMatch || separatorMatch.index === undefined) {
          break
        }

        const block = sseBuffer.slice(0, separatorMatch.index)
        sseBuffer = sseBuffer.slice(separatorMatch.index + separatorMatch[0].length)
        await handleSseBlock(block)
      }

      if (flushAll && sseBuffer.trim()) {
        const finalBlock = sseBuffer
        sseBuffer = ''
        await handleSseBlock(finalBlock)
      }
    }

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          while (true) {
            const { done, value } = await reader.read()

            if (done) {
              break
            }

            if (!value) {
              continue
            }

            controller.enqueue(value)
            sseBuffer += decoder.decode(value, { stream: true })
            await flushBufferedEvents(false)
          }

          sseBuffer += decoder.decode()
          await flushBufferedEvents(true)
          controller.close()
        } catch (error) {
          controller.error(error)
        } finally {
          reader.releaseLock()
        }
      },
      async cancel() {
        await reader.cancel()
      },
    })

    return new Response(stream, {
      status: 200,
      headers,
    })
  } catch {
    console.error('Failed to proxy chat stream')
    return NextResponse.json({ error: 'Failed to proxy chat stream' }, { status: 500 })
  }
}
