import { eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { CodexGatewayApiError, getCodexGatewaySessionState } from '@/lib/codex-gateway/client'
import {
  getPreferredCodexSessionId,
  hasActiveTurnCheckpoint,
  reconcileIncompleteTurn,
} from '@/lib/codex-gateway/completion'
import { createTaskChatStreamDescriptor } from '@/lib/codex-gateway/stream-ticket'
import { getTaskGatewayContext } from '@/lib/codex-gateway/task'
import { db } from '@/lib/db/client'
import { tasks } from '@/lib/db/schema'
import { getServerSession } from '@/lib/session/get-server-session'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

interface RouteParams {
  params: Promise<{
    taskId: string
  }>
}

export async function GET(_request: Request, { params }: RouteParams) {
  try {
    const session = await getServerSession()
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { taskId } = await params

    let { task } = await getTaskGatewayContext(taskId, session.user.id)

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 })
    }

    if (task.selectedAgent === 'codex' && hasActiveTurnCheckpoint(task)) {
      try {
        task = (await reconcileIncompleteTurn(task.id)) || task
      } catch {
        console.error('Failed to reconcile incomplete Codex turn')
      }
    }

    const gatewayContext = await getTaskGatewayContext(taskId, session.user.id)
    const currentTask = gatewayContext.task || task

    if (!currentTask) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 })
    }

    let sessionState = null
    let runtimeTask = currentTask
    const preferredSessionId = getPreferredCodexSessionId(currentTask)

    if (preferredSessionId && gatewayContext.gatewayUrl) {
      try {
        sessionState = await getCodexGatewaySessionState(
          gatewayContext.gatewayUrl,
          preferredSessionId,
          gatewayContext.gatewayAuthToken,
        )
      } catch (error) {
        if (error instanceof CodexGatewayApiError && error.status === 404) {
          if (preferredSessionId === currentTask.gatewaySessionId) {
            await db
              .update(tasks)
              .set({
                gatewaySessionId: null,
                updatedAt: new Date(),
              })
              .where(eq(tasks.id, taskId))

            runtimeTask = {
              ...currentTask,
              gatewaySessionId: null,
            }
          } else if (preferredSessionId === currentTask.activeTurnSessionId) {
            try {
              runtimeTask = (await reconcileIncompleteTurn(taskId)) || currentTask
            } catch {
              console.error('Failed to reconcile missing active Codex turn')
            }
          }
        } else {
          throw error
        }
      }
    }

    const stream = sessionState
      ? await createTaskChatStreamDescriptor({
          taskId,
          userId: session.user.id,
          sessionId: sessionState.sessionId,
        })
      : null

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
  } catch (error) {
    console.error('Failed to fetch chat runtime:', error)
    return NextResponse.json({ error: 'Failed to fetch chat runtime' }, { status: 500 })
  }
}
