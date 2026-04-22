import { NextRequest, NextResponse } from 'next/server'
import { and, asc, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { CodexGatewayApiError } from '@/lib/codex-gateway/client'
import { startTaskChatV2Turn } from '@/lib/codex-gateway/chat-v2-service'
import {
  hasActiveTurnCheckpoint,
  reconcileIncompleteTurnSafely,
  shouldAttemptTurnReconciliation,
} from '@/lib/codex-gateway/completion'
import { db } from '@/lib/db/client'
import { taskMessages, tasks } from '@/lib/db/schema'
import { reconcileProjectedTaskMessages } from '@/lib/task-event-projection'
import {
  closeTaskChatV2StreamDescriptor,
  ensureTaskChatV2StreamDescriptor,
  getActiveTaskChatV2StreamDescriptor,
} from '@/lib/task-chat-v2'
import { listTaskEvents } from '@/lib/task-events'
import { getServerSession } from '@/lib/session/get-server-session'
import { checkRateLimit } from '@/lib/utils/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const turnSchema = z.object({
  clientMessageId: z.string().trim().min(1).optional(),
  prompt: z.string().trim().min(1, 'Prompt is required'),
})

interface RouteParams {
  params: Promise<{
    taskId: string
  }>
}

async function getOwnedTask(taskId: string, userId: string) {
  const [task] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.userId, userId), isNull(tasks.deletedAt)))
    .limit(1)

  return task || null
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const session = await getServerSession()
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { taskId } = await params
    let task = await getOwnedTask(taskId, session.user.id)

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 })
    }

    if (
      task.selectedAgent === 'codex' &&
      hasActiveTurnCheckpoint(task) &&
      shouldAttemptTurnReconciliation(task, 5_000)
    ) {
      try {
        task = (await reconcileIncompleteTurnSafely(task.id, 2_500)) || task
      } catch {
        console.error('Failed to reconcile incomplete Codex turn')
      }
    }

    await reconcileProjectedTaskMessages(taskId)

    const refreshedTask = (await getOwnedTask(taskId, session.user.id)) || task
    const messages = await db
      .select()
      .from(taskMessages)
      .where(eq(taskMessages.taskId, taskId))
      .orderBy(asc(taskMessages.createdAt))

    let stream = await getActiveTaskChatV2StreamDescriptor(taskId)

    if (
      refreshedTask.selectedAgent === 'codex' &&
      hasActiveTurnCheckpoint(refreshedTask) &&
      refreshedTask.activeTurnSessionId
    ) {
      stream = await ensureTaskChatV2StreamDescriptor({
        taskId,
        sessionId: refreshedTask.activeTurnSessionId,
        threadId: null,
        turnId: null,
        startedAt: refreshedTask.activeTurnStartedAt || undefined,
      })
    } else if (stream) {
      await closeTaskChatV2StreamDescriptor(taskId)
      stream = null
    }

    const events = await listTaskEvents(taskId, { limit: 200 })

    return NextResponse.json({
      success: true,
      data: {
        task: refreshedTask,
        messages,
        events,
        stream,
      },
    })
  } catch (error) {
    console.error('Failed to fetch chat v2 state:', error)
    return NextResponse.json({ error: 'Failed to fetch chat state' }, { status: 500 })
  }
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

    const task = await getOwnedTask(resolvedTaskId, session.user.id)
    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 })
    }

    if (task.selectedAgent !== 'codex') {
      return NextResponse.json({ error: 'Unsupported agent' }, { status: 400 })
    }

    const result = await startTaskChatV2Turn({
      task,
      clientMessageId: parsed.data.clientMessageId,
      prompt: parsed.data.prompt,
      source: 'chat-v2',
    })

    return NextResponse.json({
      success: true,
      data: {
        session: {
          sessionId: result.startedTurn.sessionId,
          threadId: result.startedTurn.threadId,
          turnId: result.startedTurn.turnId,
        },
        stream: result.stream,
        turn: {
          transcriptCursor: result.startedTurn.transcriptCursor,
          turnAccepted: true,
          turnStartedAt: result.startedTurn.startedAt.toISOString(),
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
        console.error('Failed to mark chat v2 turn as errored')
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

    console.error('Failed to start chat v2 turn:', error)
    return NextResponse.json({ error: 'Failed to start chat turn' }, { status: 500 })
  }
}
