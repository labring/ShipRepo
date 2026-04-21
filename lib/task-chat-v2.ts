import type { TaskStream } from '@/lib/db/schema'
import { closeTaskStream, createTaskStream, getActiveTaskStream } from '@/lib/task-events'

export interface TaskChatV2StreamDescriptor {
  sessionId: string
  streamId: string
  streamUrl: string
  threadId: string | null
  turnId: string | null
}

export function buildTaskChatV2StreamUrl(taskId: string, streamId: string): string {
  return `/api/tasks/${taskId}/chat/v2/stream?streamId=${encodeURIComponent(streamId)}`
}

export function buildTaskChatV2StreamDescriptor(
  taskId: string,
  stream: Pick<TaskStream, 'id' | 'sessionId' | 'threadId' | 'turnId'>,
): TaskChatV2StreamDescriptor {
  return {
    streamId: stream.id,
    streamUrl: buildTaskChatV2StreamUrl(taskId, stream.id),
    sessionId: stream.sessionId,
    threadId: stream.threadId || null,
    turnId: stream.turnId || null,
  }
}

export async function createTaskChatV2StreamDescriptor(input: {
  sessionId: string
  startedAt?: Date
  taskId: string
  threadId?: string | null
  turnId?: string | null
}): Promise<TaskChatV2StreamDescriptor> {
  const stream = await createTaskStream({
    taskId: input.taskId,
    sessionId: input.sessionId,
    startedAt: input.startedAt,
    threadId: input.threadId,
    turnId: input.turnId,
  })

  return buildTaskChatV2StreamDescriptor(input.taskId, stream)
}

export async function getActiveTaskChatV2StreamDescriptor(taskId: string): Promise<TaskChatV2StreamDescriptor | null> {
  const stream = await getActiveTaskStream(taskId)

  if (!stream) {
    return null
  }

  return buildTaskChatV2StreamDescriptor(taskId, stream)
}

export async function ensureTaskChatV2StreamDescriptor(input: {
  sessionId: string
  startedAt?: Date
  taskId: string
  threadId?: string | null
  turnId?: string | null
}): Promise<TaskChatV2StreamDescriptor> {
  const activeStream = await getActiveTaskStream(input.taskId)

  if (activeStream && activeStream.sessionId === input.sessionId) {
    return buildTaskChatV2StreamDescriptor(input.taskId, activeStream)
  }

  return await createTaskChatV2StreamDescriptor(input)
}

export async function closeTaskChatV2StreamDescriptor(
  taskId: string,
  status: 'closed' | 'errored' = 'closed',
): Promise<void> {
  const activeStream = await getActiveTaskStream(taskId)

  if (!activeStream) {
    return
  }

  await closeTaskStream(activeStream.id, status)
}
