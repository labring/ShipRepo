import { eq } from 'drizzle-orm'
import { FORCED_CODEX_MODEL } from '@/lib/codex/defaults'
import { CodexGatewayApiError, getCodexGatewaySessionState, sendCodexGatewayTurn } from '@/lib/codex-gateway/client'
import {
  finalizeTurnCompletion,
  getAssistantContentAfterCursor,
  markTurnCompletionRunning,
  recordTurnCheckpoint,
} from '@/lib/codex-gateway/completion'
import { ensureCodexGatewaySession } from '@/lib/codex-gateway/session'
import { getTaskGatewayContextById } from '@/lib/codex-gateway/task'
import { db } from '@/lib/db/client'
import { taskMessages, tasks } from '@/lib/db/schema'
import { refreshTaskDevboxLease } from '@/lib/devbox/runtime'
import { generateId } from '@/lib/utils/id'
import { createTaskLogger } from '@/lib/utils/task-logger'
import type { CodexGatewaySessionResponse } from '@/lib/codex-gateway/types'

interface StartCodexGatewayTurnOptions {
  appendUserMessage?: boolean
  model?: string | null
}

export interface StartedCodexGatewayTurn {
  gatewayAuthToken: string | null
  gatewayUrl: string
  sessionId: string
  startedAt: Date
  taskId: string
  transcriptCursor: number
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function getGatewayWaitTimeoutMs(maxDuration: number | null | undefined): number {
  if (typeof maxDuration !== 'number' || !Number.isFinite(maxDuration) || maxDuration <= 0) {
    return 5 * 60 * 1000
  }

  return Math.min(maxDuration, 30) * 60 * 1000
}

function isSuccessfulTurnStatus(status: string | null | undefined): boolean {
  return status === 'completed' || status === 'succeeded'
}

function getTurnTranscriptCursor(
  transcript: {
    role: string
    text: string
  }[],
): number {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    if (transcript[index]?.role === 'user') {
      return index
    }
  }

  return transcript.length
}

export async function startCodexGatewayTaskTurn(
  taskId: string,
  prompt: string,
  options: StartCodexGatewayTurnOptions = {},
): Promise<StartedCodexGatewayTurn> {
  const logger = createTaskLogger(taskId)
  const { task, gatewayUrl, gatewayAuthToken } = await getTaskGatewayContextById(taskId)

  if (!task) {
    throw new Error('Task not found')
  }

  if (!gatewayUrl) {
    throw new Error('Codex gateway URL is not configured')
  }

  if (task.selectedModel !== FORCED_CODEX_MODEL) {
    await db
      .update(tasks)
      .set({
        selectedModel: FORCED_CODEX_MODEL,
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, taskId))
  }

  if (options.appendUserMessage) {
    await db.insert(taskMessages).values({
      id: generateId(12),
      taskId,
      role: 'user',
      content: prompt,
    })
  }
  let gatewaySessionId = task.gatewaySessionId
  let turnResponse: CodexGatewaySessionResponse

  if (!gatewaySessionId) {
    const ensuredSession = await ensureCodexGatewaySession({
      task,
      gatewayUrl,
      gatewayAuthToken,
      logger,
    })

    gatewaySessionId = ensuredSession.sessionId
  }

  await logger.info('Forwarding prompt to Codex gateway')
  try {
    turnResponse = await sendCodexGatewayTurn(gatewayUrl, gatewaySessionId, { prompt }, gatewayAuthToken)
  } catch (error) {
    if (!(error instanceof CodexGatewayApiError && error.status === 404)) {
      throw error
    }

    await db
      .update(tasks)
      .set({
        gatewaySessionId: null,
        selectedModel: FORCED_CODEX_MODEL,
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, taskId))

    const refreshedSession = await ensureCodexGatewaySession({
      task: {
        ...task,
        gatewaySessionId: null,
      },
      gatewayUrl,
      gatewayAuthToken,
      logger,
    })

    gatewaySessionId = refreshedSession.sessionId
    turnResponse = await sendCodexGatewayTurn(gatewayUrl, gatewaySessionId, { prompt }, gatewayAuthToken)
  }

  await logger.info('Waiting for Codex gateway response')

  const startedAt = new Date()
  const transcriptCursor = getTurnTranscriptCursor(turnResponse.state.transcript)

  await db
    .update(tasks)
    .set({
      gatewaySessionId,
      gatewayUrl,
      gatewayReadyAt: startedAt,
      selectedModel: FORCED_CODEX_MODEL,
      status: 'processing',
      progress: 0,
      error: null,
      completedAt: null,
      updatedAt: startedAt,
    })
    .where(eq(tasks.id, taskId))

  await recordTurnCheckpoint({
    taskId,
    sessionId: gatewaySessionId,
    transcriptCursor,
    startedAt,
  })

  return {
    taskId,
    sessionId: gatewaySessionId,
    startedAt,
    transcriptCursor,
    gatewayUrl,
    gatewayAuthToken,
  }
}

