'use client'

import { memo, useDeferredValue, useEffect, useMemo, useRef } from 'react'
import { Check, Copy, Loader2, RotateCcw } from 'lucide-react'
import type { LogEntry, Task } from '@/lib/db/schema'
import type { ChatTaskMessage } from '@/lib/task-chat'
import { buildChatTurns, parseTaskAgentMessage } from '@/lib/task-chat'
import { TaskChatMarkdown } from '@/components/task-chat-markdown'
import { cn } from '@/lib/utils'

interface TaskChatTranscriptProps {
  copiedMessageId: string | null
  isGatewayTask: boolean
  logs: LogEntry[]
  messages: ChatTaskMessage[]
  onCopyMessage: (messageId: string, content: string) => void
  onRetryMessage: (content: string) => void
  status: Task['status']
}

function isTaskProcessing(status: Task['status']): boolean {
  return status === 'processing' || status === 'pending'
}

export const TaskChatTranscript = memo(function TaskChatTranscript({
  copiedMessageId,
  isGatewayTask,
  logs,
  messages,
  onCopyMessage,
  onRetryMessage,
  status,
}: TaskChatTranscriptProps) {
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const wasAtBottomRef = useRef(true)
  const deferredMessages = useDeferredValue(messages)
  const turns = useMemo(() => buildChatTurns(deferredMessages), [deferredMessages])
  const isProcessing = isTaskProcessing(status)

  const visibleLogs = useMemo(() => logs.filter((entry) => !entry.message.startsWith('[SERVER]')).slice(-6), [logs])

  const messageSignature = useMemo(
    () => messages.map((message) => `${message.id}:${message.role}:${message.content.length}`).join('|'),
    [messages],
  )

  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container) {
      return
    }

    const handleScroll = () => {
      const threshold = 120
      const position = container.scrollTop + container.clientHeight
      wasAtBottomRef.current = position >= container.scrollHeight - threshold
    }

    handleScroll()
    container.addEventListener('scroll', handleScroll, { passive: true })

    return () => {
      container.removeEventListener('scroll', handleScroll)
    }
  }, [])

  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container || !wasAtBottomRef.current) {
      return
    }

    const animationFrameId = window.requestAnimationFrame(() => {
      container.scrollTop = container.scrollHeight
    })

    return () => {
      window.cancelAnimationFrame(animationFrameId)
    }
  }, [messageSignature])

  if (turns.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-center text-muted-foreground">
        <div className="text-sm md:text-base">No messages yet</div>
      </div>
    )
  }

  return (
    <div ref={scrollContainerRef} className="flex-1 overflow-y-auto pb-4">
      <div className="space-y-6 px-1">
        {turns.map((turn, index) => {
          const isLastTurn = index === turns.length - 1
          const showWaitingState = isLastTurn && isProcessing && turn.agentMessages.length === 0
          const showSetupLogs = showWaitingState && index === 0 && visibleLogs.length > 0

          return (
            <section key={turn.id} className="[contain-intrinsic-size:480px] space-y-3 [content-visibility:auto]">
              {turn.userMessage ? (
                <div className="flex justify-end">
                  <div className="max-w-[90%] space-y-2 md:max-w-[82%]">
                    <div className="rounded-2xl rounded-br-md bg-primary px-4 py-3 text-primary-foreground shadow-sm">
                      <TaskChatMarkdown content={turn.userMessage.content} tone="inverse" />
                    </div>
                    <div className="flex items-center justify-end gap-1 px-1 text-muted-foreground">
                      <button
                        type="button"
                        onClick={() => onRetryMessage(turn.userMessage!.content)}
                        className="flex h-6 w-6 items-center justify-center rounded-full transition-colors hover:bg-muted"
                        title="Retry message"
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => onCopyMessage(turn.userMessage!.id, turn.userMessage!.content)}
                        className="flex h-6 w-6 items-center justify-center rounded-full transition-colors hover:bg-muted"
                        title="Copy message"
                      >
                        {copiedMessageId === turn.userMessage.id ? (
                          <Check className="h-3.5 w-3.5" />
                        ) : (
                          <Copy className="h-3.5 w-3.5" />
                        )}
                      </button>
                    </div>
                  </div>
                </div>
              ) : null}

              {turn.agentMessages.map((message) => {
                const content = parseTaskAgentMessage(message.content).trim()
                const isStreamingMessage = message.id.startsWith('gateway-stream-')

                return (
                  <div key={message.id} className="flex justify-start">
                    <div className="max-w-[92%] space-y-2 md:max-w-[84%]">
                      <div
                        className={cn(
                          'rounded-2xl rounded-bl-md border bg-card px-4 py-3 shadow-sm',
                          isStreamingMessage && 'border-primary/40',
                        )}
                      >
                        {content ? (
                          <TaskChatMarkdown content={content} />
                        ) : (
                          <div className="flex items-center gap-2 text-sm text-muted-foreground">
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            Generating response...
                          </div>
                        )}
                      </div>
                      <div className="flex items-center gap-1 px-1 text-muted-foreground">
                        <button
                          type="button"
                          onClick={() => onCopyMessage(message.id, content || message.content)}
                          className="flex h-6 w-6 items-center justify-center rounded-full transition-colors hover:bg-muted"
                          title="Copy response"
                        >
                          {copiedMessageId === message.id ? (
                            <Check className="h-3.5 w-3.5" />
                          ) : (
                            <Copy className="h-3.5 w-3.5" />
                          )}
                        </button>
                      </div>
                    </div>
                  </div>
                )
              })}

              {showWaitingState ? (
                <div className="flex justify-start">
                  <div className="max-w-[92%] rounded-2xl rounded-bl-md border border-dashed bg-muted/30 px-4 py-3 text-sm text-muted-foreground md:max-w-[84%]">
                    <div className="flex items-center gap-2">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      {showSetupLogs ? (
                        <span>{isGatewayTask ? 'Connecting to Codex gateway...' : 'Preparing runtime...'}</span>
                      ) : (
                        <span>Awaiting response...</span>
                      )}
                    </div>
                    {showSetupLogs ? (
                      <div className="mt-3 space-y-1.5 border-l pl-3">
                        {visibleLogs.map((entry, entryIndex) => (
                          <div
                            key={`${entry.message}-${entryIndex}`}
                            className={cn(
                              'truncate text-xs',
                              entry.type === 'error'
                                ? 'text-red-500/80'
                                : entry.type === 'success'
                                  ? 'text-green-600/80'
                                  : 'text-muted-foreground',
                            )}
                          >
                            {entry.message}
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </section>
          )
        })}
      </div>
    </div>
  )
})
