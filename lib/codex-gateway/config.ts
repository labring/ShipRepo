import { SignJWT } from 'jose'

const DEFAULT_CODEX_GATEWAY_PORT = '1317'
const DEFAULT_CODEX_GATEWAY_JWT_TTL_SECONDS = 60 * 60

export function getCodexGatewayPort(): string {
  return process.env.CODEX_GATEWAY_PORT || DEFAULT_CODEX_GATEWAY_PORT
}

export function getCodexGatewayUrlTemplate(): string | null {
  const value = process.env.DEVBOX_GATEWAY_URL_TEMPLATE?.trim()
  return value || null
}

export function resolveCodexGatewayUrl(
  runtimeName: string | null | undefined,
  currentUrl?: string | null,
): string | null {
  const existingUrl = currentUrl?.trim()
  if (existingUrl) {
    return existingUrl
  }

  if (!runtimeName) {
    return null
  }

  const template = getCodexGatewayUrlTemplate()
  if (!template) {
    return null
  }

  return template.replaceAll('{name}', runtimeName).replaceAll('{port}', getCodexGatewayPort())
}

export async function getCodexGatewayAuthToken(): Promise<string | null> {
  const secret = process.env.CODEX_GATEWAY_JWT_SECRET?.trim()
  if (!secret) {
    return null
  }

  const ttlSeconds = parseInt(
    process.env.CODEX_GATEWAY_JWT_TTL_SECONDS || String(DEFAULT_CODEX_GATEWAY_JWT_TTL_SECONDS),
    10,
  )

  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error('CODEX_GATEWAY_JWT_TTL_SECONDS must be a positive integer')
  }

  const now = Math.floor(Date.now() / 1000)
  const signingKey = new TextEncoder().encode(secret)

  return await new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(now)
    .setExpirationTime(now + ttlSeconds)
    .sign(signingKey)
}