export async function waitForCodexGatewayTurnCompletion(startedTurn: StartedCodexGatewayTurn): Promise<void> {
  const logger = createTaskLogger(startedTurn.taskId)
  const { taskId, sessionId, transcriptCursor, gatewayUrl, gatewayAuthToken } = startedTurn

  await markTurnCompletionRunning(taskId)

  let finalState: Awaited<ReturnType<typeof getCodexGatewaySessionState>> | null = null
  let maxDuration = 5

  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1)
  if (task?.maxDuration) {
    maxDuration = task.maxDuration
  }

  const timeoutAt = Date.now() + getGatewayWaitTimeoutMs(maxDuration)

  while (Date.now() < timeoutAt) {
    const [currentTask] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1)

    if (!currentTask || currentTask.status === 'stopped') {
      return
    }

    if (currentTask.gatewaySessionId && currentTask.gatewaySessionId !== sessionId) {
      return
    }

    try {
      finalState = await getCodexGatewaySessionState(gatewayUrl, sessionId, gatewayAuthToken)
    } catch (error) {
      if (error instanceof CodexGatewayApiError && error.status === 404) {
        const assistantContent = finalState
          ? getAssistantContentAfterCursor(transcriptCursor, finalState.state.transcript)
          : ''
        await finalizeTurnCompletion({
          taskId,
          sessionId,
          transcriptCursor,
          assistantContent,
          success: false,
          error: 'Codex gateway session is no longer available',
          clearGatewaySession: true,
        })

        await refreshTaskDevboxLease({
          id: taskId,
          runtimeName: task?.runtimeName || null,
          maxDuration: task?.maxDuration || null,
        })
        await logger.error('Codex gateway session not found')
        return
      }

      throw error
    }

    if (!finalState.state.activeTurn && finalState.state.lastTurnStatus) {
      break
    }

    await sleep(1000)
  }

  if (!finalState || finalState.state.activeTurn || !finalState.state.lastTurnStatus) {
    const assistantContent = finalState
      ? getAssistantContentAfterCursor(transcriptCursor, finalState.state.transcript)
      : ''
    await finalizeTurnCompletion({
      taskId,
      sessionId,
      transcriptCursor,
      assistantContent,
      success: false,
      error: 'Codex gateway response timed out',
    })

    await refreshTaskDevboxLease({
      id: taskId,
      runtimeName: task?.runtimeName || null,
      maxDuration: task?.maxDuration || null,
    })
    await logger.error('Codex gateway response timed out')
    return
  }

  const assistantContent = getAssistantContentAfterCursor(transcriptCursor, finalState.state.transcript)

  if (isSuccessfulTurnStatus(finalState.state.lastTurnStatus)) {
    await finalizeTurnCompletion({
      taskId,
      sessionId,
      transcriptCursor,
      assistantContent,
      success: true,
      error: null,
    })

    await refreshTaskDevboxLease({
      id: taskId,
      runtimeName: task?.runtimeName || null,
      maxDuration: task?.maxDuration || null,
    })
    await logger.success('Codex gateway response received')
    return
  }

  await finalizeTurnCompletion({
    taskId,
    sessionId,
    transcriptCursor,
    assistantContent,
    success: false,
    error: 'Codex gateway turn failed',
  })

  await refreshTaskDevboxLease({
    id: taskId,
    runtimeName: task?.runtimeName || null,
    maxDuration: task?.maxDuration || null,
  })
  await logger.error('Codex gateway turn failed')
}
