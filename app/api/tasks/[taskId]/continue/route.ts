import { NextRequest, NextResponse, after } from 'next/server'
import { and, eq, isNull } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { tasks } from '@/lib/db/schema'
import { startCodexGatewayTaskTurn, waitForCodexGatewayTurnCompletion } from '@/lib/codex-gateway/runner'
import { ensureTaskDevboxRuntime } from '@/lib/devbox/runtime'
import { prependSealosDeployContext } from '@/lib/sealos-deploy-context'
import { checkRateLimit } from '@/lib/utils/rate-limit'
import { createTaskLogger } from '@/lib/utils/task-logger'
import { getServerSession } from '@/lib/session/get-server-session'
import { appendTaskMessage } from '@/lib/task-messages'

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

    const trimmedMessage = message.trim()

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

    let userMessagePersisted = false

    try {
      await appendTaskMessage({
        taskId,
        role: 'user',
        content: trimmedMessage,
      })
      userMessagePersisted = true
    } catch {
      console.error('Failed to persist follow-up user message')
    }

    await db
      .update(tasks)
      .set({
        status: 'processing',
        progress: 0,
        error: null,
        completedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, taskId))

    after(async () => {
      const logger = createTaskLogger(taskId)

      try {
        const runtime = await ensureTaskDevboxRuntime(task, { logger })
        const gatewayPrompt = prependSealosDeployContext(trimmedMessage, runtime.namespace || task.runtimeNamespace)

        const startedTurn = await startCodexGatewayTaskTurn(taskId, gatewayPrompt, {
          appendUserMessage: !userMessagePersisted,
          model: task.selectedModel,
        })

        await waitForCodexGatewayTurnCompletion(startedTurn)
      } catch {
        console.error('Failed to finalize Codex gateway follow-up')

        await db
          .update(tasks)
          .set({
            status: 'error',
            error: 'Failed to finalize Codex gateway follow-up',
            updatedAt: new Date(),
          })
          .where(eq(tasks.id, taskId))

        await logger.error('Failed to finalize Codex gateway follow-up')
      }
    })

    return NextResponse.json({ success: true })
  } catch {
    console.error('Error continuing task')
    return NextResponse.json({ error: 'Failed to continue task' }, { status: 500 })
  }
}
