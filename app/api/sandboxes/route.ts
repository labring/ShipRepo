import { NextResponse } from 'next/server'
import { db } from '@/lib/db/client'
import { tasks } from '@/lib/db/schema'
import { eq, and, isNotNull, or } from 'drizzle-orm'
import { resolveCodexGatewayUrl } from '@/lib/codex-gateway/config'
import { DevboxApiError, getDevbox } from '@/lib/devbox/client'
import { getDevboxNamespace } from '@/lib/devbox/config'
import { getServerSession } from '@/lib/session/get-server-session'

export async function GET() {
  try {
    const session = await getServerSession()
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const taskRuntimes = await db
      .select({
        id: tasks.id,
        taskId: tasks.id,
        prompt: tasks.prompt,
        repoUrl: tasks.repoUrl,
        branchName: tasks.branchName,
        runtimeProvider: tasks.runtimeProvider,
        runtimeName: tasks.runtimeName,
        runtimeNamespace: tasks.runtimeNamespace,
        runtimeState: tasks.runtimeState,
        gatewayUrl: tasks.gatewayUrl,
        sandboxId: tasks.sandboxId,
        sandboxUrl: tasks.sandboxUrl,
        createdAt: tasks.createdAt,
        status: tasks.status,
        keepAlive: tasks.keepAlive,
        maxDuration: tasks.maxDuration,
      })
      .from(tasks)
      .where(and(eq(tasks.userId, session.user.id), or(isNotNull(tasks.sandboxId), isNotNull(tasks.runtimeName))))
      .orderBy(tasks.createdAt)

    const refreshedTaskRuntimes = await Promise.all(
      taskRuntimes.map(async (taskRuntime) => {
        if (!taskRuntime.runtimeName) {
          return taskRuntime
        }

        try {
          const response = await getDevbox(taskRuntime.runtimeName)
          const runtimeNamespace = taskRuntime.runtimeNamespace || getDevboxNamespace()
          const runtimeState = response.data.state.phase
          const gatewayUrl = resolveCodexGatewayUrl(taskRuntime.runtimeName, taskRuntime.gatewayUrl, response.data)

          await db
            .update(tasks)
            .set({
              runtimeNamespace,
              runtimeState,
              gatewayUrl,
              updatedAt: new Date(),
            })
            .where(eq(tasks.id, taskRuntime.taskId))

          return {
            ...taskRuntime,
            runtimeNamespace,
            runtimeState,
            gatewayUrl,
          }
        } catch (error) {
          if (!(error instanceof DevboxApiError && error.status === 404)) {
            return taskRuntime
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
            .where(eq(tasks.id, taskRuntime.taskId))

          if (!taskRuntime.sandboxId) {
            return null
          }

          return {
            ...taskRuntime,
            runtimeProvider: null,
            runtimeName: null,
            runtimeNamespace: null,
            runtimeState: null,
            gatewayUrl: null,
          }
        }
      }),
    )

    const runningSandboxes = refreshedTaskRuntimes
      .filter((taskRuntime): taskRuntime is NonNullable<typeof taskRuntime> => taskRuntime !== null)
      .map((taskRuntime) => ({
        ...taskRuntime,
        provider: taskRuntime.runtimeName ? taskRuntime.runtimeProvider || 'devbox' : 'sandbox',
      }))

    return NextResponse.json({
      sandboxes: runningSandboxes,
    })
  } catch (error) {
    console.error('Error fetching sandboxes')
    return NextResponse.json({ error: 'Failed to fetch sandboxes' }, { status: 500 })
  }
}
