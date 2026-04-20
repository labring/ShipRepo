import { NextRequest, NextResponse } from 'next/server'
import { execInTaskWorkspace, getOwnedTask } from '@/lib/devbox/task-compat'
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
    const body = await request.json().catch(() => ({}))
    const commitMessage =
      typeof body.commitMessage === 'string' && body.commitMessage.trim()
        ? body.commitMessage
        : 'Checkpoint before reset'

    const task = await getOwnedTask(taskId, session.user.id)
    if (!task) {
      return NextResponse.json({ success: false, error: 'Task not found' }, { status: 404 })
    }

    if (!task.branchName) {
      return NextResponse.json({ success: false, error: 'Branch not available' }, { status: 400 })
    }

    const branch = shellEscape(task.branchName)
    const message = shellEscape(commitMessage)
    const command = [
      'had_changes=0',
      'if [ -n "$(git status --porcelain)" ]; then',
      '  had_changes=1',
      '  git add .',
      '  if ! git diff --cached --quiet --exit-code; then',
      `    git commit -m ${message}`,
      '  fi',
      'fi',
      `if git ls-remote --exit-code --heads origin ${branch} >/dev/null 2>&1; then`,
      `  git fetch origin ${branch}`,
      '  git reset --hard FETCH_HEAD',
      'else',
      '  git reset --hard HEAD',
      'fi',
      'git clean -fd',
      'printf "__HAD_LOCAL_CHANGES__:%s\\n" "$had_changes"',
    ].join('\n')

    const { result } = await execInTaskWorkspace(task, command, { timeoutSeconds: 180 })
    if (result.exitCode !== 0) {
      return NextResponse.json({ success: false, error: 'Failed to reset changes' }, { status: 500 })
    }

    const hadLocalChanges = result.stdout.includes('__HAD_LOCAL_CHANGES__:1')

    return NextResponse.json({
      success: true,
      message: 'Changes reset successfully to match remote branch',
      hadLocalChanges,
    })
  } catch (error) {
    console.error('Error resetting changes:', error)
    return NextResponse.json({ success: false, error: 'An error occurred while resetting changes' }, { status: 500 })
  }
}
