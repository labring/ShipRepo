import { SignJWT } from 'jose'
import { getSealosDevboxBaseUrl } from '@/lib/sealos/config'

const DEVBOX_API_PREFIX = '/api/v1/devbox'
const DEFAULT_DEVBOX_NAMESPACE = 'ns-test'
const DEFAULT_DEVBOX_TOKEN_TTL_SECONDS = 4 * 60 * 60
const DNS_1123_LABEL_REGEX = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/

function getRequiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }

  return value
}

export function getDevboxBaseUrl(): string {
  return getSealosDevboxBaseUrl()
}

export function getDevboxApiPrefix(): string {
  return DEVBOX_API_PREFIX
}

export function getDevboxDefaultImage(): string | undefined {
  return process.env.DEVBOX_RUNTIME_IMAGE
}

export function getDevboxArchiveAfterPauseTime(): string | undefined {
  return process.env.DEVBOX_ARCHIVE_AFTER_PAUSE_TIME || '24h'
}

export function getDevboxNamespace(): string {
  const namespace = process.env.DEVBOX_NAMESPACE || DEFAULT_DEVBOX_NAMESPACE

  if (!DNS_1123_LABEL_REGEX.test(namespace)) {
    throw new Error('DEVBOX_NAMESPACE must be a valid DNS1123 label')
  }

  return namespace
}

export async function getDevboxAuthToken(): Promise<string> {
  const staticToken = process.env.DEVBOX_TOKEN
  if (staticToken) {
    return staticToken
  }

  const signingKey = getRequiredEnv('DEVBOX_JWT_SIGNING_KEY')
  const namespace = getDevboxNamespace()
  const ttlSeconds = parseInt(process.env.DEVBOX_JWT_TTL_SECONDS || String(DEFAULT_DEVBOX_TOKEN_TTL_SECONDS), 10)

  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error('DEVBOX_JWT_TTL_SECONDS must be a positive integer')
  }

  const now = Math.floor(Date.now() / 1000)
  const secret = new TextEncoder().encode(signingKey)

  return await new SignJWT({ namespace })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(now)
    .setExpirationTime(now + ttlSeconds)
    .sign(secret)
}
