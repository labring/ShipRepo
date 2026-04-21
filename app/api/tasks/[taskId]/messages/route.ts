import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from '@/lib/session/get-server-session'
import { db } from '@/lib/db/client'
import { taskMessages, tasks } from '@/lib/db/schema'
import { eq, and, asc, isNull } from 'drizzle-orm'
import {
  hasActiveTurnCheckpoint,
  reconcileIncompleteTurnSafely,
  shouldAttemptTurnReconciliation,
} from '@/lib/codex-gateway/completion'
import { reconcileProjectedTaskMessages } from '@/lib/task-event-projection'

export async function GET(req: NextRequest, context: { params: Promise<{ taskId: string }> }) {
  try {
    const session = await getServerSession()

    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { taskId } = await context.params

    // First, verify that the task belongs to the user
    const task = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.userId, session.user.id), isNull(tasks.deletedAt)))
      .limit(1)

    if (!task.length) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 })
    }

    if (
      task[0].selectedAgent === 'codex' &&
      hasActiveTurnCheckpoint(task[0]) &&
      shouldAttemptTurnReconciliation(task[0], 5_000)
    ) {
      try {
        await reconcileIncompleteTurnSafely(taskId, 2_500)
      } catch {
        console.error('Failed to reconcile incomplete Codex turn')
      }
    }

    await reconcileProjectedTaskMessages(taskId)

    // Fetch all messages for this task, ordered by creation time
    const messages = await db
      .select()
      .from(taskMessages)
      .where(eq(taskMessages.taskId, taskId))
      .orderBy(asc(taskMessages.createdAt))

    return NextResponse.json({
      success: true,
      messages,
    })
  } catch (error) {
    console.error('Error fetching task messages:', error)
    return NextResponse.json({ error: 'Failed to fetch messages' }, { status: 500 })
  }
}
