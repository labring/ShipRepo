import { and, eq, isNull } from 'drizzle-orm'
import { NextRequest, NextResponse } from 'next/server'
import { startTaskChatV2Turn } from '@/lib/codex-gateway/chat-v2-service'
import { db } from '@/lib/db/client'
import { tasks } from '@/lib/db/schema'
import { getServerSession } from '@/lib/session/get-server-session'
import { generateId } from '@/lib/utils/id'
import { checkRateLimit } from '@/lib/utils/rate-limit'

function buildCompatClientMessageId(): string {
  return `continue-compat:${generateId(16)}`
}

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
    const body = (await req.json().catch(() => ({}))) as {
      clientMessageId?: string
      message?: unknown
    }
    const message = typeof body.message === 'string' ? body.message.trim() : ''

    if (!message) {
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

    await startTaskChatV2Turn({
      task,
      clientMessageId:
        typeof body.clientMessageId === 'string' && body.clientMessageId.trim()
          ? body.clientMessageId.trim()
          : buildCompatClientMessageId(),
      prompt: message,
      source: 'continue-compat',
    })

    return NextResponse.json({ success: true })
  } catch {
    console.error('Error continuing task')
    return NextResponse.json({ error: 'Failed to continue task' }, { status: 500 })
  }
}
