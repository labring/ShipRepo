import { NextRequest, NextResponse, after } from 'next/server'
import { and, eq, isNull } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { tasks } from '@/lib/db/schema'
import { startCodexGatewayTaskTurn, waitForCodexGatewayTurnCompletion } from '@/lib/codex-gateway/runner'
import { checkRateLimit } from '@/lib/utils/rate-limit'
import { createTaskLogger } from '@/lib/utils/task-logger'
import { getServerSession } from '@/lib/session/get-server-session'

export async function POST(req: NextRequest, context: { params: Promise<{ taskId: string }> }) {
  try {
    const session = await getServerSession()
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const rateLimit = await checkRateLimit(session.user.id)
    if (!rateLimit.allowed) {
      return NextResponse.json(
        {
          error: 'Rate limit exceeded',
          message: `You have reached the daily limit of ${rateLimit.total} messages (tasks + follow-ups). Your limit will reset at ${rateLimit.resetAt.toISOString()}`,
          remaining: rateLimit.remaining,
          total: rateLimit.total,
          resetAt: rateLimit.resetAt.toISOString(),
        },
        { status: 429 },
      )
    }

    const { taskId } = await context.params
    const body = await req.json()
    const { message } = body

    if (!message || typeof message !== 'string' || !message.trim()) {
      return NextResponse.json({ error: 'Message is required' }, { status: 400 })
    }

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

    const startedTurn = await startCodexGatewayTaskTurn(taskId, message.trim(), {
      appendUserMessage: true,
      model: task.selectedModel,
    })

    after(async () => {
      try {
        await waitForCodexGatewayTurnCompletion(startedTurn)
      } catch (error) {
        console.error('Failed to finalize Codex gateway follow-up:', error)

        await db
          .update(tasks)
          .set({
            status: 'error',
            error: 'Failed to finalize Codex gateway follow-up',
            updatedAt: new Date(),
          })
          .where(eq(tasks.id, taskId))

        const logger = createTaskLogger(taskId)
        await logger.error('Failed to finalize Codex gateway follow-up')
      }
    })

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Error continuing task:', error)
    return NextResponse.json({ error: 'Failed to continue task' }, { status: 500 })
  }
}
