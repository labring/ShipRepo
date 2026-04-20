import { and, desc, eq } from 'drizzle-orm'
import { CodexGatewayApiError, getCodexGatewaySessionState } from '@/lib/codex-gateway/client'
import { getAssistantContentAfterCursor } from '@/lib/codex-gateway/transcript'
import { getTaskGatewayContextById } from '@/lib/codex-gateway/task'
import { db } from '@/lib/db/client'
import { taskMessages, tasks, type Task } from '@/lib/db/schema'
import { generateId } from '@/lib/utils/id'

export const TURN_COMPLETION_STATES = ['pending', 'running', 'completed', 'failed'] as const

export type TurnCompletionState = (typeof TURN_COMPLETION_STATES)[number]

interface TurnCheckpointInput {
  sessionId: string
  startedAt: Date
  taskId: string
  transcriptCursor: number
}

interface FinalizeTurnInput {
  assistantContent: string
  clearGatewaySession?: boolean
  error: string | null
  sessionId: string
  success: boolean
  taskId: string
  transcriptCursor: number
}

export function hasActiveTurnCheckpoint(task: Task | null | undefined): boolean {
  return (
    Boolean(task?.activeTurnSessionId) &&
    typeof task?.activeTurnTranscriptCursor === 'number' &&
    task.activeTurnTranscriptCursor >= 0 &&
    task?.turnCompletionState !== 'completed' &&
    task?.turnCompletionState !== 'failed'
  )
}

export function getPreferredCodexSessionId(task: Task | null | undefined): string | null {
  if (hasActiveTurnCheckpoint(task) && task?.activeTurnSessionId) {
    return task.activeTurnSessionId
  }

  return task?.gatewaySessionId || null
}

export function buildCodexAssistantMessageId(sessionId: string, transcriptCursor: number): string {
  return `codex-agent-${sessionId}-${transcriptCursor}`
}

export async function persistAssistantMessage(
  taskId: string,
  content: string,
  options?: {
    messageId?: string
  },
): Promise<void> {
  const trimmedContent = content.trim()
  if (!trimmedContent) {
    return
  }

  if (options?.messageId) {
    await db
      .insert(taskMessages)
      .values({
        id: options.messageId,
        taskId,
        role: 'agent',
        content: trimmedContent,
      })
      .onConflictDoUpdate({
        target: taskMessages.id,
        set: {
          content: trimmedContent,
        },
      })

    return
  }

  const [latestPersistedAgentMessage] = await db
    .select({ content: taskMessages.content })
    .from(taskMessages)
    .where(and(eq(taskMessages.taskId, taskId), eq(taskMessages.role, 'agent')))
    .orderBy(desc(taskMessages.createdAt))
    .limit(1)

  if (latestPersistedAgentMessage?.content.trim() === trimmedContent) {
    return
  }

  await db.insert(taskMessages).values({
    id: generateId(12),
    taskId,
    role: 'agent',
    content: trimmedContent,
  })
}

export async function recordTurnCheckpoint(input: TurnCheckpointInput): Promise<void> {
  await db
    .update(tasks)
    .set({
      activeTurnSessionId: input.sessionId,
      activeTurnStartedAt: input.startedAt,
      activeTurnTranscriptCursor: input.transcriptCursor,
      turnCompletionState: 'pending',
      turnCompletionCheckedAt: input.startedAt,
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, input.taskId))
}

export async function markTurnCompletionRunning(taskId: string): Promise<void> {
  await db
    .update(tasks)
    .set({
      turnCompletionState: 'running',
      turnCompletionCheckedAt: new Date(),
    })
    .where(eq(tasks.id, taskId))
}

export async function finalizeTurnCompletion(input: FinalizeTurnInput): Promise<Task | null> {
  await persistAssistantMessage(input.taskId, input.assistantContent, {
    messageId: buildCodexAssistantMessageId(input.sessionId, input.transcriptCursor),
  })

  const updates = {
    activeTurnSessionId: null,
    activeTurnStartedAt: null,
    activeTurnTranscriptCursor: null,
    turnCompletionState: input.success ? ('completed' as const) : ('failed' as const),
    turnCompletionCheckedAt: new Date(),
    status: input.success ? ('completed' as const) : ('error' as const),
    progress: input.success ? 100 : 0,
    error: input.success ? null : input.error,
    updatedAt: new Date(),
    ...(input.clearGatewaySession ? { gatewaySessionId: null } : {}),
  }

  const [updatedTask] = await db.update(tasks).set(updates).where(eq(tasks.id, input.taskId)).returning()

  return updatedTask || null
}

export async function reconcileIncompleteTurn(taskId: string): Promise<Task | null> {
  const { task, gatewayUrl, gatewayAuthToken } = await getTaskGatewayContextById(taskId)

  if (!task || !hasActiveTurnCheckpoint(task) || !task.activeTurnSessionId) {
    return task
  }

  if (task.status === 'stopped') {
    return task
  }

  if (!gatewayUrl) {
    return task
  }

  try {
    const sessionState = await getCodexGatewaySessionState(gatewayUrl, task.activeTurnSessionId, gatewayAuthToken)

    if (sessionState.state.activeTurn || !sessionState.state.lastTurnStatus) {
      await markTurnCompletionRunning(taskId)
      const [latestTask] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1)
      return latestTask || task
    }

    const assistantContent = getAssistantContentAfterCursor(
      task.activeTurnTranscriptCursor!,
      sessionState.state.transcript,
    )

    return await finalizeTurnCompletion({
      taskId,
      sessionId: task.activeTurnSessionId,
      transcriptCursor: task.activeTurnTranscriptCursor!,
      assistantContent,
      success: sessionState.state.lastTurnStatus === 'completed' || sessionState.state.lastTurnStatus === 'succeeded',
      error:
        sessionState.state.lastTurnStatus === 'completed' || sessionState.state.lastTurnStatus === 'succeeded'
          ? null
          : 'Codex gateway turn failed',
    })
  } catch (error) {
    if (error instanceof CodexGatewayApiError && error.status === 404) {
      return await finalizeTurnCompletion({
        taskId,
        sessionId: task.activeTurnSessionId,
        transcriptCursor: task.activeTurnTranscriptCursor!,
        assistantContent: '',
        success: false,
        error: 'Codex gateway session is no longer available',
        clearGatewaySession: true,
      })
    }

    throw error
  }
}
