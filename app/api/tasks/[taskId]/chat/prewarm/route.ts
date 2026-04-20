import { and, eq, isNull } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { CodexGatewayApiError, getCodexGatewaySessionState } from '@/lib/codex-gateway/client'
import {
  getPreferredCodexSessionId,
  hasActiveTurnCheckpoint,
  reconcileIncompleteTurn,
} from '@/lib/codex-gateway/completion'
import { ensureCodexGatewaySession } from '@/lib/codex-gateway/session'
import { createTaskChatStreamDescriptor } from '@/lib/codex-gateway/stream-ticket'
import { getTaskGatewayContext } from '@/lib/codex-gateway/task'
import { db } from '@/lib/db/client'
import { tasks } from '@/lib/db/schema'
import { ensureTaskDevboxRuntime } from '@/lib/devbox/runtime'
import { getServerSession } from '@/lib/session/get-server-session'
import { createTaskLogger } from '@/lib/utils/task-logger'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

interface RouteParams {
  params: Promise<{
    taskId: string
  }>
}

export async function POST(_request: Request, { params }: RouteParams) {
  try {
    const session = await getServerSession()
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { taskId } = await params
    const [task] = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.userId, session.user.id), isNull(tasks.deletedAt)))
      .limit(1)

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 })
    }

    if (task.selectedAgent !== 'codex') {
      return NextResponse.json({ error: 'Unsupported agent' }, { status: 400 })
    }

    const logger = createTaskLogger(taskId)
    await ensureTaskDevboxRuntime(task, { logger })

    const gatewayContext = await getTaskGatewayContext(taskId, session.user.id)
    if (!gatewayContext.task || !gatewayContext.gatewayUrl) {
      return NextResponse.json({ error: 'Gateway URL is not configured' }, { status: 400 })
    }

    let runtimeTask = gatewayContext.task
    let sessionState = null
    const preferredSessionId = getPreferredCodexSessionId(runtimeTask)

    if (hasActiveTurnCheckpoint(runtimeTask) && preferredSessionId) {
      try {
        sessionState = await getCodexGatewaySessionState(
          gatewayContext.gatewayUrl,
          preferredSessionId,
          gatewayContext.gatewayAuthToken,
        )
      } catch (error) {
        if (!(error instanceof CodexGatewayApiError && error.status === 404)) {
          throw error
        }

        runtimeTask = (await reconcileIncompleteTurn(taskId)) || runtimeTask
      }
    }

    if (!sessionState && hasActiveTurnCheckpoint(runtimeTask)) {
      const [currentTask] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1)
      runtimeTask = currentTask || runtimeTask

      return NextResponse.json({
        success: true,
        data: {
          gatewayUrl: gatewayContext.gatewayUrl,
          runtime: {
            status: runtimeTask.status,
            runtimeName: runtimeTask.runtimeName,
            runtimeState: runtimeTask.runtimeState,
            workspacePreparedAt: runtimeTask.workspacePreparedAt,
            runtimeCheckedAt: runtimeTask.runtimeCheckedAt,
            gatewayReadyAt: runtimeTask.gatewayReadyAt,
            gatewaySessionId: runtimeTask.gatewaySessionId,
            turnCompletionState: runtimeTask.turnCompletionState,
          },
          session: null,
          stream: null,
        },
      })
    }

    if (!sessionState) {
      sessionState = await ensureCodexGatewaySession({
        task: runtimeTask,
        gatewayUrl: gatewayContext.gatewayUrl,
        gatewayAuthToken: gatewayContext.gatewayAuthToken,
        logger,
      })
    }

    const [currentTask] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1)
    runtimeTask = currentTask || runtimeTask
    const stream = await createTaskChatStreamDescriptor({
      taskId,
      userId: session.user.id,
      sessionId: sessionState.sessionId,
    })

    return NextResponse.json({
      success: true,
      data: {
        gatewayUrl: gatewayContext.gatewayUrl,
        runtime: {
          status: runtimeTask.status,
          runtimeName: runtimeTask.runtimeName,
          runtimeState: runtimeTask.runtimeState,
          workspacePreparedAt: runtimeTask.workspacePreparedAt,
          runtimeCheckedAt: runtimeTask.runtimeCheckedAt,
          gatewayReadyAt: runtimeTask.gatewayReadyAt,
          gatewaySessionId: runtimeTask.gatewaySessionId,
          turnCompletionState: runtimeTask.turnCompletionState,
        },
        session: sessionState,
        stream,
      },
    })
  } catch {
    console.error('Failed to prewarm chat runtime')
    return NextResponse.json({ error: 'Failed to prewarm chat runtime' }, { status: 500 })
  }
}
