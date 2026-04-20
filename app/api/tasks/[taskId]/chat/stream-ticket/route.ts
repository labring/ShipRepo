import { and, eq, isNull } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { getPreferredCodexSessionId } from '@/lib/codex-gateway/completion'
import { createTaskChatStreamDescriptor } from '@/lib/codex-gateway/stream-ticket'
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

    const sessionId = getPreferredCodexSessionId(task)

    if (!sessionId) {
      return NextResponse.json({ error: 'Task does not have an active gateway session' }, { status: 400 })
    }

    const stream = await createTaskChatStreamDescriptor({
      taskId,
      userId: session.user.id,
      sessionId,
    })

    return NextResponse.json({
      success: true,
      data: {
        sessionId,
        ...stream,
      },
    })
  } catch {
    console.error('Failed to create chat stream ticket')
    return NextResponse.json({ error: 'Failed to create chat stream ticket' }, { status: 500 })
  }
}
