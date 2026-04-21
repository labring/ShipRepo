import { NextRequest, NextResponse, after } from 'next/server'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db/client'
import { tasks } from '@/lib/db/schema'
import { CodexGatewayApiError } from '@/lib/codex-gateway/client'
import { startCodexGatewayTaskTurn, waitForCodexGatewayTurnCompletion } from '@/lib/codex-gateway/runner'
import { getTaskGatewayContext } from '@/lib/codex-gateway/task'
import { prependSealosDeployContext } from '@/lib/sealos-deploy-context'
import { getServerSession } from '@/lib/session/get-server-session'
import { appendTaskMessage } from '@/lib/task-messages'
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

    if (!gatewayUrl) {
      return NextResponse.json({ error: 'Gateway URL is not configured' }, { status: 400 })
    }

    const body = await request.json().catch(() => ({}))
    const parsed = turnSchema.safeParse(body)

    if (!parsed.success) {
      return NextResponse.json({ error: 'Prompt is required' }, { status: 400 })
    }

    const prompt = parsed.data.prompt

    try {
      await appendTaskMessage({
        taskId,
        role: 'user',
        content: prompt,
      })
    } catch {
      console.error('Failed to persist gateway turn user message')
    }

    const startedTurn = await startCodexGatewayTaskTurn(
      taskId,
      prependSealosDeployContext(prompt, task.runtimeNamespace),
      {
        appendUserMessage: false,
        model: task.selectedModel,
      },
    )

    after(async () => {
      try {
        await waitForCodexGatewayTurnCompletion(startedTurn)
      } catch (error) {
        console.error('Failed to finalize Codex gateway turn:', error)

        await db
          .update(tasks)
          .set({
            status: 'error',
            error: 'Failed to finalize Codex gateway turn',
            updatedAt: new Date(),
          })
          .where(eq(tasks.id, taskId))

        const logger = createTaskLogger(taskId)
        await logger.error('Failed to finalize Codex gateway turn')
      }
    })

    return NextResponse.json({
      success: true,
      data: {
        session: {
          sessionId: startedTurn.sessionId,
        },
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
