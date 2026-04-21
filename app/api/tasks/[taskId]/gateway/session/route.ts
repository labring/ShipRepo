import { NextRequest, NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db/client'
import { tasks } from '@/lib/db/schema'
import { FORCED_CODEX_MODEL } from '@/lib/codex/defaults'
import {
  CodexGatewayApiError,
  createCodexGatewaySession,
  deleteCodexGatewaySession,
  getCodexGatewaySessionState,
  waitForCodexGatewayReady,
} from '@/lib/codex-gateway/client'
import { getTaskGatewayContext, normalizeCodexGatewayModel } from '@/lib/codex-gateway/task'
import { getServerSession } from '@/lib/session/get-server-session'
import { createTaskLogger } from '@/lib/utils/task-logger'

const createSessionSchema = z.object({
  model: z.string().trim().min(1).optional(),
  replace: z.boolean().optional(),
})

interface RouteParams {
  params: Promise<{
    taskId: string
  }>
}

function createGatewayUnavailableResponse() {
  return NextResponse.json(
    {
      error: 'Gateway URL is not configured',
      message: 'Gateway URL is not available from the Devbox runtime',
    },
    { status: 400 },
  )
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
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
      return createGatewayUnavailableResponse()
    }

    if (!task.gatewaySessionId) {
      return NextResponse.json({
        success: true,
        data: {
          gatewayUrl,
          session: null,
        },
      })
    }

    try {
      const state = await getCodexGatewaySessionState(gatewayUrl, task.gatewaySessionId, gatewayAuthToken)

      await db
        .update(tasks)
        .set({
          gatewayUrl,
          updatedAt: new Date(),
        })
        .where(eq(tasks.id, taskId))

      return NextResponse.json({
        success: true,
        data: {
          gatewayUrl,
          session: state,
        },
      })
    } catch (error) {
      if (error instanceof CodexGatewayApiError && error.status === 404) {
        await db
          .update(tasks)
          .set({
            gatewayUrl,
            gatewaySessionId: null,
            updatedAt: new Date(),
          })
          .where(eq(tasks.id, taskId))

        return NextResponse.json({
          success: true,
          data: {
            gatewayUrl,
            session: null,
          },
        })
      }

      throw error
    }
  } catch (error) {
    console.error('Failed to fetch Codex gateway session:', error)
    return NextResponse.json({ error: 'Failed to fetch Codex gateway session' }, { status: 500 })
  }
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
      return createGatewayUnavailableResponse()
    }

    const body = await request.json().catch(() => ({}))
    const parsed = createSessionSchema.safeParse(body)

    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
    }

    const logger = createTaskLogger(taskId)

    if (task.gatewaySessionId && !parsed.data.replace) {
      try {
        const existing = await getCodexGatewaySessionState(gatewayUrl, task.gatewaySessionId, gatewayAuthToken)
        const existingModel = normalizeCodexGatewayModel(existing.state.selectedModel)
        const forcedModel = normalizeCodexGatewayModel(FORCED_CODEX_MODEL)

        if (!forcedModel || existingModel === forcedModel) {
          return NextResponse.json({
            success: true,
            data: {
              gatewayUrl,
              session: existing,
            },
          })
        }

        try {
          await deleteCodexGatewaySession(gatewayUrl, task.gatewaySessionId, gatewayAuthToken)
        } catch (error) {
          if (!(error instanceof CodexGatewayApiError && error.status === 404)) {
            throw error
          }
        }

        await db
          .update(tasks)
          .set({
            gatewaySessionId: null,
            selectedModel: FORCED_CODEX_MODEL,
            updatedAt: new Date(),
          })
          .where(eq(tasks.id, taskId))
      } catch (error) {
        if (!(error instanceof CodexGatewayApiError && error.status === 404)) {
          throw error
        }

        await db
          .update(tasks)
          .set({
            gatewaySessionId: null,
            selectedModel: FORCED_CODEX_MODEL,
            updatedAt: new Date(),
          })
          .where(eq(tasks.id, taskId))
      }
    }

    if (task.gatewaySessionId && parsed.data.replace) {
      try {
        await deleteCodexGatewaySession(gatewayUrl, task.gatewaySessionId, gatewayAuthToken)
      } catch (error) {
        if (!(error instanceof CodexGatewayApiError && error.status === 404)) {
          throw error
        }
      }
    }

    await logger.info('Checking Codex gateway readiness')
    await waitForCodexGatewayReady(gatewayUrl)

    await logger.info('Creating Codex gateway session')
    const created = await createCodexGatewaySession(gatewayUrl, { model: FORCED_CODEX_MODEL }, gatewayAuthToken)

    await db
      .update(tasks)
      .set({
        gatewayUrl,
        gatewaySessionId: created.sessionId,
        selectedModel: FORCED_CODEX_MODEL,
        status: 'processing',
        progress: 0,
        updatedAt: new Date(),
        completedAt: null,
      })
      .where(eq(tasks.id, taskId))

    await logger.success('Codex gateway session created')

    return NextResponse.json({
      success: true,
      data: {
        gatewayUrl,
        session: created,
      },
    })
  } catch (error) {
    if (error instanceof CodexGatewayApiError) {
      return NextResponse.json(
        {
          error: 'Failed to create Codex gateway session',
          statusCode: error.status,
          message: error.message,
        },
        { status: error.status >= 400 && error.status < 500 ? error.status : 502 },
      )
    }

    console.error('Failed to create Codex gateway session:', error)
    return NextResponse.json({ error: 'Failed to create Codex gateway session' }, { status: 500 })
  }
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
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
      return NextResponse.json({
        success: true,
      })
    }

    const logger = createTaskLogger(taskId)
    await logger.info('Deleting Codex gateway session')

    if (gatewayUrl) {
      try {
        await deleteCodexGatewaySession(gatewayUrl, task.gatewaySessionId, gatewayAuthToken)
      } catch (error) {
        if (!(error instanceof CodexGatewayApiError && error.status === 404)) {
          throw error
        }
      }
    }

    await db
      .update(tasks)
      .set({
        gatewaySessionId: null,
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, taskId))

    await logger.success('Codex gateway session deleted')

    return NextResponse.json({
      success: true,
    })
  } catch (error) {
    if (error instanceof CodexGatewayApiError) {
      return NextResponse.json(
        {
          error: 'Failed to delete Codex gateway session',
          statusCode: error.status,
          message: error.message,
        },
        { status: error.status >= 400 && error.status < 500 ? error.status : 502 },
      )
    }

    console.error('Failed to delete Codex gateway session:', error)
    return NextResponse.json({ error: 'Failed to delete Codex gateway session' }, { status: 500 })
  }
}
