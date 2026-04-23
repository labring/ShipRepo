import { and, eq, isNull } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { CodexGatewayApiError, interruptCodexGatewayTurn } from '@/lib/codex-gateway/client'
import {
  finalizeActiveTurnInterrupted,
  hasActiveTurnCheckpoint,
  reconcileIncompleteTurnSafely,
} from '@/lib/codex-gateway/completion'
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

    if (!hasActiveTurnCheckpoint(task) || !task.activeTurnSessionId) {
      return NextResponse.json({ error: 'Task does not have an active turn' }, { status: 409 })
    }

    const { gatewayUrl, gatewayAuthToken } = await getTaskGatewayContext(taskId, session.user.id)

    const finalizeInterruptedLocally = async () => {
      await finalizeActiveTurnInterrupted({
        taskId,
        sessionId: task.activeTurnSessionId,
        clearGatewaySession: true,
      })
    }

    if (!gatewayUrl) {
      await finalizeInterruptedLocally()
      return NextResponse.json({
        success: true,
        data: {
          sessionId: task.activeTurnSessionId,
          state: null,
        },
      })
    }

    try {
      const result = await interruptCodexGatewayTurn(gatewayUrl, task.activeTurnSessionId, gatewayAuthToken)
      const reconciledTask = await reconcileIncompleteTurnSafely(taskId, 2_500).catch(() => {
        console.error('Failed to reconcile interrupted chat turn')
        return null
      })

      if (reconciledTask && hasActiveTurnCheckpoint(reconciledTask)) {
        await finalizeInterruptedLocally()
      } else if (!reconciledTask) {
        await finalizeInterruptedLocally()
      }

      return NextResponse.json({
        success: true,
        data: {
          sessionId: result.sessionId,
          state: result.state,
        },
      })
    } catch {
      await finalizeInterruptedLocally()
      return NextResponse.json({
        success: true,
        data: {
          sessionId: task.activeTurnSessionId,
          state: null,
        },
      })
    }
  } catch (error) {
    if (error instanceof CodexGatewayApiError) {
      return NextResponse.json(
        {
          error: 'Failed to interrupt active turn',
          statusCode: error.status,
          message: error.message,
        },
        { status: error.status >= 400 && error.status < 500 ? error.status : 502 },
      )
    }

    console.error('Failed to interrupt chat turn:', error)
    return NextResponse.json({ error: 'Failed to interrupt active turn' }, { status: 500 })
  }
}
