import { type NextRequest } from 'next/server'

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

export function getAppBaseUrl(req: NextRequest): string {
  const configuredBaseUrl = process.env.APP_BASE_URL?.trim()
  if (configuredBaseUrl) {
    return trimTrailingSlash(configuredBaseUrl)
  }

  const forwardedHost = req.headers.get('x-forwarded-host')
  if (forwardedHost) {
    const forwardedProto = req.headers.get('x-forwarded-proto') ?? 'https'
    return `${forwardedProto}://${forwardedHost}`
  }

  return trimTrailingSlash(req.nextUrl.origin)
}

export function getGitHubClientId(): string {
  return process.env.GITHUB_CLIENT_ID || ''
}
