import { NextRequest, NextResponse } from 'next/server'
import { startTaskPreview } from '@/lib/devbox/preview'
import { getOwnedTask } from '@/lib/devbox/task-compat'
import { getServerSession } from '@/lib/session/get-server-session'

export async function POST(_request: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
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

    await startTaskPreview(task)

    return NextResponse.json({
      success: true,
      message: 'Dev server restarted successfully',
    })
  } catch (error) {
    console.error('Error restarting dev server:', error)
    return NextResponse.json({ error: 'Failed to restart dev server' }, { status: 500 })
  }
}
