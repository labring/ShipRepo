'use client'

import { memo } from 'react'
import { AlertCircle, CheckCircle2, Loader2, ShieldAlert } from 'lucide-react'
import type { TaskAgentActivityItem } from '@/lib/task-agent-events'
import { cn } from '@/lib/utils'

interface TaskAgentActivityProps {
  isStreaming: boolean
  items: TaskAgentActivityItem[]
}

function getToneIcon(tone: TaskAgentActivityItem['tone']) {
  if (tone === 'success') {
    return <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />
  }

  if (tone === 'error') {
    return <AlertCircle className="h-3.5 w-3.5 text-red-500" />
  }

  if (tone === 'warning') {
    return <ShieldAlert className="h-3.5 w-3.5 text-amber-500" />
  }

  return <Loader2 className="h-3.5 w-3.5 text-muted-foreground" />
}

export const TaskAgentActivity = memo(function TaskAgentActivity({ isStreaming, items }: TaskAgentActivityProps) {
  const visibleItems = items.slice(-8).toReversed()

  if (visibleItems.length === 0) {
    return null
  }

  return (
    <div className="rounded-2xl border bg-muted/20 px-4 py-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Agent Activity</div>
        {isStreaming ? (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            Live
          </div>
        ) : null}
      </div>
      <div className="space-y-2">
        {visibleItems.map((item) => (
          <div key={item.id} className="flex items-start gap-2 text-sm">
            <div className="mt-0.5 flex-shrink-0">{getToneIcon(item.tone)}</div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate font-medium">{item.label}</span>
                <span className="text-[11px] text-muted-foreground">
                  {new Date(item.occurredAt).toLocaleTimeString()}
                </span>
              </div>
              {item.detail ? (
                <div
                  className={cn(
                    'truncate text-xs text-muted-foreground',
                    item.tone === 'error' && 'text-red-500/80',
                    item.tone === 'warning' && 'text-amber-600/80',
                  )}
                >
                  {item.detail}
                </div>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
})
