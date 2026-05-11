import type { NextRequest } from 'next/server'
import type { Session, SessionUserInfo } from '@/lib/session/types'
import { saveSession } from '@/lib/session/create-github'
import { getSessionFromReq } from '@/lib/session/server'
import { getAuthCookiePolicyFromRequest } from '@/lib/auth/cookie-policy'

export async function GET(req: NextRequest) {
  const session = await getSessionFromReq(req)
  const authCookiePolicy = getAuthCookiePolicyFromRequest(req)

  const response = new Response(JSON.stringify(await getData(session)), {
    headers: { 'Content-Type': 'application/json' },
  })

  await saveSession(response, session, authCookiePolicy)
  return response
}

async function getData(session: Session | undefined): Promise<SessionUserInfo> {
  if (!session) {
    return { user: undefined }
  } else {
    return { user: session.user, authProvider: session.authProvider }
  }
}
