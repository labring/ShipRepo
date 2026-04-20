import { NextRequest, NextResponse } from 'next/server'
import { getOwnedTask, execInTaskWorkspace } from '@/lib/devbox/task-compat'
import { getServerSession } from '@/lib/session/get-server-session'

export async function POST(request: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  try {
    const session = await getServerSession()
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { taskId } = await params
    const { command } = await request.json()

    if (!command || typeof command !== 'string') {
      return NextResponse.json({ success: false, error: 'Command is required' }, { status: 400 })
    }

    const task = await getOwnedTask(taskId, session.user.id)
    if (!task) {
      return NextResponse.json({ success: false, error: 'Task not found' }, { status: 404 })
    }

    const { result } = await execInTaskWorkspace(task, command, { timeoutSeconds: 120 })

    return NextResponse.json({
      success: true,
      data: {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      },
    })
  } catch (error) {
    console.error('Error in terminal endpoint:', error)
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
  }
}
