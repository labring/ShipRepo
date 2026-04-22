'use client'

import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CodexGatewayState } from '@/lib/codex-gateway/types'
import type { Task, TaskEvent, TaskMessage } from '@/lib/db/schema'
import {
  areTaskMessagesEqual,
  buildStreamingAgentMessage,
  buildStreamingAgentMessageFromState,
  combineChatMessages,
  createOptimisticUserMessage,
  hasPersistedAssistantIdentity,
  type LiveAssistantMessageIdentity,
  reconcileOptimisticMessages,
} from '@/lib/task-chat'
import {
  buildAgentActivityItemsFromState,
  buildAgentActivityItemsFromTaskEvents,
  type TaskAgentActivityItem,
} from '@/lib/task-agent-events'
import type { TaskChatV2StreamDescriptor } from '@/lib/task-chat-v2'

interface ChatActionResult {
  success: boolean
  error?: string
}

interface ChatV2BootstrapResponse {
  success: boolean
  data?: {
    events: TaskEvent[]
    messages: TaskMessage[]
    stream: TaskChatV2StreamDescriptor | null
    task: Task
  }
  error?: string
}

interface ChatV2TurnResponse {
  success: boolean
  data?: {
    session: {
      sessionId: string
      threadId: string | null
      turnId: string | null
    }
    stream: TaskChatV2StreamDescriptor
    turn: {
      transcriptCursor: number
      turnAccepted: boolean
      turnStartedAt: string
    }
  }
  error?: string
}

