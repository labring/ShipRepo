import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db/client'
import { tasks } from '@/lib/db/schema'
import { eq, and, isNull } from 'drizzle-orm'
import { createTaskLogger } from '@/lib/utils/task-logger'
import { deleteDevbox, DevboxApiError } from '@/lib/devbox/client'
import { getServerSession } from '@/lib/session/get-server-session'
import { CodexGatewayApiError, deleteCodexGatewaySession } from '@/lib/codex-gateway/client'
import {
  hasActiveTurnCheckpoint,
  reconcileIncompleteTurnSafely,
  shouldAttemptTurnReconciliation,
} from '@/lib/codex-gateway/completion'
import { getTaskGatewayContext } from '@/lib/codex-gateway/task'
import { closeTaskChatV2StreamDescriptor } from '@/lib/task-chat-v2'

interface RouteParams {
  params: Promise<{
    taskId: string
  }>
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const session = await getServerSession()
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { taskId } = await params
    const task = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.userId, session.user.id), isNull(tasks.deletedAt)))
      .limit(1)

    if (!task[0]) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 })
    }

    let currentTask = task[0]

    if (
      currentTask.selectedAgent === 'codex' &&
      hasActiveTurnCheckpoint(currentTask) &&
      shouldAttemptTurnReconciliation(currentTask)
    ) {
      try {
        currentTask = (await reconcileIncompleteTurnSafely(currentTask.id)) || currentTask
      } catch {
        console.error('Failed to reconcile incomplete Codex turn')
      }
    }

    return NextResponse.json({ task: currentTask })
  } catch (error) {
    console.error('Error fetching task:', error)
    return NextResponse.json({ error: 'Failed to fetch task' }, { status: 500 })
  }
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const session = await getServerSession()
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { taskId } = await params
    const body = await request.json()

    // Check if task exists and belongs to user
    const [existingTask] = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.userId, session.user.id), isNull(tasks.deletedAt)))
      .limit(1)

    if (!existingTask) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 })
    }

    // Handle stop action
    if (body.action === 'stop') {
      // Only allow stopping tasks that are currently processing
      if (existingTask.status !== 'processing') {
        return NextResponse.json({ error: 'Task can only be stopped when it is in progress' }, { status: 400 })
      }

      const logger = createTaskLogger(taskId)

      try {
        // Log the stop request
        await logger.info('Stop request received - terminating task execution...')

        if (hasActiveTurnCheckpoint(existingTask)) {
          await reconcileIncompleteTurnSafely(taskId, 1_500).catch(() => {
            console.error('Failed to reconcile task before stop')
          })
        }

        const { gatewayUrl, gatewayAuthToken } = await getTaskGatewayContext(taskId, session.user.id)

        if (existingTask.gatewaySessionId && gatewayUrl) {
          try {
            await deleteCodexGatewaySession(gatewayUrl, existingTask.gatewaySessionId, gatewayAuthToken)
            await logger.success('Codex gateway session deleted')
          } catch (error) {
            if (!(error instanceof CodexGatewayApiError && error.status === 404)) {
              console.error('Failed to delete Codex gateway session during stop:', error)
              await logger.error('Failed to delete Codex gateway session')
            }
          }
        }

        // Update task status to stopped
        const [updatedTask] = await db
          .update(tasks)
          .set({
            status: 'stopped',
            error: 'Task was stopped by user',
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
            activeTurnSessionId: null,
            activeTurnStartedAt: null,
            activeTurnTranscriptCursor: null,
            turnCompletionState: 'failed',
            turnCompletionCheckedAt: new Date(),
            sandboxId: null,
            sandboxUrl: null,
            updatedAt: new Date(),
            completedAt: new Date(),
          })
          .where(eq(tasks.id, taskId))
          .returning()

        await closeTaskChatV2StreamDescriptor(taskId).catch(() => {
          console.error('Failed to close active chat stream during stop')
        })

        if (existingTask.runtimeName) {
          try {
            await deleteDevbox(existingTask.runtimeName)
            await logger.success('Devbox runtime deleted')
          } catch (error) {
            if (!(error instanceof DevboxApiError && error.status === 404)) {
              console.error('Failed to delete Devbox runtime during stop:', error)
              await logger.error('Failed to delete Devbox runtime')
            }
          }
        }

        await logger.error('Task execution stopped by user')

        return NextResponse.json({
          message: 'Task stopped successfully',
          task: updatedTask,
        })
      } catch (error) {
        console.error('Error stopping task:', error)
        await logger.error('Failed to stop task properly')
        return NextResponse.json({ error: 'Failed to stop task' }, { status: 500 })
      }
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  } catch (error) {
    console.error('Error updating task:', error)
    return NextResponse.json({ error: 'Failed to update task' }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const session = await getServerSession()
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { taskId } = await params

    // Check if task exists and belongs to user (and not deleted)
    const existingTask = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.userId, session.user.id), isNull(tasks.deletedAt)))
      .limit(1)

    if (!existingTask[0]) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 })
    }

    // Soft delete the task by setting deletedAt
    await db
      .update(tasks)
      .set({ deletedAt: new Date() })
      .where(and(eq(tasks.id, taskId), eq(tasks.userId, session.user.id)))

    return NextResponse.json({ message: 'Task deleted successfully' })
  } catch (error) {
    console.error('Error deleting task:', error)
    return NextResponse.json({ error: 'Failed to delete task' }, { status: 500 })
  }
}
