import { NextResponse } from 'next/server'
import { execInTaskWorkspace, getOwnedTask } from '@/lib/devbox/task-compat'
import { getServerSession } from '@/lib/session/get-server-session'

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export async function POST(request: Request, { params }: { params: Promise<{ taskId: string }> }) {
  try {
    const session = await getServerSession()
    if (!session?.user?.id) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
    }

    const { taskId } = await params
    const body = await request.json().catch(() => ({}))
    const commitMessage =
      typeof body.commitMessage === 'string' && body.commitMessage.trim() ? body.commitMessage : null

    const task = await getOwnedTask(taskId, session.user.id)
    if (!task) {
      return NextResponse.json({ success: false, error: 'Task not found' }, { status: 404 })
    }

    if (!task.branchName) {
      return NextResponse.json({ success: false, error: 'Branch not available' }, { status: 400 })
    }

    const message = shellEscape(commitMessage || 'Sync local changes')
    const branch = shellEscape(task.branchName)
    const command = [
      'git add .',
      'if git diff --cached --quiet --exit-code; then',
      '  printf "__NO_CHANGES__\\n"',
      '  exit 0',
      'fi',
      `git commit -m ${message}`,
      `git push origin ${branch}`,
    ].join('\n')

    const { result } = await execInTaskWorkspace(task, command, { timeoutSeconds: 180 })

    if (result.exitCode !== 0) {
      console.error('Error syncing changes in runtime')
      return NextResponse.json({ success: false, error: 'Failed to push changes' }, { status: 500 })
    }

    const hasChanges = !result.stdout.includes('__NO_CHANGES__')

    return NextResponse.json({
      success: true,
      message: hasChanges ? 'Changes synced successfully' : 'No changes to sync',
      committed: hasChanges,
      pushed: hasChanges,
    })
  } catch (error) {
    console.error('Error syncing changes:', error)
    return NextResponse.json({ success: false, error: 'An error occurred while syncing changes' }, { status: 500 })
  }
}