function buildClientMessageId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}:${crypto.randomUUID()}`
  }

  return `${prefix}:${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function getLiveTurnIdentity(task: Pick<Task, 'activeTurnSessionId' | 'activeTurnTranscriptCursor'>) {
  return task.activeTurnSessionId && typeof task.activeTurnTranscriptCursor === 'number'
    ? {
        sessionId: task.activeTurnSessionId,
        transcriptCursor: task.activeTurnTranscriptCursor,
      }
    : null
}

function isTaskStreaming(task: Task): boolean {
  return (
    Boolean(task.activeTurnSessionId) &&
    task.turnCompletionState !== 'completed' &&
    task.turnCompletionState !== 'failed'
  )
}

export function useTaskAgentChatV2(taskId: string, task: Task) {
  const taskCheckpointIdentity = useMemo(
    () =>
      task.activeTurnSessionId && typeof task.activeTurnTranscriptCursor === 'number'
        ? {
            sessionId: task.activeTurnSessionId,
            transcriptCursor: task.activeTurnTranscriptCursor,
          }
        : null,
    [task.activeTurnSessionId, task.activeTurnTranscriptCursor],
  )
  const [persistedMessages, setPersistedMessages] = useState<TaskMessage[]>([])
  const [persistedEvents, setPersistedEvents] = useState<TaskEvent[]>([])
  const [pendingMessages, setPendingMessages] = useState<ReturnType<typeof createOptimisticUserMessage>[]>([])
  const [liveState, setLiveState] = useState<CodexGatewayState | null>(null)
  const [liveTurnIdentity, setLiveTurnIdentity] = useState<LiveAssistantMessageIdentity | null>(
    getLiveTurnIdentity(task),
  )
  const [retainedStreamingMessage, setRetainedStreamingMessage] = useState<TaskMessage | null>(null)
  const [activeStream, setActiveStream] = useState<TaskChatV2StreamDescriptor | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [isSending, setIsSending] = useState(false)
  const [isStopping, setIsStopping] = useState(false)
  const eventSourceRef = useRef<EventSource | null>(null)
  const reconnectTimeoutRef = useRef<number | null>(null)
  const reconnectAttemptRef = useRef(0)
  const lastTaskUpdateRef = useRef<string | null>(null)

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimeoutRef.current !== null) {
      window.clearTimeout(reconnectTimeoutRef.current)
      reconnectTimeoutRef.current = null
    }
  }, [])

  const refreshChat = useCallback(
    async (showLoading = true): Promise<boolean> => {
      if (showLoading) {
        setIsLoading(true)
      }

      setError(null)

      try {
        const response = await fetch(`/api/tasks/${taskId}/chat/v2`, {
          cache: 'no-store',
        })
        const data = (await response.json()) as ChatV2BootstrapResponse

        if (!response.ok || !data.success || !data.data) {
          setError(data.error || 'Failed to fetch chat state')
          return false
        }

        startTransition(() => {
          const refreshedLiveTurnIdentity = getLiveTurnIdentity(data.data!.task)

          setPersistedMessages((previousMessages) =>
            areTaskMessagesEqual(previousMessages, data.data!.messages) ? previousMessages : data.data!.messages,
          )
          setPersistedEvents(data.data!.events)
          setPendingMessages((previousMessages) => reconcileOptimisticMessages(previousMessages, data.data!.messages))
          setActiveStream((previousStream) =>
            previousStream?.streamId === data.data!.stream?.streamId ? previousStream : data.data!.stream,
          )
          setLiveTurnIdentity(refreshedLiveTurnIdentity)
          if (!data.data!.stream) {
            setLiveState(null)
          }
          setRetainedStreamingMessage((previousMessage) => {
            if (!previousMessage) {
              return previousMessage
            }

            return data.data!.messages.some(
              (message) => message.role === 'agent' && message.id === previousMessage.id,
            ) ||
              (refreshedLiveTurnIdentity &&
                hasPersistedAssistantIdentity(data.data!.messages, refreshedLiveTurnIdentity))
              ? null
              : previousMessage
          })
        })

        return true
      } catch {
        setError('Failed to fetch chat state')
        return false
      } finally {
        if (showLoading) {
          setIsLoading(false)
        }
      }
    },
    [taskId],
  )

  useEffect(() => {
    void refreshChat(true)
  }, [refreshChat])

  useEffect(() => {
    return () => {
      clearReconnectTimer()
    }
  }, [clearReconnectTimer])

  useEffect(() => {
    if (!liveTurnIdentity && taskCheckpointIdentity) {
      setLiveTurnIdentity(taskCheckpointIdentity)
    }
  }, [liveTurnIdentity, taskCheckpointIdentity])

  useEffect(() => {
    const taskUpdateToken = task.updatedAt ? new Date(task.updatedAt).toISOString() : null
    if (!taskUpdateToken) {
      return
    }

    if (!lastTaskUpdateRef.current) {
      lastTaskUpdateRef.current = taskUpdateToken
      return
    }

    if (lastTaskUpdateRef.current === taskUpdateToken) {
      return
    }

    lastTaskUpdateRef.current = taskUpdateToken

    if (!activeStream && !liveState?.activeTurn) {
      void refreshChat(false)
    }
  }, [activeStream, liveState?.activeTurn, refreshChat, task.updatedAt])

  useEffect(() => {
    const streamUrl = activeStream?.streamUrl
    if (!streamUrl) {
      eventSourceRef.current?.close()
      eventSourceRef.current = null
      return
    }

    const source = new EventSource(streamUrl)
    eventSourceRef.current = source

    source.onopen = () => {
      clearReconnectTimer()
      reconnectAttemptRef.current = 0
    }

    source.addEventListener('state', (event) => {
      const nextState = JSON.parse(event.data) as CodexGatewayState
      const nextIdentity = liveTurnIdentity || taskCheckpointIdentity
      const nextStreamingMessage = buildStreamingAgentMessageFromState(taskId, nextState, nextIdentity)

      startTransition(() => {
        setLiveState(nextState)

        if (nextStreamingMessage) {
          setRetainedStreamingMessage((previousMessage) => {
            if (!previousMessage) {
              return nextStreamingMessage
            }

            return previousMessage.content.length >= nextStreamingMessage.content.length
              ? previousMessage
              : nextStreamingMessage
          })
        }
      })

      if (!nextState.activeTurn && nextState.lastTurnStatus) {
        clearReconnectTimer()
        reconnectAttemptRef.current = 0
        setActiveStream(null)
        setLiveTurnIdentity(null)
        source.close()

        if (eventSourceRef.current === source) {
          eventSourceRef.current = null
        }

        void refreshChat(false)
      }
    })

    source.addEventListener('session-closed', () => {
      clearReconnectTimer()
      reconnectAttemptRef.current = 0
      setActiveStream(null)
      setLiveTurnIdentity(null)
      source.close()

      if (eventSourceRef.current === source) {
        eventSourceRef.current = null
      }

      void refreshChat(false)
    })

    source.onerror = () => {
      if (eventSourceRef.current !== source) {
        return
      }

      clearReconnectTimer()
      source.close()

      if (eventSourceRef.current === source) {
        eventSourceRef.current = null
      }

      const nextAttempt = reconnectAttemptRef.current + 1
      reconnectAttemptRef.current = nextAttempt
      const reconnectDelayMs = Math.min(1000 * nextAttempt, 5000)

      reconnectTimeoutRef.current = window.setTimeout(() => {
        reconnectTimeoutRef.current = null
        void refreshChat(false)
      }, reconnectDelayMs)
    }

    return () => {
      clearReconnectTimer()
      source.close()

      if (eventSourceRef.current === source) {
        eventSourceRef.current = null
      }
    }
  }, [activeStream, clearReconnectTimer, liveTurnIdentity, refreshChat, taskCheckpointIdentity, taskId])

  const sendMessage = useCallback(
    async (content: string): Promise<ChatActionResult> => {
      const trimmedContent = content.trim()
      if (!trimmedContent || isSending) {
        return {
          success: false,
          error: 'Message is required',
        }
      }

      const clientMessageId = buildClientMessageId('chat')
      const optimisticMessage = createOptimisticUserMessage(taskId, trimmedContent, clientMessageId)
      setPendingMessages((previousMessages) => [...previousMessages, optimisticMessage])
      setRetainedStreamingMessage(null)
      setLiveState(null)
      setIsSending(true)

      try {
        const response = await fetch(`/api/tasks/${taskId}/chat/v2`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            clientMessageId,
            prompt: trimmedContent,
          }),
        })

        const data = (await response.json()) as ChatV2TurnResponse
        if (!response.ok || !data.success || !data.data) {
          setPendingMessages((previousMessages) =>
            previousMessages.filter((message) => message.id !== optimisticMessage.id),
          )

          return {
            success: false,
            error: data.error || 'Failed to send message',
          }
        }

        startTransition(() => {
          clearReconnectTimer()
          reconnectAttemptRef.current = 0
          setActiveStream(data.data!.stream)
          setLiveTurnIdentity({
            sessionId: data.data!.session.sessionId,
            transcriptCursor: data.data!.turn.transcriptCursor,
          })
        })

        void refreshChat(false)

        return {
          success: true,
        }
      } catch {
        setPendingMessages((previousMessages) =>
          previousMessages.filter((message) => message.id !== optimisticMessage.id),
        )
        return {
          success: false,
          error: 'Failed to send message',
        }
      } finally {
        setIsSending(false)
      }
    },
    [clearReconnectTimer, isSending, refreshChat, taskId],
  )

  const retryMessage = useCallback(
    async (content: string): Promise<ChatActionResult> => {
      return await sendMessage(content)
    },
    [sendMessage],
  )

  const stopTask = useCallback(async (): Promise<ChatActionResult> => {
    if (!activeStream && !liveState?.activeTurn && !isTaskStreaming(task)) {
      return {
        success: false,
        error: 'Task does not have an active turn',
      }
    }

    setIsStopping(true)

    try {
      const response = await fetch(`/api/tasks/${taskId}/chat/interrupt`, {
        method: 'POST',
      })

      const data = (await response.json()) as {
        error?: string
      }

      if (!response.ok) {
        return {
          success: false,
          error: data.error || 'Failed to stop generation',
        }
      }

      return {
        success: true,
      }
    } catch {
      return {
        success: false,
        error: 'Failed to stop generation',
      }
    } finally {
      setIsStopping(false)
    }
  }, [activeStream, liveState?.activeTurn, task, taskId])

  const streamingMessage = useMemo(
    () => buildStreamingAgentMessage(taskId, liveState, persistedMessages, liveTurnIdentity),
    [liveState, liveTurnIdentity, persistedMessages, taskId],
  )

  const activeStreamingMessage = streamingMessage || retainedStreamingMessage

  const messages = useMemo(
    () => combineChatMessages(persistedMessages, pendingMessages, activeStreamingMessage),
    [activeStreamingMessage, pendingMessages, persistedMessages],
  )

  const activityItems = useMemo(() => {
    const persistedActivityItems = buildAgentActivityItemsFromTaskEvents(persistedEvents)
    const liveActivityItems = buildAgentActivityItemsFromState(liveState)
    const latestByIdentity = new Map<string, TaskAgentActivityItem>()

    for (const item of [...persistedActivityItems, ...liveActivityItems]) {
      const identityKey = `${item.groupKey}|${item.label}|${item.detail}`
      const previousItem = latestByIdentity.get(identityKey)

      if (!previousItem || previousItem.occurredAt.localeCompare(item.occurredAt) <= 0) {
        latestByIdentity.set(identityKey, item)
      }
    }

    return Array.from(latestByIdentity.values()).toSorted((left, right) =>
      left.occurredAt.localeCompare(right.occurredAt),
    )
  }, [liveState, persistedEvents])

  return {
    activityItems: activityItems as TaskAgentActivityItem[],
    error,
    isGatewayTask: true,
    isLoading,
    isSending,
    isStopping,
    isStreaming: Boolean(activeStream || liveState?.activeTurn || isTaskStreaming(task)),
    messages,
    refreshMessages: refreshChat,
    retryMessage,
    sendMessage,
    stopTask,
  }
}
