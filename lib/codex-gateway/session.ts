import { eq } from 'drizzle-orm'
import { FORCED_CODEX_MODEL } from '@/lib/codex/defaults'
import {
  CodexGatewayApiError,
  createCodexGatewaySession,
  deleteCodexGatewaySession,
  getCodexGatewaySessionState,
  waitForCodexGatewayReady,
} from '@/lib/codex-gateway/client'
import { hasActiveTurnCheckpoint } from '@/lib/codex-gateway/completion'
import { normalizeCodexGatewayModel } from '@/lib/codex-gateway/task'
import type { CodexGatewaySessionResponse } from '@/lib/codex-gateway/types'
import { db } from '@/lib/db/client'
import { tasks, type Task } from '@/lib/db/schema'
import type { TaskLogger } from '@/lib/utils/task-logger'
import { formatKeyTaskLogMessage, TASK_FLOW_LOGS } from '@/lib/utils/task-flow-logs'

interface EnsureCodexGatewaySessionInput {
  gatewayAuthToken: string | null
  gatewayUrl: string
  logger?: TaskLogger
  task: Task
}

async function persistGatewaySessionState(taskId: string, updates: Partial<Task>): Promise<void> {
  await db
    .update(tasks)
    .set({
      ...updates,
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, taskId))
}

function emitGatewaySessionLog(
  logger: TaskLogger | undefined,
  type: 'info' | 'success',
  message: string,
  metadata?: Parameters<typeof formatKeyTaskLogMessage>[1],
) {
  const formattedMessage = formatKeyTaskLogMessage(message, metadata)

  if (type === 'success') {
    void logger?.success(formattedMessage)
  } else {
    void logger?.info(formattedMessage)
  }

  console.info(formattedMessage)
}

export async function ensureCodexGatewaySession(
  input: EnsureCodexGatewaySessionInput,
): Promise<CodexGatewaySessionResponse> {
  const forcedModel = normalizeCodexGatewayModel(FORCED_CODEX_MODEL)

  if (hasActiveTurnCheckpoint(input.task) && input.task.activeTurnSessionId) {
    const activeSession = await getCodexGatewaySessionState(
      input.gatewayUrl,
      input.task.activeTurnSessionId,
      input.gatewayAuthToken,
    )

    await persistGatewaySessionState(input.task.id, {
      gatewayUrl: input.gatewayUrl,
      gatewaySessionId: input.task.activeTurnSessionId,
      gatewayReadyAt: new Date(),
      selectedModel: FORCED_CODEX_MODEL,
    })
    emitGatewaySessionLog(input.logger, 'success', TASK_FLOW_LOGS.GATEWAY_SESSION_READY, {
      mode: 'active',
      selectedModel: FORCED_CODEX_MODEL,
      sessionId: input.task.activeTurnSessionId,
    })

    return activeSession
  }

  if (input.task.gatewaySessionId) {
    try {
      const existing = await getCodexGatewaySessionState(
        input.gatewayUrl,
        input.task.gatewaySessionId,
        input.gatewayAuthToken,
      )
      const existingModel = normalizeCodexGatewayModel(existing.state.selectedModel)

      if (!forcedModel || existingModel === forcedModel) {
        await persistGatewaySessionState(input.task.id, {
          gatewayUrl: input.gatewayUrl,
          gatewayReadyAt: new Date(),
          selectedModel: FORCED_CODEX_MODEL,
        })
        emitGatewaySessionLog(input.logger, 'success', TASK_FLOW_LOGS.GATEWAY_SESSION_READY, {
          mode: 'existing',
          selectedModel: FORCED_CODEX_MODEL,
          sessionId: input.task.gatewaySessionId,
        })

        return existing
      }

      try {
        await deleteCodexGatewaySession(input.gatewayUrl, input.task.gatewaySessionId, input.gatewayAuthToken)
      } catch (error) {
        if (!(error instanceof CodexGatewayApiError && error.status === 404)) {
          throw error
        }
      }

      await persistGatewaySessionState(input.task.id, {
        gatewaySessionId: null,
        selectedModel: FORCED_CODEX_MODEL,
      })
    } catch (error) {
      if (!(error instanceof CodexGatewayApiError && error.status === 404)) {
        throw error
      }

      await persistGatewaySessionState(input.task.id, {
        gatewaySessionId: null,
        selectedModel: FORCED_CODEX_MODEL,
      })
    }
  }

  emitGatewaySessionLog(input.logger, 'info', TASK_FLOW_LOGS.GATEWAY_SESSION_PREPARING, {
    mode: input.task.gatewaySessionId ? 'replace' : 'create',
    selectedModel: FORCED_CODEX_MODEL,
  })
  await waitForCodexGatewayReady(input.gatewayUrl)

  const created = await createCodexGatewaySession(
    input.gatewayUrl,
    forcedModel ? { model: forcedModel } : {},
    input.gatewayAuthToken,
  )

  await persistGatewaySessionState(input.task.id, {
    gatewayUrl: input.gatewayUrl,
    gatewaySessionId: created.sessionId,
    gatewayReadyAt: new Date(),
    selectedModel: FORCED_CODEX_MODEL,
  })
  emitGatewaySessionLog(input.logger, 'success', TASK_FLOW_LOGS.GATEWAY_SESSION_READY, {
    mode: input.task.gatewaySessionId ? 'recreated' : 'created',
    selectedModel: FORCED_CODEX_MODEL,
    sessionId: created.sessionId,
  })

  return created
}
