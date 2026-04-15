import { eq } from 'drizzle-orm'
import {
  CodexGatewayApiError,
  createCodexGatewaySession,
  getCodexGatewayReady,
  getCodexGatewaySessionState,
  sendCodexGatewayTurn,
} from '@/lib/codex-gateway/client'
import { getTaskGatewayContextById, normalizeCodexGatewayModel } from '@/lib/codex-gateway/task'
import { db } from '@/lib/db/client'
import { taskMessages, tasks } from '@/lib/db/schema'
import { generateId } from '@/lib/utils/id'
import { createTaskLogger } from '@/lib/utils/task-logger'

interface StartCodexGatewayTurnOptions {
  appendUserMessage?: boolean
  model?: string | null
}

export interface StartedCodexGatewayTurn {
  gatewayAuthToken: string | null
  gatewayUrl: string
  sessionId: string
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

function getAssistantContentAfterCursor(
  transcriptCursor: number,
  transcript: { role: string; text: string }[],
): string {
  const assistantMessages = transcript
    .slice(transcriptCursor)
    .filter((entry) => entry.role === 'assistant')
    .map((entry) => entry.text.trim())
    .filter(Boolean)

  return assistantMessages.join('\n\n').trim()
}

function isSuccessfulTurnStatus(status: string | null | undefined): boolean {
  return status === 'completed' || status === 'succeeded'
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

  if (options.appendUserMessage) {
    await db.insert(taskMessages).values({
      id: generateId(12),
      taskId,
      role: 'user',
      content: prompt,
    })
  }

  const normalizedModel = normalizeCodexGatewayModel(options.model ?? task.selectedModel)

  let gatewaySessionId = task.gatewaySessionId
  let transcriptCursor = 0

  if (gatewaySessionId) {
    try {
      const existingState = await getCodexGatewaySessionState(gatewayUrl, gatewaySessionId, gatewayAuthToken)
      transcriptCursor = existingState.state.transcript.length
    } catch (error) {
      if (!(error instanceof CodexGatewayApiError && error.status === 404)) {
        throw error
      }

      gatewaySessionId = null

      await db
        .update(tasks)
        .set({
          gatewaySessionId: null,
          updatedAt: new Date(),
        })
        .where(eq(tasks.id, taskId))
    }
  }

  if (!gatewaySessionId) {
    await logger.info('Checking Codex gateway readiness')
    await getCodexGatewayReady(gatewayUrl)

    await logger.info('Creating Codex gateway session')
    const created = await createCodexGatewaySession(
      gatewayUrl,
      normalizedModel ? { model: normalizedModel } : {},
      gatewayAuthToken,
    )

    gatewaySessionId = created.sessionId
    transcriptCursor = created.state.transcript.length
  }

  await db
    .update(tasks)
    .set({
      gatewaySessionId,
      gatewayUrl,
      status: 'processing',
      progress: 0,
      error: null,
      completedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, taskId))

  await logger.info('Forwarding prompt to Codex gateway')
  await sendCodexGatewayTurn(gatewayUrl, gatewaySessionId, { prompt }, gatewayAuthToken)
  await logger.info('Waiting for Codex gateway response')

  return {
    taskId,
    sessionId: gatewaySessionId,
    transcriptCursor,
    gatewayUrl,
    gatewayAuthToken,
  }
}

export async function waitForCodexGatewayTurnCompletion(startedTurn: StartedCodexGatewayTurn): Promise<void> {
  const logger = createTaskLogger(startedTurn.taskId)
  const { taskId, sessionId, transcriptCursor, gatewayUrl, gatewayAuthToken } = startedTurn

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
        await db
          .update(tasks)
          .set({
            status: 'error',
            error: 'Codex gateway session is no longer available',
            gatewaySessionId: null,
            updatedAt: new Date(),
          })
          .where(eq(tasks.id, taskId))

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
    await db
      .update(tasks)
      .set({
        status: 'error',
        error: 'Codex gateway response timed out',
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, taskId))

    await logger.error('Codex gateway response timed out')
    return
  }

  const assistantContent = getAssistantContentAfterCursor(transcriptCursor, finalState.state.transcript)

  if (assistantContent) {
    await db.insert(taskMessages).values({
      id: generateId(12),
      taskId,
      role: 'agent',
      content: assistantContent,
    })
  }

  if (isSuccessfulTurnStatus(finalState.state.lastTurnStatus)) {
    await db
      .update(tasks)
      .set({
        status: 'completed',
        progress: 100,
        error: null,
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, taskId))

    await logger.success('Codex gateway response received')
    return
  }

  await db
    .update(tasks)
    .set({
      status: 'error',
      error: 'Codex gateway turn failed',
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, taskId))

  await logger.error('Codex gateway turn failed')
}
