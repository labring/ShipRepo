import type { NextRequest } from 'next/server'
import { getGitHubClientId } from '@/lib/auth/oauth'
import { getSessionFromReq } from '@/lib/session/server'
import { isRelativeUrl } from '@/lib/utils/is-relative-url'
import { saveSession } from '@/lib/session/create-github'
import { getOAuthToken } from '@/lib/session/get-oauth-token'
import { getAuthCookiePolicyFromRequest } from '@/lib/auth/cookie-policy'

export async function GET(req: NextRequest) {
  const session = await getSessionFromReq(req)
  const authCookiePolicy = getAuthCookiePolicyFromRequest(req)
  if (session) {
    try {
      const tokenData = await getOAuthToken(session.user.id, 'github')
      const clientId = getGitHubClientId()
      if (tokenData && clientId && process.env.GITHUB_CLIENT_SECRET) {
        await fetch(`https://api.github.com/applications/${clientId}/token`, {
          method: 'DELETE',
          headers: {
            Authorization: `Basic ${Buffer.from(`${clientId}:${process.env.GITHUB_CLIENT_SECRET}`).toString('base64')}`,
            Accept: 'application/vnd.github.v3+json',
          },
          body: JSON.stringify({ access_token: tokenData.accessToken }),
        })
      }
    } catch {
      console.error('Failed to revoke GitHub token')
    }
  }

  const response = Response.json({
    url: isRelativeUrl(req.nextUrl.searchParams.get('next') ?? '/') ? req.nextUrl.searchParams.get('next') : '/',
  })

  await saveSession(response, undefined, authCookiePolicy)
  return response
}
