export const TASK_FLOW_LOGS = {
  USER_INPUT_RECEIVED: '[KEY][USER] Received user input',
  USER_INPUT_SAVED: '[KEY][USER] Saved user input',
  DEVBOX_RUNTIME_PROVISIONING: '[KEY][DEVBOX] Starting runtime provisioning',
  DEVBOX_RUNTIME_REUSED: '[KEY][DEVBOX] Reusing existing runtime',
  DEVBOX_WORKSPACE_BOOTSTRAPPING: '[KEY][DEVBOX] Bootstrapping workspace',
  DEVBOX_WORKSPACE_READY: '[KEY][DEVBOX] Workspace ready',
  DEVBOX_RUNTIME_READY: '[KEY][DEVBOX] Runtime ready',
  GATEWAY_SESSION_PREPARING: '[KEY][GATEWAY] Preparing session',
  GATEWAY_SESSION_READY: '[KEY][GATEWAY] Session ready',
  GATEWAY_STREAM_CONNECTED: '[KEY][GATEWAY] Stream connected',
  GATEWAY_STREAM_RECONNECTING: '[KEY][GATEWAY] Stream reconnecting',
  GATEWAY_STREAM_RESUMED: '[KEY][GATEWAY] Stream resumed',
  GATEWAY_TURN_SENDING: '[KEY][GATEWAY] Sending user input',
  GATEWAY_TURN_WAITING: '[KEY][GATEWAY] Waiting for response',
  GATEWAY_TURN_COMPLETED: '[KEY][GATEWAY] Response received',
  GATEWAY_TURN_FAILED: '[KEY][GATEWAY] Response failed',
} as const

const KEY_TASK_LOG_PATTERN = /^\[KEY\]\[(USER|DEVBOX|GATEWAY)\]\s*([^|]*?)(?:\s+\|\s+(.+))?$/
const KEY_TASK_LOG_METADATA_KEYS = [
  'source',
  'mode',
  'promptChars',
  'runtimeName',
  'runtimeState',
  'sessionId',
  'threadId',
  'selectedModel',
  'streamState',
  'transcriptCursor',
  'turnStatus',
  'errorSource',
  'httpStatus',
  'installedSkill',
] as const

export type KeyTaskLogScope = 'USER' | 'DEVBOX' | 'GATEWAY'
export type KeyTaskLogMetadataKey = (typeof KEY_TASK_LOG_METADATA_KEYS)[number]

export type KeyTaskLogMetadataValue = boolean | number | string

export type KeyTaskLogMetadata = Partial<Record<KeyTaskLogMetadataKey, KeyTaskLogMetadataValue | null | undefined>>

export interface ParsedKeyTaskLogMetadataEntry {
  key: string
  value: string
}

function sanitizeKeyTaskLogMetadataValue(value: KeyTaskLogMetadataValue): string {
  return String(value)
    .trim()
    .replace(/[\r\n]+/g, ' ')
    .replace(/,+/g, '_')
}

function buildKeyTaskLogMetadataEntries(metadata?: KeyTaskLogMetadata): ParsedKeyTaskLogMetadataEntry[] {
  if (!metadata) {
    return []
  }

  return KEY_TASK_LOG_METADATA_KEYS.flatMap((key) => {
    const value = metadata[key]

    if (value === null || value === undefined) {
      return []
    }

    const sanitizedValue = sanitizeKeyTaskLogMetadataValue(value)

    if (!sanitizedValue) {
      return []
    }

    return [{ key, value: sanitizedValue }]
  })
}

function parseKeyTaskLogMetadata(metadataText?: string): ParsedKeyTaskLogMetadataEntry[] {
  if (!metadataText) {
    return []
  }

  return metadataText
    .split(', ')
    .map((entry) => {
      const separatorIndex = entry.indexOf('=')

      if (separatorIndex === -1) {
        return null
      }

      const key = entry.slice(0, separatorIndex).trim()
      const value = entry.slice(separatorIndex + 1).trim()

      if (!key || !value) {
        return null
      }

      return { key, value }
    })
    .filter((entry): entry is ParsedKeyTaskLogMetadataEntry => Boolean(entry))
}

export function formatKeyTaskLogMessage(message: string, metadata?: KeyTaskLogMetadata): string {
  const metadataEntries = buildKeyTaskLogMetadataEntries(metadata)

  if (metadataEntries.length === 0) {
    return message
  }

  return `${message} | ${metadataEntries.map((entry) => `${entry.key}=${entry.value}`).join(', ')}`
}

export function isKeyTaskLogMessage(message: string): boolean {
  return KEY_TASK_LOG_PATTERN.test(message)
}

export function parseKeyTaskLogMessage(message: string): {
  isKey: boolean
  scope: KeyTaskLogScope | null
  content: string
  metadata: ParsedKeyTaskLogMetadataEntry[]
} {
  const match = KEY_TASK_LOG_PATTERN.exec(message)

  if (!match) {
    return {
      isKey: false,
      scope: null,
      content: message,
      metadata: [],
    }
  }

  return {
    isKey: true,
    scope: match[1] as KeyTaskLogScope,
    content: (match[2] || '').trim(),
    metadata: parseKeyTaskLogMetadata(match[3]),
  }
}
