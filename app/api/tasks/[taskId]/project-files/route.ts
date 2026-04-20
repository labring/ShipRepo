import { NextRequest, NextResponse } from 'next/server'
import { ensureOwnedTaskRuntime, getOwnedTask } from '@/lib/devbox/task-compat'
import { getServerSession } from '@/lib/session/get-server-session'

export async function GET(_request: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  try {
    const session = await getServerSession()
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { taskId } = await params
    const task = await getOwnedTask(taskId, session.user.id)

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 })
    }

    await ensureOwnedTaskRuntime(task)

    return NextResponse.json({
      success: true,
      files: [],
    })
  } catch (error) {
    console.error('Error in project-files API:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
