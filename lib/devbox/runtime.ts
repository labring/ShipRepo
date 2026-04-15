import { eq } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { Task, tasks } from '@/lib/db/schema'
import { getUserApiKeys, resolveCodexGatewayFromApiKeys, type GatewayConfig } from '@/lib/api-keys/user-keys'
import { resolveCodexGatewayUrl } from '@/lib/codex-gateway/config'
import { createDevbox, DevboxApiError, getDevbox, listDevboxes } from '@/lib/devbox/client'
import { getDevboxArchiveAfterPauseTime, getDevboxDefaultImage, getDevboxNamespace } from '@/lib/devbox/config'
import { createTaskDevboxName } from '@/lib/devbox/naming'
import type { DevboxInfo, DevboxSshInfo } from '@/lib/devbox/types'
import { getUserGitHubToken } from '@/lib/github/user-token'
import type { TaskLogger } from '@/lib/utils/task-logger'

export interface TaskRuntimeSummary {
  provider: 'devbox'
  name: string
  namespace: string | null
  gatewayUrl: string | null
  state: string | null
  creationTimestamp: string | null
  deletionTimestamp: string | null
  ssh: {
    user: string
    host: string
    port: number
    target?: string
    link?: string
    command?: string
  } | null
}

interface EnsureTaskDevboxRuntimeOptions {
  githubToken?: string | null
  gatewayConfig?: GatewayConfig | null
  logger?: TaskLogger
}

function getPauseAt(maxDurationMinutes: number | null): string {
  const durationMinutes = maxDurationMinutes || 300
  return new Date(Date.now() + durationMinutes * 60 * 1000).toISOString()
}

function sanitizeSshInfo(ssh?: DevboxSshInfo) {
  if (!ssh) {
    return null
  }

  return {
    user: ssh.user,
    host: ssh.host,
    port: ssh.port,
    target: ssh.target,
    link: ssh.link,
    command: ssh.command,
  }
}

function buildTaskRuntimeSummary(
  runtimeName: string,
  runtimeNamespace: string | null,
  gatewayUrl?: string | null,
  info?: DevboxInfo,
): TaskRuntimeSummary {
  return {
    provider: 'devbox',
    name: runtimeName,
    namespace: runtimeNamespace,
    gatewayUrl: gatewayUrl || null,
    state: info?.state.phase || null,
    creationTimestamp: info?.creationTimestamp || null,
    deletionTimestamp: info?.deletionTimestamp || null,
    ssh: sanitizeSshInfo(info?.ssh),
  }
}

async function clearMissingTaskRuntime(taskId: string) {
  await db
    .update(tasks)
    .set({
      runtimeProvider: null,
      runtimeName: null,
      runtimeNamespace: null,
      runtimeState: null,
      gatewayUrl: null,
      gatewaySessionId: null,
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, taskId))
}

