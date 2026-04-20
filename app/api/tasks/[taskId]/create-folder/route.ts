import { NextRequest, NextResponse } from 'next/server'
import { execInTaskWorkspace, getOwnedTask, toTaskRelativePath } from '@/lib/devbox/task-compat'
import { getServerSession } from '@/lib/session/get-server-session'

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  try {
    const session = await getServerSession()
    if (!session?.user?.id) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
    }

    const { taskId } = await params
    const body = await request.json()
    const { foldername } = body

    if (!foldername || typeof foldername !== 'string') {
      return NextResponse.json({ success: false, error: 'Foldername is required' }, { status: 400 })
    }

    const task = await getOwnedTask(taskId, session.user.id)
    if (!task) {
      return NextResponse.json({ success: false, error: 'Task not found' }, { status: 404 })
    }

    const relativeFolder = toTaskRelativePath(foldername)
    const { result } = await execInTaskWorkspace(task, `mkdir -p ${shellEscape(relativeFolder)}`, {
      timeoutSeconds: 30,
    })

    if (result.exitCode !== 0) {
      return NextResponse.json({ success: false, error: 'Failed to create folder' }, { status: 500 })
    }

    return NextResponse.json({
      success: true,
      message: 'Folder created successfully',
      foldername: relativeFolder,
    })
  } catch (error) {
    console.error('Error creating folder:', error)
    return NextResponse.json({ success: false, error: 'An error occurred while creating the folder' }, { status: 500 })
  }
}
