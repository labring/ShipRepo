import type { DevboxInfo } from '@/lib/devbox/types'

const DEFAULT_CODEX_GATEWAY_PORT = '1317'
const DEFAULT_CODEX_GATEWAY_SESSION_TTL_MS = '14400000'

export function getCodexGatewayPort(): string {
  return process.env.CODEX_GATEWAY_PORT || DEFAULT_CODEX_GATEWAY_PORT
}

export function getCodexGatewaySessionTtlMs(): string {
  return process.env.CODEX_GATEWAY_SESSION_TTL_MS || DEFAULT_CODEX_GATEWAY_SESSION_TTL_MS
}

export function getCodexGatewayUrlTemplate(): string | null {
  const value = process.env.DEVBOX_GATEWAY_URL_TEMPLATE?.trim()
  return value || null
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

  const template = getCodexGatewayUrlTemplate()
  if (!template) {
    return null
  }

  if (!runtimeName && template.includes('{name}')) {
    return null
  }

  return template.replaceAll('{name}', runtimeName || '').replaceAll('{port}', getCodexGatewayPort())
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
