import { and, eq, isNull } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { CodexGatewayApiError, interruptCodexGatewayTurn } from '@/lib/codex-gateway/client'
import { hasActiveTurnCheckpoint, reconcileIncompleteTurnSafely } from '@/lib/codex-gateway/completion'
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
    if (!gatewayUrl) {
      return NextResponse.json({ error: 'Gateway URL is not configured' }, { status: 400 })
    }

    const result = await interruptCodexGatewayTurn(gatewayUrl, task.activeTurnSessionId, gatewayAuthToken)
    await reconcileIncompleteTurnSafely(taskId, 2_500).catch(() => {
      console.error('Failed to reconcile interrupted chat turn')
    })

    return NextResponse.json({
      success: true,
      data: {
        sessionId: result.sessionId,
        state: result.state,
      },
    })
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
