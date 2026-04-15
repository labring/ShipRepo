import { and, eq, isNull } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { tasks } from '@/lib/db/schema'
import { getCodexGatewayAuthToken, resolveCodexGatewayUrl } from '@/lib/codex-gateway/config'

export async function getTaskById(taskId: string) {
  const [task] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), isNull(tasks.deletedAt)))
    .limit(1)

  return task
}

export async function getOwnedTask(taskId: string, userId: string) {
  const [task] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.userId, userId), isNull(tasks.deletedAt)))
    .limit(1)

  return task
}

export async function getTaskGatewayContext(taskId: string, userId: string) {
  const task = await getOwnedTask(taskId, userId)

  if (!task) {
    return { task: null, gatewayUrl: null, gatewayAuthToken: null }
  }

  const gatewayUrl = resolveCodexGatewayUrl(task.runtimeName, task.gatewayUrl)
  const gatewayAuthToken = await getCodexGatewayAuthToken()

  return {
    task,
    gatewayUrl,
    gatewayAuthToken,
  }
}

export async function getTaskGatewayContextById(taskId: string) {
  const task = await getTaskById(taskId)

  if (!task) {
    return { task: null, gatewayUrl: null, gatewayAuthToken: null }
  }

  const gatewayUrl = resolveCodexGatewayUrl(task.runtimeName, task.gatewayUrl)
  const gatewayAuthToken = await getCodexGatewayAuthToken()

  return {
    task,
    gatewayUrl,
    gatewayAuthToken,
  }
}

export function normalizeCodexGatewayModel(model: string | null | undefined): string | undefined {
  const trimmedModel = model?.trim()

  if (!trimmedModel) {
    return undefined
  }

  if (!trimmedModel.includes('/')) {
    return trimmedModel
  }

  const segments = trimmedModel.split('/').filter(Boolean)
  return segments.at(-1) || trimmedModel
}

export function shouldUseCodexGatewayTask(task: {
  gatewayUrl?: string | null
  runtimeName?: string | null
  selectedAgent?: string | null
}): boolean {
  if (task.selectedAgent !== 'codex') {
    return false
  }

  return Boolean(resolveCodexGatewayUrl(task.runtimeName, task.gatewayUrl))
}
