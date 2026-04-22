import { and, desc, eq, sql } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import {
  taskEvents,
  taskStreams,
  type TaskEvent,
  type TaskEventKind,
  type TaskStream,
  type TaskStreamStatus,
} from '@/lib/db/schema'
import { projectAssistantMessage, projectUserMessageFromEvent } from '@/lib/task-event-projection'
import { buildProjectedAssistantMessageId } from '@/lib/task-message-ids'
import { generateId } from '@/lib/utils/id'

interface RecordTaskEventInput {
  clientMessageId?: string | null
  createdAt?: Date
  kind: TaskEventKind
  payload?: Record<string, unknown> | null
  sessionId?: string | null
  streamId?: string | null
  taskId: string
  threadId?: string | null
  turnId?: string | null
}

interface CreateTaskStreamInput {
  id?: string
  sessionId: string
  startedAt?: Date
  taskId: string
  threadId?: string | null
  turnId?: string | null
}

export async function recordTaskEvent(input: RecordTaskEventInput): Promise<TaskEvent> {
  return await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${input.taskId}))`)

    if (input.clientMessageId) {
      const [existingEvent] = await tx
        .select()
        .from(taskEvents)
        .where(and(eq(taskEvents.taskId, input.taskId), eq(taskEvents.clientMessageId, input.clientMessageId)))
        .limit(1)

      if (existingEvent) {
        return existingEvent
      }
    }

    const [latestEvent] = await tx
      .select({ seq: taskEvents.seq })
      .from(taskEvents)
      .where(eq(taskEvents.taskId, input.taskId))
      .orderBy(desc(taskEvents.seq))
      .limit(1)

    const eventValues = {
      id: generateId(16),
      taskId: input.taskId,
      seq: (latestEvent?.seq ?? 0) + 1,
      kind: input.kind,
      streamId: input.streamId ?? undefined,
      sessionId: input.sessionId ?? undefined,
      threadId: input.threadId ?? undefined,
      turnId: input.turnId ?? undefined,
      clientMessageId: input.clientMessageId ?? undefined,
      payload: input.payload ?? null,
      createdAt: input.createdAt,
    }

    const [createdEvent] = await tx.insert(taskEvents).values(eventValues).returning()

    return createdEvent
  })
}

export async function appendUserMessageEvent(input: {
  clientMessageId?: string
  content: string
  createdAt?: Date
  source: string
  taskId: string
}): Promise<TaskEvent> {
  const event = await recordTaskEvent({
    taskId: input.taskId,
    kind: 'user_message.created',
    clientMessageId: input.clientMessageId,
    createdAt: input.createdAt,
    payload: {
      clientMessageId: input.clientMessageId,
      content: input.content,
      source: input.source,
    },
  })

  await projectUserMessageFromEvent(event)

  return event
}

export async function appendProjectedAssistantMessageEvent(input: {
  content: string
  createdAt?: Date
  sessionId: string
  taskId: string
  transcriptCursor: number
}): Promise<TaskEvent | null> {
  const trimmedContent = input.content.trim()

  if (!trimmedContent) {
    return null
  }

  const event = await recordTaskEvent({
    taskId: input.taskId,
    kind: 'assistant.message.projected',
    createdAt: input.createdAt,
    sessionId: input.sessionId,
    payload: {
      content: trimmedContent,
      sessionId: input.sessionId,
      transcriptCursor: input.transcriptCursor,
    },
  })

  await projectAssistantMessage({
    taskId: input.taskId,
    content: trimmedContent,
    createdAt: input.createdAt,
    messageId: buildProjectedAssistantMessageId(input.sessionId, input.transcriptCursor),
  })

  return event
}

export async function listTaskEvents(taskId: string, options?: { limit?: number }): Promise<TaskEvent[]> {
  const limit = Math.max(1, Math.min(options?.limit ?? 200, 1000))

  const events = await db
    .select()
    .from(taskEvents)
    .where(eq(taskEvents.taskId, taskId))
    .orderBy(desc(taskEvents.seq))
    .limit(limit)

  return events.toReversed()
}

export async function createTaskStream(input: CreateTaskStreamInput): Promise<TaskStream> {
  const createdAt = input.startedAt ?? new Date()

  await db
    .update(taskStreams)
    .set({
      status: 'closed',
      lastEventAt: createdAt,
      endedAt: createdAt,
    })
    .where(and(eq(taskStreams.taskId, input.taskId), eq(taskStreams.status, 'active')))

  const streamValues = {
    id: input.id ?? generateId(16),
    taskId: input.taskId,
    sessionId: input.sessionId,
    threadId: input.threadId ?? undefined,
    turnId: input.turnId ?? undefined,
    status: 'active' as const,
    startedAt: createdAt,
    lastEventAt: createdAt,
  }

  const [createdStream] = await db.insert(taskStreams).values(streamValues).returning()
  return createdStream
}

export async function getTaskStream(streamId: string): Promise<TaskStream | null> {
  const [stream] = await db.select().from(taskStreams).where(eq(taskStreams.id, streamId)).limit(1)
  return stream || null
}

export async function getActiveTaskStream(taskId: string): Promise<TaskStream | null> {
  const [stream] = await db
    .select()
    .from(taskStreams)
    .where(and(eq(taskStreams.taskId, taskId), eq(taskStreams.status, 'active')))
    .orderBy(desc(taskStreams.startedAt))
    .limit(1)

  return stream || null
}

export async function touchTaskStream(
  streamId: string,
  input?: {
    sessionId?: string | null
    status?: TaskStreamStatus
    threadId?: string | null
    turnId?: string | null
  },
): Promise<TaskStream | null> {
  const [updatedStream] = await db
    .update(taskStreams)
    .set({
      lastEventAt: new Date(),
      ...(typeof input?.sessionId === 'string' ? { sessionId: input.sessionId } : {}),
      ...(input?.threadId !== undefined ? { threadId: input.threadId } : {}),
      ...(input?.turnId !== undefined ? { turnId: input.turnId } : {}),
      ...(input?.status !== undefined ? { status: input.status } : {}),
    })
    .where(eq(taskStreams.id, streamId))
    .returning()

  return updatedStream || null
}

export async function closeTaskStream(
  streamId: string,
  status: Extract<TaskStreamStatus, 'closed' | 'errored'> = 'closed',
): Promise<TaskStream | null> {
  const [updatedStream] = await db
    .update(taskStreams)
    .set({
      status,
      lastEventAt: new Date(),
      endedAt: new Date(),
    })
    .where(eq(taskStreams.id, streamId))
    .returning()

  return updatedStream || null
}
