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

interface ChatRuntimeRouteResponse {
  success: boolean
  data?: {
    runtime: {
      status: Task['status']
      runtimeName: Task['runtimeName']
      runtimeState: Task['runtimeState']
      workspacePreparedAt: Task['workspacePreparedAt']
      runtimeCheckedAt: Task['runtimeCheckedAt']
      gatewayReadyAt: Task['gatewayReadyAt']
      gatewaySessionId: string | null
      turnCompletionState: Task['turnCompletionState']
    }
    session: {
      sessionId: string
      state: CodexGatewayState
    } | null
    stream: {
      streamTicket: string
      streamUrl: string
    } | null
  }
  error?: string
}

interface ChatActionResult {
  success: boolean
  error?: string
}

interface ChatTurnRouteResponse {
  success: boolean
  data?: {
    session?: {
      sessionId: string
    }
    stream?: {
      streamTicket: string
      streamUrl: string
    }
    turn?: {
      transcriptCursor: number
      turnAccepted: boolean
      turnStartedAt: string
      streamUrl: string
    }
  }
  error?: string
}

function isTaskProcessing(status: Task['status']): boolean {
  return status === 'processing' || status === 'pending'
}

function shouldPrewarmGatewayTask(task: Task, gatewaySessionId: string | null): boolean {
  if (task.selectedAgent !== 'codex' || gatewaySessionId) {
    return false
  }

  if (
    task.activeTurnSessionId &&
    task.turnCompletionState &&
    task.turnCompletionState !== 'completed' &&
    task.turnCompletionState !== 'failed'
  ) {
    return false
  }

  return !task.runtimeName || task.runtimeState !== 'Running' || !task.workspacePreparedAt || !task.gatewaySessionId
}

