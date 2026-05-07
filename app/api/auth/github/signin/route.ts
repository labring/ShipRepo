import { type NextRequest } from 'next/server'
import { cookies } from 'next/headers'
import { getSessionFromReq } from '@/lib/session/server'
import { GITHUB_OAUTH_SCOPE, getAppBaseUrl, getGitHubClientId } from '@/lib/auth/oauth'
import { isRelativeUrl } from '@/lib/utils/is-relative-url'
import { generateState } from 'arctic'
import { getAuthCookiePolicyFromRequest, getAuthCookieSameSite, getAuthCookieSecure } from '@/lib/auth/cookie-policy'
import {
  GITHUB_AUTH_POPUP_COOKIE,
  GITHUB_AUTH_POPUP_PARAM,
  GITHUB_AUTH_POPUP_VALUE,
} from '@/lib/auth/github-popup-contract'

const GITHUB_AUTH_COOKIE_MAX_AGE = 60 * 10

function setGitHubAuthCookie(
  store: Awaited<ReturnType<typeof cookies>>,
  key: string,
  value: string,
  authCookiePolicy: ReturnType<typeof getAuthCookiePolicyFromRequest>,
): void {
  store.set(key, value, {
    path: '/',
    secure: getAuthCookieSecure(authCookiePolicy),
    httpOnly: true,
    maxAge: GITHUB_AUTH_COOKIE_MAX_AGE,
    sameSite: getAuthCookieSameSite(authCookiePolicy),
  })
}

export async function GET(req: NextRequest): Promise<Response> {
  if (req.nextUrl.searchParams.get(GITHUB_AUTH_POPUP_PARAM) !== GITHUB_AUTH_POPUP_VALUE) {
    return new Response('Invalid GitHub authentication request', { status: 400 })
  }

  // Check if user is authenticated with Vercel first
  const session = await getSessionFromReq(req)
  if (!session?.user) {
    return Response.redirect(new URL('/', getAppBaseUrl(req)))
  }

  const clientId = getGitHubClientId()
  const redirectUri = `${getAppBaseUrl(req)}/api/auth/github/callback`

  if (!clientId) {
    return Response.redirect(new URL('/?error=github_not_configured', getAppBaseUrl(req)))
  }

  const state = generateState()
  const store = await cookies()
  const authCookiePolicy = getAuthCookiePolicyFromRequest(req)
  const redirectTo = isRelativeUrl(req.nextUrl.searchParams.get('next') ?? '/')
    ? (req.nextUrl.searchParams.get('next') ?? '/')
    : '/'

  // Store state and redirect URL
  for (const [key, value] of [
    [GITHUB_AUTH_POPUP_COOKIE, GITHUB_AUTH_POPUP_VALUE],
    ['github_auth_redirect_to', redirectTo],
    ['github_auth_state', state],
    ['github_auth_mode', 'connect'],
    ['github_auth_user_id', session.user.id],
  ]) {
    setGitHubAuthCookie(store, key, value, authCookiePolicy)
  }

  // Build GitHub authorization URL
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: GITHUB_OAUTH_SCOPE,
    state: state,
  })

  const url = `https://github.com/login/oauth/authorize?${params.toString()}`

  // Redirect directly to GitHub
  return Response.redirect(url)
}

export async function POST(req: NextRequest): Promise<Response> {
  if (req.nextUrl.searchParams.get(GITHUB_AUTH_POPUP_PARAM) !== GITHUB_AUTH_POPUP_VALUE) {
    return Response.json({ error: 'Invalid GitHub authentication request' }, { status: 400 })
  }

  // Check if user is authenticated with Vercel first
  const session = await getSessionFromReq(req)
  if (!session?.user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const clientId = getGitHubClientId()
  const redirectUri = `${getAppBaseUrl(req)}/api/auth/github/callback`

  if (!clientId) {
    return Response.json({ error: 'GitHub OAuth not configured' }, { status: 500 })
  }

  const state = generateState()
  const store = await cookies()
  const authCookiePolicy = getAuthCookiePolicyFromRequest(req)
  const redirectTo = isRelativeUrl(req.nextUrl.searchParams.get('next') ?? '/')
    ? (req.nextUrl.searchParams.get('next') ?? '/')
    : '/'

  // Store state and redirect URL
  for (const [key, value] of [
    [GITHUB_AUTH_POPUP_COOKIE, GITHUB_AUTH_POPUP_VALUE],
    ['github_auth_redirect_to', redirectTo],
    ['github_auth_state', state],
    ['github_auth_mode', 'connect'],
    ['github_auth_user_id', session.user.id],
  ]) {
    setGitHubAuthCookie(store, key, value, authCookiePolicy)
  }

  // Build GitHub authorization URL
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: GITHUB_OAUTH_SCOPE,
    state: state,
  })

  const url = `https://github.com/login/oauth/authorize?${params.toString()}`

  return Response.json({ url })
}