export async function ensureTaskDevboxRuntime(
  task: Task,
  options: EnsureTaskDevboxRuntimeOptions = {},
): Promise<TaskRuntimeSummary> {
  const logger = options.logger

  if (task.runtimeName) {
    try {
      const existingRuntime = await getDevbox(task.runtimeName)
      const runtimeNamespace = task.runtimeNamespace || getDevboxNamespace()
      const gatewayUrl = resolveCodexGatewayUrl(task.runtimeName, task.gatewayUrl, existingRuntime.data)

      await db
        .update(tasks)
        .set({
          runtimeProvider: 'devbox',
          runtimeName: task.runtimeName,
          runtimeNamespace,
          runtimeState: existingRuntime.data.state.phase,
          gatewayUrl,
          updatedAt: new Date(),
        })
        .where(eq(tasks.id, task.id))

      const runtimeSummary = buildTaskRuntimeSummary(
        task.runtimeName,
        runtimeNamespace,
        gatewayUrl,
        existingRuntime.data,
      )

      console.info('Devbox runtime info:', runtimeSummary)

      return runtimeSummary
    } catch (error) {
      if (!(error instanceof DevboxApiError && error.status === 404)) {
        throw error
      }

      await clearMissingTaskRuntime(task.id)
    }
  }

  const existingDevboxes = await listDevboxes(task.id)
  const existingDevbox = existingDevboxes.data.items[0]

  if (existingDevbox) {
    const runtimeNamespace = getDevboxNamespace()
    const gatewayUrl = resolveCodexGatewayUrl(existingDevbox.name, task.gatewayUrl)

    await db
      .update(tasks)
      .set({
        runtimeProvider: 'devbox',
        runtimeName: existingDevbox.name,
        runtimeNamespace,
        runtimeState: existingDevbox.state.phase,
        gatewayUrl,
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, task.id))

    await logger?.success('Linked existing Devbox runtime')

    const runtimeSummary: TaskRuntimeSummary = {
      provider: 'devbox',
      name: existingDevbox.name,
      namespace: runtimeNamespace,
      gatewayUrl,
      state: existingDevbox.state.phase,
      creationTimestamp: existingDevbox.creationTimestamp,
      deletionTimestamp: existingDevbox.deletionTimestamp,
      ssh: null,
    }

    console.info('Devbox runtime info:', runtimeSummary)

    return runtimeSummary
  }

  const githubToken = options.githubToken ?? (await getUserGitHubToken())
  const gatewayConfig =
    options.gatewayConfig === undefined ? resolveCodexGatewayFromApiKeys(await getUserApiKeys()) : options.gatewayConfig

  const runtimeName = createTaskDevboxName(task.id)
  const runtimeEnv: Record<string, string> = {
    TASK_ID: task.id,
    CODEX_GATEWAY_HOST: '0.0.0.0',
    CODEX_GATEWAY_PORT: '1317',
  }

  if (task.repoUrl) {
    runtimeEnv.REPO_URL = task.repoUrl
  }

  if (githubToken) {
    runtimeEnv.GITHUB_TOKEN = githubToken
  }

  if (gatewayConfig) {
    runtimeEnv.CODEX_GATEWAY_OPENAI_BASE_URL = gatewayConfig.baseUrl
    runtimeEnv.CODEX_GATEWAY_OPENAI_API_KEY = gatewayConfig.apiKey
  }

  if (process.env.CODEX_GATEWAY_JWT_SECRET) {
    runtimeEnv.CODEX_GATEWAY_JWT_SECRET = process.env.CODEX_GATEWAY_JWT_SECRET
  }

  await logger?.info('Creating Devbox runtime')

  const createResponse = await createDevbox({
    name: runtimeName,
    image: getDevboxDefaultImage(),
    upstreamID: task.id,
    kubeAccess: {
      enabled: true,
      roleTemplate: 'edit',
    },
    env: runtimeEnv,
    pauseAt: getPauseAt(task.maxDuration),
    archiveAfterPauseTime: getDevboxArchiveAfterPauseTime(),
    labels: [
      { key: 'app.kubernetes.io/component', value: 'runtime' },
      { key: 'app.kubernetes.io/managed-by', value: 'coding-agent-template' },
    ],
  })

  const infoResponse = await getDevbox(runtimeName)
  const gatewayUrl = resolveCodexGatewayUrl(runtimeName, task.gatewayUrl, infoResponse.data)

  await db
    .update(tasks)
    .set({
      runtimeProvider: 'devbox',
      runtimeName,
      runtimeNamespace: createResponse.data.namespace,
      runtimeState: infoResponse.data.state.phase,
      gatewayUrl,
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, task.id))

  await logger?.success('Devbox runtime created')

  const runtimeSummary = buildTaskRuntimeSummary(
    runtimeName,
    createResponse.data.namespace,
    gatewayUrl,
    infoResponse.data,
  )

  console.info('Devbox runtime info:', runtimeSummary)

  return runtimeSummary
}
