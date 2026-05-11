import type { NextRequest } from 'next/server'
import type { Session } from './types'
import { SESSION_COOKIE_NAME } from './constants'
import { decryptJWE } from '@/lib/jwe/decrypt'

export async function getSessionFromCookie(cookieValue?: string): Promise<Session | undefined> {
  if (!cookieValue) {
    return undefined
  }

  const decrypted = await decryptJWE<Session>(cookieValue)
  if (!decrypted || decrypted.authProvider !== 'github') {
    return undefined
  }

  return {
    created: decrypted.created,
    authProvider: 'github',
    user: decrypted.user,
  }
}

export async function getSessionFromReq(req: NextRequest): Promise<Session | undefined> {
  const cookieValue = req.cookies.get(SESSION_COOKIE_NAME)?.value
  return getSessionFromCookie(cookieValue)
}
