import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db/client'
import { tasks } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { deleteDevbox, DevboxApiError } from '@/lib/devbox/client'
import { getOwnedTask } from '@/lib/devbox/task-compat'
import { mergePullRequest } from '@/lib/github/client'
import { getServerSession } from '@/lib/session/get-server-session'

interface RouteParams {
  params: Promise<{
    taskId: string
  }>
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const session = await getServerSession()
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { taskId } = await params
    const body = await request.json()
    const { commitTitle, commitMessage, mergeMethod = 'squash' } = body
    const task = await getOwnedTask(taskId, session.user.id)

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 })
    }

    if (!task.repoUrl || !task.prNumber) {
      return NextResponse.json({ error: 'Task does not have repository or PR information' }, { status: 400 })
    }

    const result = await mergePullRequest({
      repoUrl: task.repoUrl,
      prNumber: task.prNumber,
      commitTitle,
      commitMessage,
      mergeMethod,
    })

    if (!result.success) {
      return NextResponse.json({ error: result.error || 'Failed to merge pull request' }, { status: 500 })
    }

    if (task.runtimeName) {
      try {
        await deleteDevbox(task.runtimeName)
      } catch (error) {
        if (!(error instanceof DevboxApiError && error.status === 404)) {
          console.error('Error stopping runtime after merge:', error)
        }
      }
    }

    await db
      .update(tasks)
      .set({
        prStatus: 'merged',
        prMergeCommitSha: result.sha || null,
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
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, taskId))

    return NextResponse.json({
      success: true,
      data: {
        merged: result.merged,
        message: result.message,
        sha: result.sha,
      },
    })
  } catch (error) {
    console.error('Error merging pull request:', error)
    return NextResponse.json({ error: 'Failed to merge pull request' }, { status: 500 })
  }
}
