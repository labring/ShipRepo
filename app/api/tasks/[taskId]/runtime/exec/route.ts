import { NextResponse } from 'next/server'
import { and, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db/client'
import { tasks } from '@/lib/db/schema'
import { DevboxApiError, execDevbox, getDevbox } from '@/lib/devbox/client'
import { getServerSession } from '@/lib/session/get-server-session'

const execSchema = z.object({
  command: z.array(z.string().min(1)).min(1),
  stdin: z.string().optional(),
  timeoutSeconds: z.number().int().min(1).max(600).optional(),
  container: z.string().optional(),
})

interface RouteParams {
  params: Promise<{
    taskId: string
  }>
}

async function getOwnedTask(taskId: string, userId: string) {
  const [task] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.userId, userId), isNull(tasks.deletedAt)))
    .limit(1)

  return task
}

export async function POST(request: Request, { params }: RouteParams) {
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

    if (!task.runtimeName) {
      return NextResponse.json({ error: 'Task does not have an active runtime' }, { status: 400 })
    }

    const body = await request.json()
    const input = execSchema.parse(body)

    const execResponse = await execDevbox(task.runtimeName, input)
    const infoResponse = await getDevbox(task.runtimeName)

    await db
      .update(tasks)
      .set({
        runtimeState: infoResponse.data.state.phase,
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, taskId))

    return NextResponse.json({
      success: true,
      data: execResponse.data,
    })
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid exec payload' }, { status: 400 })
    }

    if (error instanceof DevboxApiError) {
      return NextResponse.json(
        {
          error: 'Failed to execute command in Devbox runtime',
          statusCode: error.status,
          message: error.message,
        },
        { status: error.status >= 400 && error.status < 500 ? error.status : 502 },
      )
    }

    console.error('Failed to execute Devbox command:', error)
    return NextResponse.json({ error: 'Failed to execute Devbox command' }, { status: 500 })
  }
}
