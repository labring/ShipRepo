import { and, eq, isNull } from 'drizzle-orm'
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db/client'
import { tasks } from '@/lib/db/schema'
import { listTaskEvents } from '@/lib/task-events'
import { getServerSession } from '@/lib/session/get-server-session'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

interface RouteParams {
  params: Promise<{
    taskId: string
  }>
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const session = await getServerSession()
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { taskId } = await params
    const [task] = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.userId, session.user.id), isNull(tasks.deletedAt)))
      .limit(1)

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 })
    }

    const limitParam = Number.parseInt(request.nextUrl.searchParams.get('limit') || '', 10)
    const events = await listTaskEvents(taskId, {
      limit: Number.isFinite(limitParam) ? limitParam : 200,
    })

    return NextResponse.json({
      success: true,
      events,
    })
  } catch (error) {
    console.error('Failed to fetch task events:', error)
    return NextResponse.json({ error: 'Failed to fetch task events' }, { status: 500 })
  }
}
