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
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { taskId } = await params
    const body = await request.json()
    const { filename, content } = body

    if (!filename || content === undefined) {
      return NextResponse.json({ error: 'Missing filename or content' }, { status: 400 })
    }

    const task = await getOwnedTask(taskId, session.user.id)
    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 })
    }

    const relativeFilename = toTaskRelativePath(filename)
    const parentDir = path.posix.dirname(relativeFilename)
    const encodedContent = Buffer.from(String(content)).toString('base64')
    const command = [
      parentDir && parentDir !== '.' ? `mkdir -p ${shellEscape(parentDir)}` : null,
      `printf '%s' ${shellEscape(encodedContent)} | base64 -d > ${shellEscape(relativeFilename)}`,
    ]
      .filter(Boolean)
      .join('\n')

    const { result } = await execInTaskWorkspace(task, command, { timeoutSeconds: 60 })
    if (result.exitCode !== 0) {
      console.error('Failed to save file in runtime')
      return NextResponse.json({ error: 'Failed to write file to runtime' }, { status: 500 })
    }

    return NextResponse.json({
      success: true,
      message: 'File saved successfully',
    })
  } catch (error) {
    console.error('Error in save-file API:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
