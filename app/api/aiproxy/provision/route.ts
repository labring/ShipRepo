import { NextRequest, NextResponse } from 'next/server'
import { provisionUserAiProxyApiKey } from '@/lib/aiproxy/api-key-provisioning'
import { getSessionFromReq } from '@/lib/session/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function getFailureStatus(reason: string): number {
  if (reason === 'missing_kubeconfig') {
    return 400
  }

  if (reason === 'request_failed') {
    return 502
  }

  return 500
}

export async function POST(req: NextRequest) {
  try {
    const session = await getSessionFromReq(req)

    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = (await req.json().catch(() => ({}))) as { kubeconfig?: unknown }
    const result = await provisionUserAiProxyApiKey({
      kubeconfig: typeof body.kubeconfig === 'string' ? body.kubeconfig : null,
      userId: session.user.id,
    })

    if (result.ok) {
      return NextResponse.json({ success: true })
    }

    return NextResponse.json(
      {
        diagnostic: result.diagnostic,
        error: 'Failed to provision AIProxy configuration',
        reason: result.reason,
      },
      { status: getFailureStatus(result.reason) },
    )
  } catch {
    console.error('Failed to provision AIProxy configuration')
    return NextResponse.json({ error: 'Failed to provision AIProxy configuration' }, { status: 500 })
  }
}
