import { and, desc, eq } from 'drizzle-orm'
import { CodexGatewayApiError, getCodexGatewaySessionState } from '@/lib/codex-gateway/client'
import { getAssistantContentAfterCursor, type TranscriptTextEntry } from '@/lib/codex-gateway/transcript'
import { getTaskGatewayContextById } from '@/lib/codex-gateway/task'
import { db } from '@/lib/db/client'
import { taskEvents, tasks, type Task } from '@/lib/db/schema'
import { projectAssistantMessage } from '@/lib/task-event-projection'
import { buildProjectedAssistantMessageId } from '@/lib/task-message-ids'
import { appendProjectedAssistantMessageEvent, recordTaskEvent } from '@/lib/task-events'
import { OperationTimeoutError, withTimeout } from '@/lib/utils/async'

export const TURN_COMPLETION_STATES = ['pending', 'running', 'completed', 'failed'] as const

export type TurnCompletionState = (typeof TURN_COMPLETION_STATES)[number]

interface TurnCheckpointInput {
  sessionId: string
  startedAt: Date
  taskId: string
  threadId?: string | null
  transcriptCursor: number
  turnId?: string | null
}

interface FinalizeTurnInput {
  assistantContent: string
  clearGatewaySession?: boolean
  error: string | null
  sessionId: string
  success: boolean
  taskId: string
  transcriptCursor: number
  turnStatus?: string | null
}

interface FinalizeActiveTurnFailureInput {
  clearGatewaySession?: boolean
  error: string
  sessionId?: string | null
  taskId: string
}

function parseTranscriptEntries(value: unknown): TranscriptTextEntry[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') {
      return []
    }

    const role = 'role' in entry && typeof entry.role === 'string' ? entry.role : null
    const text = 'text' in entry && typeof entry.text === 'string' ? entry.text : null

    if (!role || text === null) {
      return []
    }

    return [{ role, text }]
  })
}

async function getPersistedAssistantContentForTurn(
  taskId: string,
  sessionId: string,
  transcriptCursor: number,
): Promise<string> {
  const [latestSnapshotEvent] = await db
    .select({ payload: taskEvents.payload })
    .from(taskEvents)
    .where(
      and(
        eq(taskEvents.taskId, taskId),
        eq(taskEvents.kind, 'gateway.state.snapshot'),
        eq(taskEvents.sessionId, sessionId),
      ),
    )
    .orderBy(desc(taskEvents.seq))
    .limit(1)

  const transcript = parseTranscriptEntries(latestSnapshotEvent?.payload?.transcript)

  if (!transcript.length) {
    return ''
  }

  return getAssistantContentAfterCursor(transcriptCursor, transcript)
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

export function shouldAttemptTurnReconciliation(task: Task | null | undefined, minIntervalMs = 10_000): boolean {
  if (!hasActiveTurnCheckpoint(task)) {
    return false
  }

  if (!task?.turnCompletionCheckedAt) {
    return true
  }

  return Date.now() - new Date(task.turnCompletionCheckedAt).getTime() >= minIntervalMs
}

export function buildCodexAssistantMessageId(sessionId: string, transcriptCursor: number): string {
  return buildProjectedAssistantMessageId(sessionId, transcriptCursor)
}

export async function persistAssistantMessage(
  taskId: string,
  content: string,
  options?: {
    messageId?: string
  },
): Promise<void> {
  await projectAssistantMessage({
    taskId,
    content,
    messageId: options?.messageId,
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

  await recordTaskEvent({
    taskId: input.taskId,
    kind: 'turn.started',
    createdAt: input.startedAt,
    sessionId: input.sessionId,
    threadId: input.threadId,
    turnId: input.turnId,
    payload: {
      transcriptCursor: input.transcriptCursor,
      startedAt: input.startedAt.toISOString(),
    },
  })
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
  const interrupted = input.turnStatus === 'interrupted'

  if (input.assistantContent.trim()) {
    await appendProjectedAssistantMessageEvent({
      taskId: input.taskId,
      sessionId: input.sessionId,
      transcriptCursor: input.transcriptCursor,
      content: input.assistantContent,
    })
  }

  await recordTaskEvent({
    taskId: input.taskId,
    kind: interrupted ? 'turn.interrupted' : input.success ? 'turn.completed' : 'turn.failed',
    sessionId: input.sessionId,
    payload: {
      transcriptCursor: input.transcriptCursor,
      content: input.assistantContent.trim() || null,
      error: input.error,
      success: input.success,
      turnStatus: input.turnStatus || null,
    },
  })

  const updates = {
    activeTurnSessionId: null,
    activeTurnStartedAt: null,
    activeTurnTranscriptCursor: null,
    turnCompletionState: input.success ? ('completed' as const) : ('failed' as const),
    turnCompletionCheckedAt: new Date(),
    status: interrupted || input.success ? ('completed' as const) : ('error' as const),
    progress: interrupted || input.success ? 100 : 0,
    error: interrupted || input.success ? null : input.error,
    updatedAt: new Date(),
    ...(input.clearGatewaySession ? { gatewaySessionId: null } : {}),
  }

  const [updatedTask] = await db.update(tasks).set(updates).where(eq(tasks.id, input.taskId)).returning()

  return updatedTask || null
}

export async function finalizeActiveTurnFailure(input: FinalizeActiveTurnFailureInput): Promise<Task | null> {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, input.taskId)).limit(1)

  if (!task || !hasActiveTurnCheckpoint(task) || !task.activeTurnSessionId || task.status === 'stopped') {
    return task || null
  }

  if (input.sessionId && task.activeTurnSessionId !== input.sessionId) {
    return task
  }

  const assistantContent = await getPersistedAssistantContentForTurn(
    input.taskId,
    task.activeTurnSessionId,
    task.activeTurnTranscriptCursor!,
  )

  return await finalizeTurnCompletion({
    taskId: input.taskId,
    sessionId: task.activeTurnSessionId,
    transcriptCursor: task.activeTurnTranscriptCursor!,
    assistantContent,
    success: false,
    error: input.error,
    clearGatewaySession: input.clearGatewaySession ?? task.gatewaySessionId === task.activeTurnSessionId,
  })
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
      success:
        sessionState.state.lastTurnStatus === 'completed' ||
        sessionState.state.lastTurnStatus === 'succeeded' ||
        sessionState.state.lastTurnStatus === 'interrupted',
      error:
        sessionState.state.lastTurnStatus === 'completed' ||
        sessionState.state.lastTurnStatus === 'succeeded' ||
        sessionState.state.lastTurnStatus === 'interrupted'
          ? null
          : 'Codex gateway turn failed',
      turnStatus: sessionState.state.lastTurnStatus,
    })
  } catch (error) {
    if (error instanceof CodexGatewayApiError && error.status === 404) {
      const assistantContent = await getPersistedAssistantContentForTurn(
        taskId,
        task.activeTurnSessionId,
        task.activeTurnTranscriptCursor!,
      )

      return await finalizeTurnCompletion({
        taskId,
        sessionId: task.activeTurnSessionId,
        transcriptCursor: task.activeTurnTranscriptCursor!,
        assistantContent,
        success: false,
        error: 'Codex gateway session is no longer available',
        clearGatewaySession: true,
      })
    }

    throw error
  }
}

export async function reconcileIncompleteTurnSafely(taskId: string, timeoutMs = 3_000): Promise<Task | null> {
  try {
    return await withTimeout(reconcileIncompleteTurn(taskId), timeoutMs, 'Codex turn reconcile timed out')
  } catch (error) {
    if (error instanceof OperationTimeoutError) {
      return null
    }

    throw error
  }
}
