import type { CodexGatewayState } from '@/lib/codex-gateway/types'
import { getAssistantContentAfterLastUser, getLastUserTranscriptIndex } from '@/lib/codex-gateway/transcript'
import type { TaskMessage } from '@/lib/db/schema'
import { buildProjectedAssistantMessageId } from '@/lib/task-message-ids'

export interface OptimisticTaskMessage extends TaskMessage {
  optimistic: true
}

export type ChatTaskMessage = TaskMessage | OptimisticTaskMessage

export interface LiveAssistantMessageIdentity {
  sessionId: string
  transcriptCursor: number
}

export interface ChatTurn {
  id: string
  userMessage: ChatTaskMessage | null
  agentMessages: ChatTaskMessage[]
}

function getTimestamp(value: Date | string | null | undefined): number {
  if (!value) {
    return 0
  }

  return new Date(value).getTime()
}

function isOptimisticMessage(message: ChatTaskMessage): message is OptimisticTaskMessage {
  return 'optimistic' in message && message.optimistic === true
}

export function createOptimisticUserMessage(
  taskId: string,
  content: string,
  clientMessageId: string,
): OptimisticTaskMessage {
  return {
    id: `optimistic-user-${clientMessageId}`,
    taskId,
    role: 'user',
    content,
    clientMessageId,
    createdAt: new Date(),
    optimistic: true,
  }
}

export function parseTaskAgentMessage(content: string): string {
  try {
    const parsed = JSON.parse(content)
    if (parsed && typeof parsed === 'object' && 'result' in parsed && typeof parsed.result === 'string') {
      return parsed.result
    }

    return content
  } catch {
    return content
  }
}

export function areTaskMessagesEqual(previous: TaskMessage[], next: TaskMessage[]): boolean {
  if (previous.length !== next.length) {
    return false
  }

  return previous.every((message, index) => {
    const nextMessage = next[index]

    return (
      message.id === nextMessage.id &&
      message.role === nextMessage.role &&
      message.content === nextMessage.content &&
      getTimestamp(message.createdAt) === getTimestamp(nextMessage.createdAt)
    )
  })
}

export function reconcileOptimisticMessages(
  pendingMessages: OptimisticTaskMessage[],
  persistedMessages: TaskMessage[],
): OptimisticTaskMessage[] {
  const persistedUserMessages = persistedMessages.filter((message) => message.role === 'user')
  const persistedMessageIds = new Set(
    persistedUserMessages
      .map((message) => (typeof message.clientMessageId === 'string' ? message.clientMessageId : null))
      .filter((messageId): messageId is string => Boolean(messageId)),
  )
  const consumedPersistedIds = new Set<string>()

  return pendingMessages.filter((pendingMessage) => {
    if (pendingMessage.clientMessageId && persistedMessageIds.has(pendingMessage.clientMessageId)) {
      return false
    }

    const pendingCreatedAt = getTimestamp(pendingMessage.createdAt)
    const matchingPersistedMessage = persistedUserMessages.find((persistedMessage) => {
      if (consumedPersistedIds.has(persistedMessage.id)) {
        return false
      }

      const persistedCreatedAt = getTimestamp(persistedMessage.createdAt)

      return (
        persistedMessage.content.trim() === pendingMessage.content.trim() &&
        persistedCreatedAt >= pendingCreatedAt - 1000 &&
        persistedCreatedAt <= pendingCreatedAt + 30_000
      )
    })

    if (!matchingPersistedMessage) {
      return true
    }

    consumedPersistedIds.add(matchingPersistedMessage.id)
    return false
  })
}

export function buildStreamingAgentMessage(
  taskId: string,
  gatewayState: CodexGatewayState | null,
  persistedMessages: TaskMessage[],
  identity?: LiveAssistantMessageIdentity | null,
): TaskMessage | null {
  if (!gatewayState) {
    return null
  }

  const lastUserEntryIndex = getLastUserTranscriptIndex(gatewayState.transcript)

  const transcriptEntries =
    typeof lastUserEntryIndex === 'number'
      ? gatewayState.transcript.slice(lastUserEntryIndex + 1)
      : gatewayState.transcript.slice()

  const assistantEntries = transcriptEntries.filter((entry) => entry.role === 'assistant' && entry.text.trim())
  if (assistantEntries.length === 0) {
    return null
  }

  const streamingContent = getAssistantContentAfterLastUser(gatewayState.transcript)

  if (!streamingContent) {
    return null
  }

  const streamingMessageId =
    identity && Number.isFinite(identity.transcriptCursor)
      ? buildProjectedAssistantMessageId(identity.sessionId, identity.transcriptCursor)
      : null

  if (
    streamingMessageId &&
    persistedMessages.some((message) => message.role === 'agent' && message.id === streamingMessageId)
  ) {
    return null
  }

  const latestPersistedAgentMessage = [...persistedMessages].reverse().find((message) => message.role === 'agent')
  const latestPersistedContent = latestPersistedAgentMessage
    ? parseTaskAgentMessage(latestPersistedAgentMessage.content).trim()
    : ''

  if (
    latestPersistedAgentMessage &&
    (latestPersistedContent === streamingContent || latestPersistedContent.startsWith(streamingContent))
  ) {
    return null
  }

  const latestAssistantEntry = assistantEntries[assistantEntries.length - 1]

  return {
    id: streamingMessageId || `gateway-stream-${latestAssistantEntry.id}`,
    taskId,
    role: 'agent',
    content: streamingContent,
    clientMessageId: null,
    createdAt: new Date(latestAssistantEntry.createdAt),
  }
}

