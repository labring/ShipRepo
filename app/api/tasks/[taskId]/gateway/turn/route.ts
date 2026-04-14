import { NextRequest, NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db/client'
import { taskMessages, tasks } from '@/lib/db/schema'
import { CodexGatewayApiError, sendCodexGatewayTurn } from '@/lib/codex-gateway/client'
import { getTaskGatewayContext } from '@/lib/codex-gateway/task'
import { getServerSession } from '@/lib/session/get-server-session'
import { generateId } from '@/lib/utils/id'
import { createTaskLogger } from '@/lib/utils/task-logger'

const turnSchema = z.object({
  prompt: z.string().trim().min(1),
})

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
    const { task, gatewayUrl, gatewayAuthToken } = await getTaskGatewayContext(taskId, session.user.id)

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 })
    }

    if (!task.gatewaySessionId) {
      return NextResponse.json({ error: 'Task does not have an active gateway session' }, { status: 400 })
    }

    if (!gatewayUrl) {
      return NextResponse.json({ error: 'Gateway URL is not configured' }, { status: 400 })
    }

    const body = await request.json().catch(() => ({}))
    const parsed = turnSchema.safeParse(body)

    if (!parsed.success) {
      return NextResponse.json({ error: 'Prompt is required' }, { status: 400 })
    }

    const prompt = parsed.data.prompt
    const logger = createTaskLogger(taskId)

    await db.insert(taskMessages).values({
      id: generateId(12),
      taskId,
      role: 'user',
      content: prompt,
    })

    await db
      .update(tasks)
      .set({
        status: 'processing',
        progress: 0,
        updatedAt: new Date(),
        completedAt: null,
      })
      .where(eq(tasks.id, taskId))

    await logger.info('Forwarding prompt to Codex gateway')
    const response = await sendCodexGatewayTurn(gatewayUrl, task.gatewaySessionId, { prompt }, gatewayAuthToken)

    return NextResponse.json({
      success: true,
      data: {
        session: response,
      },
    })
  } catch (error) {
    if (error instanceof CodexGatewayApiError) {
      return NextResponse.json(
        {
          error: 'Failed to send prompt to Codex gateway',
          statusCode: error.status,
          message: error.message,
        },
        { status: error.status >= 400 && error.status < 500 ? error.status : 502 },
      )
    }

    console.error('Failed to send prompt to Codex gateway:', error)
    return NextResponse.json({ error: 'Failed to send prompt to Codex gateway' }, { status: 500 })
  }
}
