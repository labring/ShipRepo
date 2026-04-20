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

    if (!task.keepAlive) {
      return NextResponse.json({ error: 'Keep-alive is not enabled for this task' }, { status: 400 })
    }

    const preview = await startTaskPreview(task)

    return NextResponse.json({
      success: true,
      message: 'Sandbox started successfully',
      sandboxId: null,
      sandboxUrl: preview.previewUrl,
    })
  } catch (error) {
    console.error('Error starting sandbox:', error)
    return NextResponse.json({ error: 'Failed to start sandbox' }, { status: 500 })
  }
}
