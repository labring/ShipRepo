import { and, eq, isNull } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { tasks } from '@/lib/db/schema'
import { getCodexGatewayAuthToken, resolveCodexGatewayUrl } from '@/lib/codex-gateway/config'

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
