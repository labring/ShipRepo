import { after, NextRequest, NextResponse } from 'next/server'
import { and, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { CodexGatewayApiError } from '@/lib/codex-gateway/client'
import { startCodexGatewayTaskTurn, waitForCodexGatewayTurnCompletion } from '@/lib/codex-gateway/runner'
import { createTaskChatStreamDescriptor } from '@/lib/codex-gateway/stream-ticket'
import { db } from '@/lib/db/client'
import { tasks } from '@/lib/db/schema'
import { ensureTaskDevboxRuntime } from '@/lib/devbox/runtime'
import { getServerSession } from '@/lib/session/get-server-session'
import { appendTaskMessage } from '@/lib/task-messages'
import { checkRateLimit } from '@/lib/utils/rate-limit'
import { createTaskLogger } from '@/lib/utils/task-logger'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const turnSchema = z
  .object({
    prompt: z.string().trim().min(1).optional(),
    message: z.string().trim().min(1).optional(),
  })
  .refine((value) => Boolean(value.prompt || value.message), {
    message: 'Prompt is required',
  })

interface RouteParams {
  params: Promise<{
    taskId: string
  }>
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  let taskId: string | null = null

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

    ;({ taskId } = await params)
    const resolvedTaskId = taskId

    const body = await request.json().catch(() => ({}))
    const parsed = turnSchema.safeParse(body)

    if (!parsed.success) {
      return NextResponse.json({ error: 'Prompt is required' }, { status: 400 })
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

    const prompt = parsed.data.prompt || parsed.data.message || ''
    const logger = createTaskLogger(taskId)
    let userMessagePersisted = false

    try {
      await appendTaskMessage({
        taskId: resolvedTaskId,
        role: 'user',
        content: prompt,
      })
      userMessagePersisted = true
    } catch {
      console.error('Failed to persist chat turn user message')
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
      .where(eq(tasks.id, resolvedTaskId))

    await ensureTaskDevboxRuntime(task, { logger })

    const startedTurn = await startCodexGatewayTaskTurn(resolvedTaskId, prompt, {
      appendUserMessage: !userMessagePersisted,
      model: task.selectedModel,
    })
    const stream = await createTaskChatStreamDescriptor({
      taskId: resolvedTaskId,
      userId: session.user.id,
      sessionId: startedTurn.sessionId,
    })

    after(async () => {
      try {
        await waitForCodexGatewayTurnCompletion(startedTurn)
      } catch (error) {
        console.error('Failed to finalize chat turn:', error)

        await db
          .update(tasks)
          .set({
            status: 'error',
            error: 'Failed to finalize chat turn',
            updatedAt: new Date(),
          })
          .where(eq(tasks.id, resolvedTaskId))

        await logger.error('Failed to finalize chat turn')
      }
    })

    return NextResponse.json({
      success: true,
      data: {
        session: {
          sessionId: startedTurn.sessionId,
        },
        stream,
        turn: {
          transcriptCursor: startedTurn.transcriptCursor,
          turnAccepted: true,
          turnStartedAt: startedTurn.startedAt.toISOString(),
          streamUrl: stream.streamUrl,
        },
      },
    })
  } catch (error) {
    if (taskId) {
      try {
        await db
          .update(tasks)
          .set({
            status: 'error',
            error: 'Failed to start chat turn',
            updatedAt: new Date(),
          })
          .where(eq(tasks.id, taskId))
      } catch {
        console.error('Failed to mark chat turn as errored')
      }
    }

    if (error instanceof CodexGatewayApiError) {
      return NextResponse.json(
        {
          error: 'Failed to start chat turn',
          statusCode: error.status,
          message: error.message,
        },
        { status: error.status >= 400 && error.status < 500 ? error.status : 502 },
      )
    }

    console.error('Failed to start chat turn:', error)
    return NextResponse.json({ error: 'Failed to start chat turn' }, { status: 500 })
  }
}
