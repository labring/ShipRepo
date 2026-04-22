import { eq } from 'drizzle-orm'
import { startCodexGatewayTaskTurn, waitForCodexGatewayTurnCompletion } from '@/lib/codex-gateway/runner'
import { db } from '@/lib/db/client'
import { tasks, type Task } from '@/lib/db/schema'
import { ensureTaskDevboxRuntime } from '@/lib/devbox/runtime'
import { ensureTaskChatV2StreamDescriptor, type TaskChatV2StreamDescriptor } from '@/lib/task-chat-v2'
import { appendUserMessageEvent, recordTaskEvent } from '@/lib/task-events'
import { createTaskLogger } from '@/lib/utils/task-logger'
import { formatKeyTaskLogMessage, TASK_FLOW_LOGS } from '@/lib/utils/task-flow-logs'

export interface StartTaskChatV2TurnResult {
  source: string
  startedTurn: Awaited<ReturnType<typeof startCodexGatewayTaskTurn>>
  stream: TaskChatV2StreamDescriptor
}

export async function startTaskChatV2Turn(input: {
  clientMessageId?: string
  prompt: string
  source: string
  task: Task
}): Promise<StartTaskChatV2TurnResult> {
  const logger = createTaskLogger(input.task.id)
  const userInputReceivedLog = formatKeyTaskLogMessage(TASK_FLOW_LOGS.USER_INPUT_RECEIVED, {
    promptChars: input.prompt.length,
    source: input.source,
    selectedModel: input.task.selectedModel || undefined,
  })
  await logger.info(userInputReceivedLog)
  console.info(userInputReceivedLog)

  await appendUserMessageEvent({
    taskId: input.task.id,
    clientMessageId: input.clientMessageId,
    content: input.prompt,
    source: input.source,
  })

  const userInputSavedLog = formatKeyTaskLogMessage(TASK_FLOW_LOGS.USER_INPUT_SAVED, {
    promptChars: input.prompt.length,
    source: input.source,
  })
  await logger.info(userInputSavedLog)
  console.info(userInputSavedLog)

  await db
    .update(tasks)
    .set({
      status: 'processing',
      progress: 0,
      error: null,
      completedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, input.task.id))

  const runtime = await ensureTaskDevboxRuntime(input.task, { logger })

  const startedTurn = await startCodexGatewayTaskTurn(input.task.id, input.prompt, {
    appendUserMessage: false,
    model: input.task.selectedModel,
    runtimeNamespace: runtime.namespace || input.task.runtimeNamespace,
  })

  await recordTaskEvent({
    taskId: input.task.id,
    kind: 'gateway.session.opened',
    createdAt: startedTurn.startedAt,
    sessionId: startedTurn.sessionId,
    threadId: startedTurn.threadId,
    turnId: startedTurn.turnId,
    payload: {
      sessionId: startedTurn.sessionId,
      threadId: startedTurn.threadId,
      turnId: startedTurn.turnId,
    },
  })

  const stream = await ensureTaskChatV2StreamDescriptor({
    taskId: input.task.id,
    sessionId: startedTurn.sessionId,
    threadId: startedTurn.threadId,
    turnId: startedTurn.turnId,
    startedAt: startedTurn.startedAt,
  })

  return {
    source: input.source,
    startedTurn,
    stream,
  }
}

export async function finalizeTaskChatV2Turn(
  startedTurn: Awaited<ReturnType<typeof startCodexGatewayTaskTurn>>,
): Promise<void> {
  await waitForCodexGatewayTurnCompletion(startedTurn)
}
