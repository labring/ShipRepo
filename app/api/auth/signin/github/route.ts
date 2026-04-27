import { type NextRequest } from 'next/server'
import { cookies } from 'next/headers'
import { generateState } from 'arctic'
import { GITHUB_OAUTH_SCOPE, getAppBaseUrl, getGitHubClientId } from '@/lib/auth/oauth'
import { isRelativeUrl } from '@/lib/utils/is-relative-url'
import { getSessionFromReq } from '@/lib/session/server'
import {
  GITHUB_AUTH_POPUP_COOKIE,
  GITHUB_AUTH_POPUP_PARAM,
  GITHUB_AUTH_POPUP_VALUE,
} from '@/lib/auth/github-popup-contract'

const GITHUB_AUTH_COOKIE_MAX_AGE = 60 * 10

function setGitHubAuthCookie(store: Awaited<ReturnType<typeof cookies>>, key: string, value: string): void {
  store.set(key, value, {
    path: '/',
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: GITHUB_AUTH_COOKIE_MAX_AGE,
    sameSite: 'lax',
  })
}

export async function GET(req: NextRequest): Promise<Response> {
  if (req.nextUrl.searchParams.get(GITHUB_AUTH_POPUP_PARAM) !== GITHUB_AUTH_POPUP_VALUE) {
    return new Response('Invalid GitHub authentication request', { status: 400 })
  }

  // Check if user is already authenticated with Vercel
  const session = await getSessionFromReq(req)

  const clientId = getGitHubClientId()
  const redirectUri = `${getAppBaseUrl(req)}/api/auth/github/callback`

  if (!clientId) {
    return Response.redirect(new URL('/?error=github_not_configured', getAppBaseUrl(req)))
  }

  const state = generateState()
  const store = await cookies()
  let redirectTo = isRelativeUrl(req.nextUrl.searchParams.get('next') ?? '/')
    ? (req.nextUrl.searchParams.get('next') ?? '/')
    : '/'

  // If user is already authenticated with Vercel, treat this as a "Connect GitHub" flow
  // Otherwise, treat it as a "Sign in with GitHub" flow
  const isSignInFlow = !session?.user
  const authMode = isSignInFlow ? 'signin' : 'connect'

  // Add a query parameter to show a toast message after redirect
  if (!isSignInFlow) {
    const redirectUrl = new URL(redirectTo, `${getAppBaseUrl(req)}/`)
    redirectUrl.searchParams.set('github_connected', 'true')
    redirectTo = redirectUrl.pathname + redirectUrl.search
  }

  // Store state and redirect URL
  const cookiesToSet: [string, string][] = [
    [GITHUB_AUTH_POPUP_COOKIE, GITHUB_AUTH_POPUP_VALUE],
    ['github_auth_redirect_to', redirectTo],
    ['github_auth_state', state],
    ['github_auth_mode', authMode],
  ]

  // If connecting (user already signed in), store their user ID
  if (!isSignInFlow && session?.user?.id) {
    cookiesToSet.push(['github_auth_user_id', session.user.id])
  }

  for (const [key, value] of cookiesToSet) {
    setGitHubAuthCookie(store, key, value)
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