export function useTaskChatMessages(taskId: string, task: Task) {
  const [persistedMessages, setPersistedMessages] = useState<TaskMessage[]>([])
  const [pendingMessages, setPendingMessages] = useState<ReturnType<typeof createOptimisticUserMessage>[]>([])
  const [gatewayState, setGatewayState] = useState<CodexGatewayState | null>(null)
  const [retainedStreamingMessage, setRetainedStreamingMessage] = useState<TaskMessage | null>(null)
  const [gatewaySessionId, setGatewaySessionId] = useState<string | null>(task.gatewaySessionId)
  const [gatewayStreamUrl, setGatewayStreamUrl] = useState<string | null>(null)
  const [gatewayTurnPending, setGatewayTurnPending] = useState(
    task.selectedAgent === 'codex' && isTaskProcessing(task.status),
  )
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [isSending, setIsSending] = useState(false)
  const [isStopping, setIsStopping] = useState(false)
  const gatewayEventSourceRef = useRef<EventSource | null>(null)
  const gatewayReconnectTimeoutRef = useRef<number | null>(null)
  const gatewayReconnectAttemptRef = useRef(0)
  const lastTaskUpdateRef = useRef<string | null>(null)
  const lastPrewarmTokenRef = useRef<string | null>(null)
  const persistedMessagesRef = useRef<TaskMessage[]>([])
  const retainedStreamingContentRef = useRef<string | null>(null)
  const isGatewayTask = task.selectedAgent === 'codex'

  const applyGatewayRuntimeSnapshot = useCallback((data?: ChatRuntimeRouteResponse['data']) => {
    if (!data) {
      return false
    }

    startTransition(() => {
      setGatewaySessionId(data.session?.sessionId || data.runtime.gatewaySessionId || null)
      setGatewayState(data.session?.state || null)
      setGatewayStreamUrl(data.stream?.streamUrl || null)

      if (data.session?.state.activeTurn) {
        setGatewayTurnPending(true)
      } else if (!isTaskProcessing(data.runtime.status)) {
        setGatewayTurnPending(false)
      }
    })

    return Boolean(data.session)
  }, [])

  useEffect(() => {
    persistedMessagesRef.current = persistedMessages
  }, [persistedMessages])

  useEffect(() => {
    // Keep the latest streamed content available to SSE callbacks without recreating the connection.
    retainedStreamingContentRef.current = retainedStreamingMessage?.content?.trim() || null
  }, [retainedStreamingMessage])

  const clearGatewayReconnectTimer = useCallback(() => {
    if (gatewayReconnectTimeoutRef.current !== null) {
      window.clearTimeout(gatewayReconnectTimeoutRef.current)
      gatewayReconnectTimeoutRef.current = null
    }
  }, [])

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

  const refreshChatRuntime = useCallback(async (): Promise<boolean> => {
    if (!isGatewayTask) {
      return false
    }

    try {
      const response = await fetch(`/api/tasks/${taskId}/chat/runtime`, {
        cache: 'no-store',
      })

      if (!response.ok) {
        return false
      }

      const data = (await response.json()) as ChatRuntimeRouteResponse
      return applyGatewayRuntimeSnapshot(data.data)
    } catch {
      return false
    }
  }, [applyGatewayRuntimeSnapshot, isGatewayTask, taskId])

  const prewarmChatRuntime = useCallback(async (): Promise<boolean> => {
    if (!isGatewayTask) {
      return false
    }

    try {
      const response = await fetch(`/api/tasks/${taskId}/chat/prewarm`, {
        method: 'POST',
      })

      if (!response.ok) {
        return false
      }

      const data = (await response.json()) as ChatRuntimeRouteResponse
      return applyGatewayRuntimeSnapshot(data.data)
    } catch {
      return false
    }
  }, [applyGatewayRuntimeSnapshot, isGatewayTask, taskId])

  useEffect(() => {
    void refreshMessages(true)
  }, [refreshMessages])

  useEffect(() => {
    return () => {
      clearGatewayReconnectTimer()
    }
  }, [clearGatewayReconnectTimer])

  useEffect(() => {
    if (!isGatewayTask) {
      setGatewaySessionId(null)
      setGatewayStreamUrl(null)
      return
    }

    if (task.gatewaySessionId) {
      setGatewaySessionId((previousSessionId) => previousSessionId || task.gatewaySessionId)
      return
    }

    if (!isTaskProcessing(task.status)) {
      setGatewaySessionId(null)
      setGatewayStreamUrl(null)
    }
  }, [isGatewayTask, task.gatewaySessionId, task.status])

  useEffect(() => {
    if (!isGatewayTask) {
      setGatewayTurnPending(false)
      setGatewaySessionId(null)
      setGatewayStreamUrl(null)
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
    if (!isGatewayTask) {
      return
    }

    if (gatewaySessionId || gatewayTurnPending || task.gatewaySessionId) {
      void refreshChatRuntime()
    }
  }, [gatewaySessionId, gatewayTurnPending, isGatewayTask, refreshChatRuntime, task.gatewaySessionId])

  useEffect(() => {
    const prewarmToken = [
      task.runtimeName || '',
      task.runtimeState || '',
      task.workspacePreparedAt ? new Date(task.workspacePreparedAt).toISOString() : '',
      task.gatewaySessionId || '',
      gatewaySessionId || '',
    ].join('|')

    if (!shouldPrewarmGatewayTask(task, gatewaySessionId) || lastPrewarmTokenRef.current === prewarmToken) {
      return
    }

    lastPrewarmTokenRef.current = prewarmToken
    void prewarmChatRuntime()
  }, [gatewaySessionId, prewarmChatRuntime, task])

  useEffect(() => {
    const shouldConnect =
      isGatewayTask && Boolean(gatewayStreamUrl) && (isTaskProcessing(task.status) || gatewayTurnPending)

    if (!shouldConnect) {
      gatewayEventSourceRef.current?.close()
      gatewayEventSourceRef.current = null
      return
    }

    const source = new EventSource(gatewayStreamUrl!)
    gatewayEventSourceRef.current = source
    source.onopen = () => {
      clearGatewayReconnectTimer()
      gatewayReconnectAttemptRef.current = 0
    }

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
        clearGatewayReconnectTimer()
        gatewayReconnectAttemptRef.current = 0
        setGatewayTurnPending(false)
        setGatewayStreamUrl(null)
        source.close()

        if (gatewayEventSourceRef.current === source) {
          gatewayEventSourceRef.current = null
        }

        void syncFinalMessages(finalStreamingMessage?.content)
      }
    })

    source.addEventListener('session-closed', () => {
      clearGatewayReconnectTimer()
      gatewayReconnectAttemptRef.current = 0
      startTransition(() => {
        setGatewayTurnPending(false)
        setGatewaySessionId(null)
        setGatewayStreamUrl(null)
      })

      source.close()

      if (gatewayEventSourceRef.current === source) {
        gatewayEventSourceRef.current = null
      }

      void syncFinalMessages(retainedStreamingContentRef.current)
    })

    source.onerror = () => {
      if (gatewayEventSourceRef.current !== source) {
        return
      }

      if (!isTaskProcessing(task.status) && !gatewayTurnPending) {
        if (source.readyState === EventSource.CLOSED) {
          gatewayEventSourceRef.current = null
        }

        return
      }

      clearGatewayReconnectTimer()
      source.close()

      if (gatewayEventSourceRef.current === source) {
        gatewayEventSourceRef.current = null
      }

      const nextAttempt = gatewayReconnectAttemptRef.current + 1
      gatewayReconnectAttemptRef.current = nextAttempt
      const reconnectDelayMs = Math.min(1000 * nextAttempt, 5000)

      gatewayReconnectTimeoutRef.current = window.setTimeout(() => {
        gatewayReconnectTimeoutRef.current = null
        void refreshChatRuntime()
      }, reconnectDelayMs)
    }

    return () => {
      clearGatewayReconnectTimer()
      source.close()

      if (gatewayEventSourceRef.current === source) {
        gatewayEventSourceRef.current = null
      }
    }
  }, [
    clearGatewayReconnectTimer,
    gatewayStreamUrl,
    gatewayTurnPending,
    isGatewayTask,
    refreshMessages,
    refreshChatRuntime,
    syncFinalMessages,
    task.status,
    taskId,
  ])

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
        const response = await fetch(
          isGatewayTask ? `/api/tasks/${taskId}/chat/turn` : `/api/tasks/${taskId}/continue`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              ...(isGatewayTask ? { prompt: trimmedContent } : { message: trimmedContent }),
            }),
          },
        )

        const data = (await response.json()) as ChatTurnRouteResponse & {
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

          if (isGatewayTask) {
            clearGatewayReconnectTimer()
            gatewayReconnectAttemptRef.current = 0
            setGatewaySessionId(data.data?.session?.sessionId || null)
            setGatewayState(null)
            setGatewayStreamUrl(data.data?.stream?.streamUrl || data.data?.turn?.streamUrl || null)
          }
        })

        void refreshMessages(false)

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
    [clearGatewayReconnectTimer, isGatewayTask, isSending, refreshMessages, taskId],
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
        clearGatewayReconnectTimer()
        gatewayReconnectAttemptRef.current = 0
        setGatewayTurnPending(false)
        setGatewaySessionId(null)
        setGatewayStreamUrl(null)
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
  }, [clearGatewayReconnectTimer, taskId])

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
