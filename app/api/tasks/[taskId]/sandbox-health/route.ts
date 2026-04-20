import { NextRequest, NextResponse } from 'next/server'
import { getTaskRuntimeInfo, getOwnedTask } from '@/lib/devbox/task-compat'
import { getServerSession } from '@/lib/session/get-server-session'

export async function GET(_request: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  try {
    const session = await getServerSession()
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { taskId } = await params
    const task = await getOwnedTask(taskId, session.user.id)

    if (!task) {
      return NextResponse.json({ status: 'not_found' })
    }

    if (!task.runtimeName || !task.sandboxUrl) {
      return NextResponse.json({
        status: 'not_available',
        message: 'Sandbox not created yet',
      })
    }

    try {
      const runtime = await getTaskRuntimeInfo(task)

      if (runtime.state.phase !== 'Running') {
        return NextResponse.json({
          status: 'stopped',
          message: 'Runtime has stopped',
        })
      }
    } catch (error) {
      console.error('Error loading runtime state:', error)
      return NextResponse.json({
        status: 'stopped',
        message: 'Runtime no longer exists',
      })
    }

    try {
      const response = await fetch(task.sandboxUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      })
      const body = await response.text()

      if (response.ok && body.length > 0) {
        return NextResponse.json({
          status: 'running',
          message: 'Sandbox and dev server are running',
        })
      }

      if (response.status === 404 || response.status === 503) {
        return NextResponse.json({
          status: 'starting',
          message: 'Dev server is starting up',
        })
      }

      if (response.status >= 500) {
        return NextResponse.json({
          status: 'error',
          message: 'Dev server returned an error',
          statusCode: response.status,
        })
      }

      return NextResponse.json({
        status: 'starting',
        message: 'Dev server is initializing',
      })
    } catch {
      return NextResponse.json({
        status: 'starting',
        message: 'Dev server is starting or not responding',
      })
    }
  } catch (error) {
    console.error('Error checking sandbox health:', error)
    return NextResponse.json({
      status: 'error',
      message: 'Failed to check sandbox health',
    })
  }
}
