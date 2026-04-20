import path from 'node:path'
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
    const { filename } = body

    if (!filename || typeof filename !== 'string') {
      return NextResponse.json({ success: false, error: 'Filename is required' }, { status: 400 })
    }

    const task = await getOwnedTask(taskId, session.user.id)
    if (!task) {
      return NextResponse.json({ success: false, error: 'Task not found' }, { status: 404 })
    }

    const relativeFilename = toTaskRelativePath(filename)
    const parentDir = path.posix.dirname(relativeFilename)
    const command = [
      parentDir && parentDir !== '.' ? `mkdir -p ${shellEscape(parentDir)}` : null,
      `touch ${shellEscape(relativeFilename)}`,
    ]
      .filter(Boolean)
      .join('\n')

    const { result } = await execInTaskWorkspace(task, command, { timeoutSeconds: 30 })
    if (result.exitCode !== 0) {
      return NextResponse.json({ success: false, error: 'Failed to create file' }, { status: 500 })
    }

    return NextResponse.json({
      success: true,
      message: 'File created successfully',
      filename: relativeFilename,
    })
  } catch (error) {
    console.error('Error creating file:', error)
    return NextResponse.json({ success: false, error: 'An error occurred while creating the file' }, { status: 500 })
  }
}
