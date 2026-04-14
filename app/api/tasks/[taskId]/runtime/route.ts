import { NextResponse } from 'next/server'
import { and, eq, isNull } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { tasks } from '@/lib/db/schema'
import { DevboxApiError, createDevbox, deleteDevbox, getDevbox, listDevboxes } from '@/lib/devbox/client'
import { getDevboxArchiveAfterPauseTime, getDevboxDefaultImage, getDevboxNamespace } from '@/lib/devbox/config'
import { createTaskDevboxName } from '@/lib/devbox/naming'
import type { DevboxInfo, DevboxSshInfo } from '@/lib/devbox/types'
import { getUserApiKeys, resolveCodexGatewayFromApiKeys } from '@/lib/api-keys/user-keys'
import { resolveCodexGatewayUrl } from '@/lib/codex-gateway/config'
import { getUserGitHubToken } from '@/lib/github/user-token'
import { getServerSession } from '@/lib/session/get-server-session'
import { createTaskLogger } from '@/lib/utils/task-logger'

interface RouteParams {
  params: Promise<{
    taskId: string
  }>
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

function buildRuntimeResponse(
  runtimeName: string,
  runtimeNamespace: string | null,
  gatewayUrl?: string | null,
  info?: DevboxInfo,
) {
  return {
    provider: 'devbox',
    name: runtimeName,
    namespace: runtimeNamespace,
    gatewayUrl: gatewayUrl || null,
    state: info?.state || null,
    creationTimestamp: info?.creationTimestamp || null,
    deletionTimestamp: info?.deletionTimestamp || null,
    ssh: sanitizeSshInfo(info?.ssh),
  }
}

async function getOwnedTask(taskId: string, userId: string) {
  const [task] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.userId, userId), isNull(tasks.deletedAt)))
    .limit(1)

  return task
}

export async function GET(_request: Request, { params }: RouteParams) {
  try {
    const session = await getServerSession()
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { taskId } = await params
    const task = await getOwnedTask(taskId, session.user.id)

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 })
    }

    if (!task.runtimeName) {
      return NextResponse.json({
        success: true,
        data: {
          runtime: null,
        },
      })
    }

    try {
      const runtimeNamespace = task.runtimeNamespace || getDevboxNamespace()
      const gatewayUrl = resolveCodexGatewayUrl(task.runtimeName, task.gatewayUrl)
      const response = await getDevbox(task.runtimeName)

      await db
        .update(tasks)
        .set({
          runtimeState: response.data.state.phase,
          runtimeNamespace,
          gatewayUrl,
          updatedAt: new Date(),
        })
        .where(eq(tasks.id, taskId))

      return NextResponse.json({
        success: true,
        data: {
          runtime: buildRuntimeResponse(task.runtimeName, runtimeNamespace, gatewayUrl, response.data),
        },
      })
    } catch (error) {
      if (error instanceof DevboxApiError && error.status === 404) {
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

        return NextResponse.json({
          success: true,
          data: {
            runtime: null,
          },
        })
      }

      throw error
    }
  } catch (error) {
    console.error('Failed to fetch task runtime:', error)
    return NextResponse.json({ error: 'Failed to fetch task runtime' }, { status: 500 })
  }
}

