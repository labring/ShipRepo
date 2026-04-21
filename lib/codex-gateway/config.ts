import type { DevboxInfo } from '@/lib/devbox/types'

const DEFAULT_CODEX_GATEWAY_SESSION_TTL_MS = '14400000'

export function getCodexGatewaySessionTtlMs(): string {
  return process.env.CODEX_GATEWAY_SESSION_TTL_MS || DEFAULT_CODEX_GATEWAY_SESSION_TTL_MS
}

function getObjectValue(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export function getCodexGatewayUrlFromDevboxInfo(info?: DevboxInfo | null): string | null {
  const gateway = info?.gateway
  if (!gateway) {
    return null
  }

  const gatewayRecord = gateway as Record<string, unknown>

  return (
    getObjectValue(gatewayRecord, 'url') ||
    getObjectValue(gatewayRecord, 'route') ||
    getObjectValue(gatewayRecord, 'externalURL') ||
    getObjectValue(gatewayRecord, 'appURL') ||
    getObjectValue(gatewayRecord, 'accessURL')
  )
}

export function resolveCodexGatewayUrl(
  runtimeName: string | null | undefined,
  currentUrl?: string | null,
  info?: DevboxInfo | null,
): string | null {
  const devboxGatewayUrl = getCodexGatewayUrlFromDevboxInfo(info)
  if (devboxGatewayUrl) {
    return devboxGatewayUrl
  }

  const existingUrl = currentUrl?.trim()
  if (existingUrl) {
    return existingUrl
  }

  return null
}

export function getCodexGatewayAuthTokenFromDevboxInfo(info?: DevboxInfo | null): string | null {
  const gateway = info?.gateway
  if (!gateway) {
    return null
  }

  const gatewayRecord = gateway as Record<string, unknown>

  return (
    getObjectValue(gatewayRecord, 'accessToken') ||
    getObjectValue(gatewayRecord, 'authToken') ||
    getObjectValue(gatewayRecord, 'bearerToken') ||
    getObjectValue(gatewayRecord, 'token') ||
    getObjectValue(gatewayRecord, 'jwt')
  )
}

export async function getCodexGatewayAuthToken(info?: DevboxInfo | null): Promise<string | null> {
  return getCodexGatewayAuthTokenFromDevboxInfo(info)
}
