'use client'

import { memo, useCallback } from 'react'
import { ArrowUp, Loader2, Square } from 'lucide-react'
import { Textarea } from '@/components/ui/textarea'

interface TaskChatComposerProps {
  disabled?: boolean
  isProcessing: boolean
  isSending: boolean
  isStopping: boolean
  onSend: () => void
  onStop: () => void
  setValue: (value: string) => void
  value: string
}

export const TaskChatComposer = memo(function TaskChatComposer({
  disabled = false,
  isProcessing,
  isSending,
  isStopping,
  onSend,
  onStop,
  setValue,
  value,
}: TaskChatComposerProps) {
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        onSend()
      }
    },
    [onSend],
  )

  return (
    <div className="flex-shrink-0 px-3 pb-3">
      <div className="relative">
        <Textarea
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Send a follow-up message..."
          className="w-full min-h-[72px] max-h-[160px] resize-none pr-12 text-base md:text-sm"
          disabled={disabled || isSending}
        />
        {isProcessing ? (
          <button
            onClick={onStop}
            disabled={isStopping}
            className="absolute bottom-2 right-2 flex h-8 w-8 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            type="button"
          >
            {isStopping ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Square className="h-3.5 w-3.5" fill="currentColor" />
            )}
          </button>
        ) : (
          <button
            onClick={onSend}
            disabled={!value.trim() || isSending || disabled}
            className="absolute bottom-2 right-2 flex h-8 w-8 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            type="button"
          >
            {isSending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
          </button>
        )}
      </div>
    </div>
  )
})
