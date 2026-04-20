import { NextRequest, NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { tasks } from '@/lib/db/schema'
import { deleteDevbox, DevboxApiError } from '@/lib/devbox/client'
import { getOwnedTask } from '@/lib/devbox/task-compat'
import { getServerSession } from '@/lib/session/get-server-session'

export async function POST(_request: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  try {
    const session = await getServerSession()
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { taskId } = await params
    const task = await getOwnedTask(taskId, session.user.id)

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 })
    }

    if (task.runtimeName) {
      try {
        await deleteDevbox(task.runtimeName)
      } catch (error) {
        if (!(error instanceof DevboxApiError && error.status === 404)) {
          throw error
        }
      }
    }

    await db
      .update(tasks)
      .set({
        runtimeProvider: null,
        runtimeName: null,
        runtimeNamespace: null,
        runtimeState: null,
        workspacePreparedAt: null,
        workspaceFingerprint: null,
        runtimeCheckedAt: null,
        gatewayReadyAt: null,
        gatewayUrl: null,
        gatewaySessionId: null,
        sandboxId: null,
        sandboxUrl: null,
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, taskId))

    return NextResponse.json({
      success: true,
      message: 'Sandbox stopped successfully',
    })
  } catch (error) {
    console.error('Error stopping sandbox:', error)
    return NextResponse.json({ error: 'Failed to stop sandbox' }, { status: 500 })
  }
}
