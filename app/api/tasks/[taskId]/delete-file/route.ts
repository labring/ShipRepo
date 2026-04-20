import { NextRequest, NextResponse } from 'next/server'
import { execInTaskWorkspace, getOwnedTask, toTaskRelativePath } from '@/lib/devbox/task-compat'
import { getServerSession } from '@/lib/session/get-server-session'

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  try {
    const session = await getServerSession()
    if (!session?.user?.id) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
    }

    const { taskId } = await params
    const body = await request.json()
    const { filename } = body

    if (!filename || typeof filename !== 'string') {
      return NextResponse.json({ success: false, error: 'Filename is required' }, { status: 400 })
    }

    const task = await getOwnedTask(taskId, session.user.id)
    if (!task) {
      return NextResponse.json({ success: false, error: 'Task not found' }, { status: 404 })
    }

    const relativeFilename = toTaskRelativePath(filename)
    const { result } = await execInTaskWorkspace(task, `rm -rf ${shellEscape(relativeFilename)}`, {
      timeoutSeconds: 30,
    })

    if (result.exitCode !== 0) {
      return NextResponse.json({ success: false, error: 'Failed to delete file' }, { status: 500 })
    }

    return NextResponse.json({
      success: true,
      message: 'File deleted successfully',
      filename: relativeFilename,
    })
  } catch (error) {
    console.error('Error deleting file:', error)
    return NextResponse.json({ success: false, error: 'An error occurred while deleting the file' }, { status: 500 })
  }
}
