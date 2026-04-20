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

  await input.logger?.info('Checking Codex gateway readiness')
  await waitForCodexGatewayReady(input.gatewayUrl)

  await input.logger?.info('Creating Codex gateway session')
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

  return created
}