export async function POST(_request: Request, { params }: RouteParams) {
  try {
    const session = await getServerSession()
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { taskId } = await params
    const task = await getOwnedTask(taskId, session.user.id)

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 })
    }

    const logger = createTaskLogger(taskId)

    if (task.runtimeName) {
      try {
        const existingRuntime = await getDevbox(task.runtimeName)
        const runtimeNamespace = task.runtimeNamespace || getDevboxNamespace()
        const gatewayUrl = resolveCodexGatewayUrl(task.runtimeName, task.gatewayUrl)

        await db
          .update(tasks)
          .set({
            gatewayUrl,
            updatedAt: new Date(),
          })
          .where(eq(tasks.id, taskId))

        return NextResponse.json({
          success: true,
          data: {
            runtime: buildRuntimeResponse(task.runtimeName, runtimeNamespace, gatewayUrl, existingRuntime.data),
          },
        })
      } catch (error) {
        if (!(error instanceof DevboxApiError && error.status === 404)) {
          throw error
        }

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
    }

    await logger.info('Creating Devbox runtime')

    const existingDevboxes = await listDevboxes(taskId)
    const existingDevbox = existingDevboxes.data.items[0]

    if (existingDevbox) {
      const gatewayUrl = resolveCodexGatewayUrl(existingDevbox.name, task.gatewayUrl)

      await db
        .update(tasks)
        .set({
          runtimeProvider: 'devbox',
          runtimeName: existingDevbox.name,
          runtimeNamespace: getDevboxNamespace(),
          runtimeState: existingDevbox.state.phase,
          gatewayUrl,
          updatedAt: new Date(),
        })
        .where(eq(tasks.id, taskId))

      await logger.success('Linked existing Devbox runtime')

      return NextResponse.json({
        success: true,
        data: {
          runtime: {
            provider: 'devbox',
            name: existingDevbox.name,
            namespace: getDevboxNamespace(),
            gatewayUrl,
            state: existingDevbox.state,
            creationTimestamp: existingDevbox.creationTimestamp,
            deletionTimestamp: existingDevbox.deletionTimestamp,
            ssh: null,
          },
        },
      })
    }

    const githubToken = await getUserGitHubToken()
    const apiKeys = await getUserApiKeys()
    const gatewayConfig = resolveCodexGatewayFromApiKeys(apiKeys)
    const runtimeName = createTaskDevboxName(task.id)
    const gatewayUrl = resolveCodexGatewayUrl(runtimeName, task.gatewayUrl)

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

    const createResponse = await createDevbox({
      name: runtimeName,
      image: getDevboxDefaultImage(),
      upstreamID: task.id,
      env: runtimeEnv,
      pauseAt: getPauseAt(task.maxDuration),
      archiveAfterPauseTime: getDevboxArchiveAfterPauseTime(),
      labels: [
        { key: 'app.kubernetes.io/component', value: 'runtime' },
        { key: 'app.kubernetes.io/managed-by', value: 'coding-agent-template' },
      ],
    })

    const infoResponse = await getDevbox(runtimeName)

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
      .where(eq(tasks.id, taskId))

    await logger.success('Devbox runtime created')

    return NextResponse.json({
      success: true,
      data: {
        runtime: buildRuntimeResponse(runtimeName, createResponse.data.namespace, gatewayUrl, infoResponse.data),
      },
    })
  } catch (error) {
    if (error instanceof DevboxApiError) {
      return NextResponse.json(
        {
          error: 'Failed to create Devbox runtime',
          statusCode: error.status,
          message: error.message,
        },
        { status: error.status >= 400 && error.status < 500 ? error.status : 502 },
      )
    }

    console.error('Failed to create task runtime:', error)
    return NextResponse.json({ error: 'Failed to create task runtime' }, { status: 500 })
  }
}

export async function DELETE(_request: Request, { params }: RouteParams) {
  try {
    const session = await getServerSession()
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { taskId } = await params
    const task = await getOwnedTask(taskId, session.user.id)

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 })
    }

    if (!task.runtimeName) {
      return NextResponse.json({ error: 'Task does not have an active runtime' }, { status: 400 })
    }

    const logger = createTaskLogger(taskId)
    await logger.info('Deleting Devbox runtime')

    try {
      await deleteDevbox(task.runtimeName)
    } catch (error) {
      if (!(error instanceof DevboxApiError && error.status === 404)) {
        throw error
      }
    }

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

    await logger.success('Devbox runtime deleted')

    return NextResponse.json({
      success: true,
    })
  } catch (error) {
    if (error instanceof DevboxApiError) {
      return NextResponse.json(
        {
          error: 'Failed to delete Devbox runtime',
          statusCode: error.status,
          message: error.message,
        },
        { status: error.status >= 400 && error.status < 500 ? error.status : 502 },
      )
    }

    console.error('Failed to delete task runtime:', error)
    return NextResponse.json({ error: 'Failed to delete task runtime' }, { status: 500 })
  }
}
