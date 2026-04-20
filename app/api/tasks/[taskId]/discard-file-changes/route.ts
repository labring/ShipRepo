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

    if (!filename) {
      return NextResponse.json({ success: false, error: 'Missing filename parameter' }, { status: 400 })
    }

    const task = await getOwnedTask(taskId, session.user.id)
    if (!task) {
      return NextResponse.json({ success: false, error: 'Task not found' }, { status: 404 })
    }

    const relativeFilename = toTaskRelativePath(filename)
    const escapedFilename = shellEscape(relativeFilename)
    const command = [
      `if git ls-files --error-unmatch ${escapedFilename} >/dev/null 2>&1; then`,
      `  git checkout HEAD -- ${escapedFilename}`,
      '  printf "__TRACKED__\\n"',
      'else',
      `  rm -rf ${escapedFilename}`,
      '  printf "__UNTRACKED__\\n"',
      'fi',
    ].join('\n')

    const { result } = await execInTaskWorkspace(task, command, { timeoutSeconds: 60 })
    if (result.exitCode !== 0) {
      return NextResponse.json({ success: false, error: 'Failed to discard changes' }, { status: 500 })
    }

    const isTracked = result.stdout.includes('__TRACKED__')

    return NextResponse.json({
      success: true,
      message: isTracked ? 'Changes discarded successfully' : 'New file deleted successfully',
    })
  } catch (error) {
    console.error('Error discarding file changes:', error)
    return NextResponse.json({ success: false, error: 'An error occurred while discarding changes' }, { status: 500 })
  }
}
