import { eq } from 'drizzle-orm'
import { FORCED_CODEX_MODEL } from '@/lib/codex/defaults'
import { CodexGatewayApiError, getCodexGatewaySessionState, sendCodexGatewayTurn } from '@/lib/codex-gateway/client'
import { finalizeTurnCompletion, markTurnCompletionRunning, recordTurnCheckpoint } from '@/lib/codex-gateway/completion'
import { ensureCodexGatewaySession } from '@/lib/codex-gateway/session'
import type { CodexGatewayState, CodexGatewaySessionResponse } from '@/lib/codex-gateway/types'
import { getTaskGatewayContextById } from '@/lib/codex-gateway/task'
import { getAssistantContentAfterCursor } from '@/lib/codex-gateway/transcript'
import { db } from '@/lib/db/client'
import { taskMessages, tasks } from '@/lib/db/schema'
import { refreshTaskDevboxLease } from '@/lib/devbox/runtime'
import { prependSealosDeployContext } from '@/lib/sealos-deploy-context'
import { generateId } from '@/lib/utils/id'
import { createTaskLogger } from '@/lib/utils/task-logger'
import { formatKeyTaskLogMessage, TASK_FLOW_LOGS } from '@/lib/utils/task-flow-logs'

interface StartCodexGatewayTurnOptions {
  appendUserMessage?: boolean
  model?: string | null
  runtimeNamespace?: string | null
}

export interface StartedCodexGatewayTurn {
  gatewayAuthToken: string | null
  gatewayUrl: string
  sessionId: string
  startedAt: Date
  taskId: string
  threadId: string | null
  transcriptCursor: number
  turnId: string | null
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
  return status === 'completed' || status === 'succeeded' || status === 'interrupted'
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

function isFirstSessionTurn(state: CodexGatewayState | null | undefined): boolean {
  return !state?.transcript?.some((entry) => entry.role === 'user' || entry.role === 'assistant')
}

function buildGatewayPrompt(
  prompt: string,
  state: CodexGatewayState | null | undefined,
  runtimeNamespace?: string | null,
): string {
  if (!isFirstSessionTurn(state)) {
    return prompt
  }

  return prependSealosDeployContext(prompt, runtimeNamespace)
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
  let gatewayThreadId: string | null | undefined = null
  let gatewayState: CodexGatewayState | null = null
  let turnResponse: CodexGatewaySessionResponse

  if (!gatewaySessionId) {
    const ensuredSession = await ensureCodexGatewaySession({
      task,
      gatewayUrl,
      gatewayAuthToken,
      logger,
    })

    gatewaySessionId = ensuredSession.sessionId
    gatewayThreadId = ensuredSession.state.threadId
    gatewayState = ensuredSession.state
  } else {
    try {
      const existingSession = await getCodexGatewaySessionState(gatewayUrl, gatewaySessionId, gatewayAuthToken)
      gatewayThreadId = existingSession.state.threadId
      gatewayState = existingSession.state
    } catch (error) {
      if (!(error instanceof CodexGatewayApiError && error.status === 404)) {
        throw error
      }
    }
  }

  let gatewayPrompt = buildGatewayPrompt(prompt, gatewayState, options.runtimeNamespace)

  const turnSendingLog = formatKeyTaskLogMessage(TASK_FLOW_LOGS.GATEWAY_TURN_SENDING, {
    promptChars: gatewayPrompt.length,
    sessionId: gatewaySessionId,
    threadId: gatewayThreadId,
  })
  await logger.info(turnSendingLog)
  console.info(turnSendingLog)
  try {
    turnResponse = await sendCodexGatewayTurn(gatewayUrl, gatewaySessionId, { prompt: gatewayPrompt }, gatewayAuthToken)
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
    gatewayThreadId = refreshedSession.state.threadId
    gatewayState = refreshedSession.state
    gatewayPrompt = buildGatewayPrompt(prompt, gatewayState, options.runtimeNamespace)
    const retryTurnSendingLog = formatKeyTaskLogMessage(TASK_FLOW_LOGS.GATEWAY_TURN_SENDING, {
      mode: 'recreated',
      promptChars: gatewayPrompt.length,
      sessionId: gatewaySessionId,
      threadId: gatewayThreadId,
    })
    await logger.info(retryTurnSendingLog)
    console.info(retryTurnSendingLog)
    turnResponse = await sendCodexGatewayTurn(gatewayUrl, gatewaySessionId, { prompt: gatewayPrompt }, gatewayAuthToken)
  }

  const startedAt = new Date()
  const transcriptCursor = getTurnTranscriptCursor(turnResponse.state.transcript)
  const threadId = turnResponse.state.threadId || gatewayThreadId || null
  const turnId = turnResponse.state.currentTurnId || null
  const turnWaitingLog = formatKeyTaskLogMessage(TASK_FLOW_LOGS.GATEWAY_TURN_WAITING, {
    sessionId: gatewaySessionId,
    threadId,
    transcriptCursor,
  })
  await logger.info(turnWaitingLog)
  console.info(turnWaitingLog)

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
    threadId,
    transcriptCursor,
    startedAt,
    turnId,
  })

  return {
    taskId,
    sessionId: gatewaySessionId,
    startedAt,
    threadId,
    transcriptCursor,
    turnId,
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
          turnStatus: finalState?.state.lastTurnStatus || null,
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
      turnStatus: finalState?.state.lastTurnStatus || null,
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
      turnStatus: finalState.state.lastTurnStatus,
    })

    await refreshTaskDevboxLease({
      id: taskId,
      runtimeName: task?.runtimeName || null,
      maxDuration: task?.maxDuration || null,
    })
    const turnCompletedLog = formatKeyTaskLogMessage(TASK_FLOW_LOGS.GATEWAY_TURN_COMPLETED, {
      sessionId,
      threadId: finalState.state.threadId,
      transcriptCursor,
      turnStatus: finalState.state.lastTurnStatus,
    })
    await logger.success(turnCompletedLog)
    console.info(turnCompletedLog)
    return
  }

  await finalizeTurnCompletion({
    taskId,
    sessionId,
    transcriptCursor,
    assistantContent,
    success: false,
    error: 'Codex gateway turn failed',
    turnStatus: finalState.state.lastTurnStatus,
  })

  await refreshTaskDevboxLease({
    id: taskId,
    runtimeName: task?.runtimeName || null,
    maxDuration: task?.maxDuration || null,
  })
  await logger.error('Codex gateway turn failed')
}
