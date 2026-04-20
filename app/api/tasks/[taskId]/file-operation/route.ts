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
    const { operation, sourceFile, targetPath } = body

    if (!operation || !sourceFile) {
      return NextResponse.json({ success: false, error: 'Missing required parameters' }, { status: 400 })
    }

    if (operation !== 'copy' && operation !== 'cut') {
      return NextResponse.json({ success: false, error: 'Invalid operation' }, { status: 400 })
    }

    const task = await getOwnedTask(taskId, session.user.id)
    if (!task) {
      return NextResponse.json({ success: false, error: 'Task not found' }, { status: 404 })
    }

    const sourceRelative = toTaskRelativePath(sourceFile)
    const sourceBasename = path.posix.basename(sourceRelative)
    const targetRelative = targetPath ? toTaskRelativePath(targetPath) : ''
    const targetFile = targetRelative ? path.posix.join(targetRelative, sourceBasename) : sourceBasename
    const operationCommand = operation === 'copy' ? 'cp -R' : 'mv'
    const command = [
      targetRelative ? `mkdir -p ${shellEscape(targetRelative)}` : null,
      `${operationCommand} ${shellEscape(sourceRelative)} ${shellEscape(targetFile)}`,
    ]
      .filter(Boolean)
      .join('\n')

    const { result } = await execInTaskWorkspace(task, command, { timeoutSeconds: 30 })
    if (result.exitCode !== 0) {
      return NextResponse.json({ success: false, error: 'Failed to perform file operation' }, { status: 500 })
    }

    return NextResponse.json({
      success: true,
      message: operation === 'copy' ? 'File copied successfully' : 'File moved successfully',
    })
  } catch (error) {
    console.error('Error performing file operation:', error)
    return NextResponse.json({ success: false, error: 'Failed to perform file operation' }, { status: 500 })
  }
}
