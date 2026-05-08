import { AIPROXY_AUTO_TOKEN_NAME } from '@/lib/aiproxy/constants'

export interface AiProxyTokenInfo {
  id: number
  key: string
  name: string
  status: number
}

export type AiProxyTokenValidationIssue =
  | 'not_object'
  | 'missing_id'
  | 'invalid_id'
  | 'missing_name'
  | 'invalid_name'
  | 'wrong_name'
  | 'missing_key'
  | 'invalid_key'
  | 'empty_key'
  | 'masked_key'
  | 'missing_status'
  | 'invalid_status'
  | 'disabled_token'
  | 'unsupported_status'

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object')
}

function hasOwnProperty(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

export function isAiProxyTokenInfo(value: unknown): value is AiProxyTokenInfo {
  if (!isRecord(value)) {
    return false
  }

  return (
    typeof value.id === 'number' &&
    typeof value.name === 'string' &&
    typeof value.key === 'string' &&
    typeof value.status === 'number'
  )
}

export function diagnoseAiProxyTokenInfo(
  value: unknown,
  expectedName = AIPROXY_AUTO_TOKEN_NAME,
): AiProxyTokenValidationIssue | null {
  if (!isRecord(value)) {
    return 'not_object'
  }

  if (!hasOwnProperty(value, 'id')) {
    return 'missing_id'
  }

  if (typeof value.id !== 'number') {
    return 'invalid_id'
  }

  if (!hasOwnProperty(value, 'name')) {
    return 'missing_name'
  }

  if (typeof value.name !== 'string') {
    return 'invalid_name'
  }

  if (!hasOwnProperty(value, 'key')) {
    return 'missing_key'
  }

  if (typeof value.key !== 'string') {
    return 'invalid_key'
  }

  if (!hasOwnProperty(value, 'status')) {
    return 'missing_status'
  }

  if (typeof value.status !== 'number') {
    return 'invalid_status'
  }

  if (value.name !== expectedName) {
    return 'wrong_name'
  }

  if (value.status === 2) {
    return 'disabled_token'
  }

  if (value.status !== 1) {
    return 'unsupported_status'
  }

  if (!value.key.trim()) {
    return 'empty_key'
  }

  if (value.key.includes('*')) {
    return 'masked_key'
  }

  return null
}

export function isUsableAiProxyTokenInfo(token: AiProxyTokenInfo, expectedName = AIPROXY_AUTO_TOKEN_NAME): boolean {
  return diagnoseAiProxyTokenInfo(token, expectedName) === null
}
