import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { taskEvents, taskMessages, type TaskEvent } from '@/lib/db/schema'
import { generateId } from '@/lib/utils/id'

const PROJECTABLE_EVENT_KINDS = ['user_message.created', 'assistant.message.projected'] as const

function parseTranscriptCursor(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }

  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10)
    return Number.isFinite(parsed) ? parsed : null
  }

  return null
}

export function buildTaskEventUserMessageId(eventId: string): string {
  return `task-user-event-${eventId}`
}

export function buildProjectedAssistantMessageId(sessionId: string, transcriptCursor: number): string {
  return `codex-agent-${sessionId}-${transcriptCursor}`
}

export async function projectUserMessageFromEvent(
  event: Pick<TaskEvent, 'id' | 'taskId' | 'payload' | 'createdAt'>,
): Promise<void> {
  const content = typeof event.payload?.content === 'string' ? event.payload.content.trim() : ''

  if (!content) {
    return
  }

  await db
    .insert(taskMessages)
    .values({
      id: buildTaskEventUserMessageId(event.id),
      taskId: event.taskId,
      role: 'user',
      content,
      createdAt: event.createdAt,
    })
    .onConflictDoNothing()
}

export async function projectAssistantMessage(input: {
  content: string
  createdAt?: Date
  messageId?: string
  taskId: string
}): Promise<void> {
  const trimmedContent = input.content.trim()

  if (!trimmedContent) {
    return
  }

  if (input.messageId) {
    await db
      .insert(taskMessages)
      .values({
        id: input.messageId,
        taskId: input.taskId,
        role: 'agent',
        content: trimmedContent,
        createdAt: input.createdAt,
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
    .where(and(eq(taskMessages.taskId, input.taskId), eq(taskMessages.role, 'agent')))
    .orderBy(desc(taskMessages.createdAt))
    .limit(1)

  if (latestPersistedAgentMessage?.content.trim() === trimmedContent) {
    return
  }

  await db.insert(taskMessages).values({
    id: generateId(12),
    taskId: input.taskId,
    role: 'agent',
    content: trimmedContent,
    createdAt: input.createdAt,
  })
}

export async function reconcileProjectedTaskMessages(taskId: string): Promise<void> {
  const events = await db
    .select()
    .from(taskEvents)
    .where(and(eq(taskEvents.taskId, taskId), inArray(taskEvents.kind, [...PROJECTABLE_EVENT_KINDS])))
    .orderBy(asc(taskEvents.seq))

  for (const event of events) {
    if (event.kind === 'user_message.created') {
      await projectUserMessageFromEvent(event)
      continue
    }

    const projectedSnapshot = {
      content: typeof event.payload?.content === 'string' ? event.payload.content.trim() : '',
      messageId:
        (typeof event.payload?.sessionId === 'string' ? event.payload.sessionId : event.sessionId) &&
        parseTranscriptCursor(event.payload?.transcriptCursor) !== null
          ? buildProjectedAssistantMessageId(
              (typeof event.payload?.sessionId === 'string' ? event.payload.sessionId : event.sessionId)!,
              parseTranscriptCursor(event.payload?.transcriptCursor)!,
            )
          : undefined,
    }

    if (!projectedSnapshot?.content.trim()) {
      continue
    }

    await projectAssistantMessage({
      taskId,
      content: projectedSnapshot.content,
      messageId: projectedSnapshot.messageId,
      createdAt: event.createdAt,
    })
  }
}
