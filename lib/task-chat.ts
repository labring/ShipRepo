import type { CodexGatewayState } from '@/lib/codex-gateway/types'
import type { TaskMessage } from '@/lib/db/schema'

export interface OptimisticTaskMessage extends TaskMessage {
  optimistic: true
}

export type ChatTaskMessage = TaskMessage | OptimisticTaskMessage

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

export function createOptimisticUserMessage(taskId: string, content: string): OptimisticTaskMessage {
  return {
    id: `optimistic-user-${Date.now()}`,
    taskId,
    role: 'user',
    content,
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
  const consumedPersistedIds = new Set<string>()

  return pendingMessages.filter((pendingMessage) => {
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
): TaskMessage | null {
  if (!gatewayState) {
    return null
  }

  const lastUserEntryIndex = [...gatewayState.transcript]
    .map((entry, index) => ({ entry, index }))
    .reverse()
    .find(({ entry }) => entry.role === 'user' && entry.text.trim())?.index

  const transcriptEntries =
    typeof lastUserEntryIndex === 'number'
      ? gatewayState.transcript.slice(lastUserEntryIndex + 1)
      : gatewayState.transcript.slice()

  const assistantEntries = transcriptEntries.filter((entry) => entry.role === 'assistant' && entry.text.trim())
  if (assistantEntries.length === 0) {
    return null
  }

  const streamingContent = assistantEntries
    .map((entry) => entry.text.trim())
    .filter(Boolean)
    .join('\n\n')
    .trim()

  if (!streamingContent) {
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
    id: `gateway-stream-${latestAssistantEntry.id}`,
    taskId,
    role: 'agent',
    content: streamingContent,
    createdAt: new Date(latestAssistantEntry.createdAt),
  }
}

export function buildStreamingAgentMessageFromState(
  taskId: string,
  gatewayState: CodexGatewayState | null,
): TaskMessage | null {
  if (!gatewayState) {
    return null
  }

  const lastUserEntryIndex = [...gatewayState.transcript]
    .map((entry, index) => ({ entry, index }))
    .reverse()
    .find(({ entry }) => entry.role === 'user' && entry.text.trim())?.index

  const transcriptEntries =
    typeof lastUserEntryIndex === 'number'
      ? gatewayState.transcript.slice(lastUserEntryIndex + 1)
      : gatewayState.transcript.slice()

  const assistantEntries = transcriptEntries.filter((entry) => entry.role === 'assistant' && entry.text.trim())
  if (assistantEntries.length === 0) {
    return null
  }

  const content = assistantEntries
    .map((entry) => entry.text.trim())
    .filter(Boolean)
    .join('\n\n')
    .trim()

  if (!content) {
    return null
  }

  const latestAssistantEntry = assistantEntries[assistantEntries.length - 1]

  return {
    id: `gateway-stream-${latestAssistantEntry.id}`,
    taskId,
    role: 'agent',
    content,
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

export function combineChatMessages(
  persistedMessages: TaskMessage[],
  pendingMessages: OptimisticTaskMessage[],
  streamingMessage: TaskMessage | null,
): ChatTaskMessage[] {
  const combinedMessages: ChatTaskMessage[] = [...persistedMessages, ...pendingMessages]

  if (streamingMessage) {
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
