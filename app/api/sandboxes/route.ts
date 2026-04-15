import { NextResponse } from 'next/server'
import { db } from '@/lib/db/client'
import { tasks } from '@/lib/db/schema'
import { eq, and, isNotNull, or } from 'drizzle-orm'
import { getServerSession } from '@/lib/session/get-server-session'

export async function GET() {
  try {
    const session = await getServerSession()
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const taskRuntimes = await db
      .select({
        id: tasks.id,
        taskId: tasks.id,
        prompt: tasks.prompt,
        repoUrl: tasks.repoUrl,
        branchName: tasks.branchName,
        runtimeProvider: tasks.runtimeProvider,
        runtimeName: tasks.runtimeName,
        runtimeState: tasks.runtimeState,
        gatewayUrl: tasks.gatewayUrl,
        sandboxId: tasks.sandboxId,
        sandboxUrl: tasks.sandboxUrl,
        createdAt: tasks.createdAt,
        status: tasks.status,
        keepAlive: tasks.keepAlive,
        maxDuration: tasks.maxDuration,
      })
      .from(tasks)
      .where(and(eq(tasks.userId, session.user.id), or(isNotNull(tasks.sandboxId), isNotNull(tasks.runtimeName))))
      .orderBy(tasks.createdAt)

    const runningSandboxes = taskRuntimes.map((taskRuntime) => ({
      ...taskRuntime,
      provider: taskRuntime.runtimeName ? taskRuntime.runtimeProvider || 'devbox' : 'sandbox',
    }))

    return NextResponse.json({
      sandboxes: runningSandboxes,
    })
  } catch (error) {
    console.error('Error fetching sandboxes:', error)
    return NextResponse.json({ error: 'Failed to fetch sandboxes' }, { status: 500 })
  }
}
