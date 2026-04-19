'use client'

import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CodexGatewayState } from '@/lib/codex-gateway/types'
import type { Task, TaskMessage } from '@/lib/db/schema'
import {
  areTaskMessagesEqual,
  buildStreamingAgentMessageFromState,
  buildStreamingAgentMessage,
  combineChatMessages,
  createOptimisticUserMessage,
  hasPersistedAssistantContent,
  reconcileOptimisticMessages,
} from '@/lib/task-chat'

interface GatewaySessionRouteResponse {
  success: boolean
  data?: {
    session: {
      sessionId: string
      state: CodexGatewayState
    } | null
  }
  error?: string
}

interface ChatActionResult {
  success: boolean
  error?: string
}

function isTaskProcessing(status: Task['status']): boolean {
  return status === 'processing' || status === 'pending'
}

export function useTaskChatMessages(taskId: string, task: Task) {
  const [persistedMessages, setPersistedMessages] = useState<TaskMessage[]>([])
  const [pendingMessages, setPendingMessages] = useState<ReturnType<typeof createOptimisticUserMessage>[]>([])
  const [gatewayState, setGatewayState] = useState<CodexGatewayState | null>(null)
  const [retainedStreamingMessage, setRetainedStreamingMessage] = useState<TaskMessage | null>(null)
  const [gatewaySessionId, setGatewaySessionId] = useState<string | null>(task.gatewaySessionId)
  const [gatewayTurnPending, setGatewayTurnPending] = useState(
    task.selectedAgent === 'codex' && isTaskProcessing(task.status),
  )
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [isSending, setIsSending] = useState(false)
  const [isStopping, setIsStopping] = useState(false)
  const gatewayEventSourceRef = useRef<EventSource | null>(null)
  const lastTaskUpdateRef = useRef<string | null>(null)
  const persistedMessagesRef = useRef<TaskMessage[]>([])
  const retainedStreamingContentRef = useRef<string | null>(null)
  const isGatewayTask = task.selectedAgent === 'codex'

  useEffect(() => {
    persistedMessagesRef.current = persistedMessages
  }, [persistedMessages])

  useEffect(() => {
    // Keep the latest streamed content available to SSE callbacks without recreating the connection.
    retainedStreamingContentRef.current = retainedStreamingMessage?.content?.trim() || null
  }, [retainedStreamingMessage])

  const refreshMessages = useCallback(
    async (showLoading = true): Promise<boolean> => {
      if (showLoading) {
        setIsLoading(true)
      }

      setError(null)

      try {
        const response = await fetch(`/api/tasks/${taskId}/messages`, {
          cache: 'no-store',
        })
        const data = (await response.json()) as {
          success?: boolean
          messages?: TaskMessage[]
          error?: string
        }

        if (!response.ok || !data.success || !data.messages) {
          setError(data.error || 'Failed to fetch messages')
          return false
        }

        startTransition(() => {
          setPersistedMessages((previousMessages) =>
            areTaskMessagesEqual(previousMessages, data.messages as TaskMessage[]) ? previousMessages : data.messages!,
          )
          setPendingMessages((previousMessages) => reconcileOptimisticMessages(previousMessages, data.messages!))
          setRetainedStreamingMessage((previousMessage) => {
            if (!previousMessage) {
              return previousMessage
            }

            return hasPersistedAssistantContent(data.messages!, previousMessage.content) ? null : previousMessage
          })
        })

        return true
      } catch {
        setError('Failed to fetch messages')
        return false
      } finally {
        if (showLoading) {
          setIsLoading(false)
        }
      }
    },
    [taskId],
  )

  const syncFinalMessages = useCallback(
    async (expectedContent?: string | null) => {
      const normalizedExpectedContent = expectedContent?.trim() || null
      if (!normalizedExpectedContent) {
        void refreshMessages(false)
        return
      }

      for (let attempt = 0; attempt < 10; attempt += 1) {
        const refreshed = await refreshMessages(false)
        if (!refreshed) {
          await new Promise((resolve) => window.setTimeout(resolve, 400))
          continue
        }

        if (hasPersistedAssistantContent(persistedMessagesRef.current, normalizedExpectedContent)) {
          return
        }

        await new Promise((resolve) => window.setTimeout(resolve, attempt < 4 ? 300 : 700))
      }
    },
    [refreshMessages],
  )

  const refreshGatewaySession = useCallback(async (): Promise<boolean> => {
    if (!isGatewayTask) {
      return false
    }

    try {
      const response = await fetch(`/api/tasks/${taskId}/gateway/session`, {
        cache: 'no-store',
      })

      if (!response.ok) {
        return false
      }

      const data = (await response.json()) as GatewaySessionRouteResponse
      const sessionData = data.data?.session
      if (!sessionData) {
        return false
      }

      startTransition(() => {
        setGatewaySessionId(sessionData.sessionId)
        setGatewayState(sessionData.state)
      })

      return true
    } catch {
      return false
    }
  }, [isGatewayTask, taskId])

  useEffect(() => {
    void refreshMessages(true)
  }, [refreshMessages])

  useEffect(() => {
    setGatewaySessionId(task.gatewaySessionId)
  }, [task.gatewaySessionId])

  useEffect(() => {
    if (!isGatewayTask) {
      setGatewayTurnPending(false)
      setGatewaySessionId(null)
      setGatewayState(null)
      return
    }

    setGatewayTurnPending(isTaskProcessing(task.status))
  }, [isGatewayTask, task.status])

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

    const hasActiveStream = gatewayState?.activeTurn || gatewayTurnPending
    if (!hasActiveStream) {
      void refreshMessages(false)
    }
  }, [gatewayState?.activeTurn, gatewayTurnPending, refreshMessages, task.updatedAt])

  useEffect(() => {
    if (!isGatewayTask || gatewaySessionId || (!isTaskProcessing(task.status) && !gatewayTurnPending)) {
      return
    }

    let cancelled = false

    const pollGatewaySession = async () => {
      const found = await refreshGatewaySession()
      if (found || cancelled) {
        return
      }

      window.setTimeout(() => {
        if (!cancelled) {
          void pollGatewaySession()
        }
      }, 500)
    }

    void pollGatewaySession()

    return () => {
      cancelled = true
    }
  }, [gatewaySessionId, gatewayTurnPending, isGatewayTask, refreshGatewaySession, task.status])

  useEffect(() => {
    const shouldConnect =
      isGatewayTask && Boolean(gatewaySessionId) && (isTaskProcessing(task.status) || gatewayTurnPending)

    if (!shouldConnect) {
      gatewayEventSourceRef.current?.close()
      gatewayEventSourceRef.current = null
      return
    }

    const source = new EventSource(`/api/tasks/${taskId}/gateway/events`)
    gatewayEventSourceRef.current = source

    source.addEventListener('state', (event) => {
      const nextState = JSON.parse(event.data) as CodexGatewayState
      const finalStreamingMessage = buildStreamingAgentMessageFromState(taskId, nextState)

      startTransition(() => {
        setGatewayState(nextState)

        if (finalStreamingMessage) {
          setRetainedStreamingMessage((previousMessage) => {
            if (!previousMessage) {
              return finalStreamingMessage
            }

            return previousMessage.content.length >= finalStreamingMessage.content.length
              ? previousMessage
              : finalStreamingMessage
          })
        }
      })

      if (!nextState.activeTurn && nextState.lastTurnStatus) {
        setGatewayTurnPending(false)
        source.close()

        if (gatewayEventSourceRef.current === source) {
          gatewayEventSourceRef.current = null
        }

        void syncFinalMessages(finalStreamingMessage?.content)
      }
    })

    source.addEventListener('session-closed', () => {
      startTransition(() => {
        setGatewayTurnPending(false)
        setGatewaySessionId(null)
      })

      source.close()

      if (gatewayEventSourceRef.current === source) {
        gatewayEventSourceRef.current = null
      }

      void syncFinalMessages(retainedStreamingContentRef.current)
    })

    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED && gatewayEventSourceRef.current === source) {
        gatewayEventSourceRef.current = null
      }
    }

    return () => {
      source.close()

      if (gatewayEventSourceRef.current === source) {
        gatewayEventSourceRef.current = null
      }
    }
  }, [gatewaySessionId, gatewayTurnPending, isGatewayTask, refreshMessages, syncFinalMessages, task.status, taskId])

  const sendMessage = useCallback(
    async (content: string): Promise<ChatActionResult> => {
      const trimmedContent = content.trim()
      if (!trimmedContent || isSending) {
        return {
          success: false,
          error: 'Message is required',
        }
      }

      const optimisticMessage = createOptimisticUserMessage(taskId, trimmedContent)
      setPendingMessages((previousMessages) => [...previousMessages, optimisticMessage])
      setIsSending(true)

      try {
        const response = await fetch(`/api/tasks/${taskId}/continue`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            message: trimmedContent,
          }),
        })

        const data = (await response.json()) as {
          error?: string
        }

        if (!response.ok) {
          setPendingMessages((previousMessages) =>
            previousMessages.filter((message) => message.id !== optimisticMessage.id),
          )

          return {
            success: false,
            error: data.error || 'Failed to send message',
          }
        }

        startTransition(() => {
          setGatewayTurnPending(isGatewayTask)
        })

        void refreshMessages(false)
        if (isGatewayTask) {
          void refreshGatewaySession()
        }

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
    [isGatewayTask, isSending, refreshGatewaySession, refreshMessages, taskId],
  )

  const retryMessage = useCallback(
    async (content: string): Promise<ChatActionResult> => {
      return await sendMessage(content)
    },
    [sendMessage],
  )

  const stopTask = useCallback(async (): Promise<ChatActionResult> => {
    setIsStopping(true)

    try {
      const response = await fetch(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ action: 'stop' }),
      })

      if (!response.ok) {
        const data = (await response.json()) as {
          error?: string
        }

        return {
          success: false,
          error: data.error || 'Failed to stop task',
        }
      }

      startTransition(() => {
        setGatewayTurnPending(false)
        setGatewaySessionId(null)
        setGatewayState(null)
      })
      gatewayEventSourceRef.current?.close()
      gatewayEventSourceRef.current = null

      return {
        success: true,
      }
    } catch {
      return {
        success: false,
        error: 'Failed to stop task',
      }
    } finally {
      setIsStopping(false)
    }
  }, [taskId])

  const streamingMessage = useMemo(
    () => buildStreamingAgentMessage(taskId, gatewayState, persistedMessages),
    [gatewayState, persistedMessages, taskId],
  )

  const activeStreamingMessage = streamingMessage || retainedStreamingMessage

  const messages = useMemo(
    () => combineChatMessages(persistedMessages, pendingMessages, activeStreamingMessage),
    [activeStreamingMessage, pendingMessages, persistedMessages],
  )

  return {
    error,
    isGatewayTask,
    isLoading,
    isSending,
    isStopping,
    isStreaming: Boolean(gatewayState?.activeTurn || gatewayTurnPending),
    messages,
    refreshMessages,
    retryMessage,
    sendMessage,
    stopTask,
  }
}
