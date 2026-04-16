import { NextRequest, NextResponse } from 'next/server'
import { getCodexGatewayEventStreamUrl } from '@/lib/codex-gateway/client'
import { getTaskGatewayContext } from '@/lib/codex-gateway/task'
import { getServerSession } from '@/lib/session/get-server-session'

interface RouteParams {
  params: Promise<{
    taskId: string
  }>
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

    if (!task.gatewaySessionId) {
      return NextResponse.json({ error: 'Task does not have an active gateway session' }, { status: 400 })
    }

    if (!gatewayUrl) {
      return NextResponse.json({ error: 'Gateway URL is not configured' }, { status: 400 })
    }

    const upstream = await fetch(getCodexGatewayEventStreamUrl(gatewayUrl, task.gatewaySessionId, gatewayAuthToken), {
      headers: {
        accept: 'text/event-stream',
      },
      cache: 'no-store',
    })

    if (!upstream.ok || !upstream.body) {
      return NextResponse.json({ error: 'Failed to connect to Codex gateway events' }, { status: 502 })
    }

    const headers = new Headers()
    headers.set('content-type', 'text/event-stream')
    headers.set('cache-control', 'no-cache, no-transform')
    headers.set('connection', 'keep-alive')

    return new Response(upstream.body, {
      status: 200,
      headers,
    })
  } catch {
    console.error('Failed to proxy Codex gateway events')
    return NextResponse.json({ error: 'Failed to proxy Codex gateway events' }, { status: 500 })
  }
}