export function buildStreamingAgentMessageFromState(
  taskId: string,
  gatewayState: CodexGatewayState | null,
  identity?: LiveAssistantMessageIdentity | null,
): TaskMessage | null {
  if (!gatewayState) {
    return null
  }

  const lastUserEntryIndex = getLastUserTranscriptIndex(gatewayState.transcript)

  const transcriptEntries =
    typeof lastUserEntryIndex === 'number'
      ? gatewayState.transcript.slice(lastUserEntryIndex + 1)
      : gatewayState.transcript.slice()

  const assistantEntries = transcriptEntries.filter((entry) => entry.role === 'assistant' && entry.text.trim())
  if (assistantEntries.length === 0) {
    return null
  }

  const content = getAssistantContentAfterLastUser(gatewayState.transcript)

  if (!content) {
    return null
  }

  const latestAssistantEntry = assistantEntries[assistantEntries.length - 1]
  const streamingMessageId =
    identity && Number.isFinite(identity.transcriptCursor)
      ? buildProjectedAssistantMessageId(identity.sessionId, identity.transcriptCursor)
      : null

  return {
    id: streamingMessageId || `gateway-stream-${latestAssistantEntry.id}`,
    taskId,
    role: 'agent',
    content,
    clientMessageId: null,
    createdAt: new Date(latestAssistantEntry.createdAt),
  }
}

export function hasPersistedAssistantContent(
  persistedMessages: TaskMessage[],
  expectedContent: string | null | undefined,
): boolean {
  const normalizedExpectedContent = expectedContent?.trim()
  if (!normalizedExpectedContent) {
    return true
  }

  return persistedMessages.some((message) => {
    if (message.role !== 'agent') {
      return false
    }

    const normalizedMessageContent = parseTaskAgentMessage(message.content).trim()

    return (
      normalizedMessageContent === normalizedExpectedContent ||
      normalizedMessageContent.startsWith(normalizedExpectedContent)
    )
  })
}

export function hasPersistedAssistantIdentity(
  persistedMessages: TaskMessage[],
  identity: LiveAssistantMessageIdentity | null | undefined,
): boolean {
  if (!identity) {
    return false
  }

  const messageId = buildProjectedAssistantMessageId(identity.sessionId, identity.transcriptCursor)
  return persistedMessages.some((message) => message.role === 'agent' && message.id === messageId)
}

export function combineChatMessages(
  persistedMessages: TaskMessage[],
  pendingMessages: OptimisticTaskMessage[],
  streamingMessage: TaskMessage | null,
): ChatTaskMessage[] {
  const combinedMessages: ChatTaskMessage[] = [...persistedMessages, ...pendingMessages]

  const hasPersistedStreamingMessage = streamingMessage
    ? persistedMessages.some((message) => message.role === 'agent' && message.id === streamingMessage.id)
    : false

  if (
    streamingMessage &&
    !hasPersistedStreamingMessage &&
    !hasPersistedAssistantContent(persistedMessages, streamingMessage.content)
  ) {
    combinedMessages.push(streamingMessage)
  }

  return combinedMessages.toSorted((left, right) => {
    const timestampDelta = getTimestamp(left.createdAt) - getTimestamp(right.createdAt)
    if (timestampDelta !== 0) {
      return timestampDelta
    }

    if (left.role !== right.role) {
      return left.role === 'user' ? -1 : 1
    }

    if (isOptimisticMessage(left) !== isOptimisticMessage(right)) {
      return isOptimisticMessage(left) ? 1 : -1
    }

    return left.id.localeCompare(right.id)
  })
}

export function buildChatTurns(messages: ChatTaskMessage[]): ChatTurn[] {
  return messages.reduce<ChatTurn[]>((turns, message) => {
    if (message.role === 'user') {
      turns.push({
        id: `turn-${message.id}`,
        userMessage: message,
        agentMessages: [],
      })
      return turns
    }

    const previousTurn = turns.at(-1)
    if (!previousTurn) {
      turns.push({
        id: `turn-${message.id}`,
        userMessage: null,
        agentMessages: [message],
      })
      return turns
    }

    previousTurn.agentMessages.push(message)
    return turns
  }, [])
}
