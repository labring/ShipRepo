'use client'

import { memo, useMemo } from 'react'
import { AlertCircle, CheckCircle2, Loader2, ShieldAlert } from 'lucide-react'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
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
  const visibleItems = useMemo(() => {
    const recentItems = [...items].toSorted((left, right) => left.occurredAt.localeCompare(right.occurredAt)).slice(-12)
    const latestByGroup = new Map<string, TaskAgentActivityItem>()

    for (const item of recentItems) {
      latestByGroup.set(item.groupKey, item)
    }

    return Array.from(latestByGroup.values())
      .toSorted((left, right) => right.occurredAt.localeCompare(left.occurredAt))
      .slice(0, 4)
  }, [items])

  const latestItem = visibleItems[0]

  if (!latestItem && !isStreaming) {
    return null
  }

  const summaryLabel = latestItem?.label || 'Preparing response'
  const summaryDetail = latestItem?.detail || (isStreaming ? 'Agent is working on the next reply' : 'Recent activity')
  const summaryTone = latestItem?.tone || 'default'

  if (visibleItems.length === 0) {
    return (
      <div className="rounded-2xl border bg-muted/10 px-3 py-2.5">
        <div className="flex items-center gap-2">
          <div className="flex-shrink-0">{getToneIcon(summaryTone)}</div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{summaryLabel}</div>
            <div className="truncate text-xs text-muted-foreground">{summaryDetail}</div>
          </div>
          {isStreaming ? (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              Live
            </div>
          ) : null}
        </div>
      </div>
    )
  }

  return (
    <Accordion type="single" collapsible className="rounded-2xl border bg-muted/10">
      <AccordionItem value="activity" className="border-none">
        <AccordionTrigger className="items-center px-3 py-2.5 hover:no-underline">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <div className="mt-0.5 flex-shrink-0">{getToneIcon(summaryTone)}</div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{summaryLabel}</div>
              <div className="truncate text-xs text-muted-foreground">{summaryDetail}</div>
            </div>
            {isStreaming ? (
              <div className="flex flex-shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                Live
              </div>
            ) : null}
          </div>
        </AccordionTrigger>
        <AccordionContent className="border-t px-3 pb-3">
          <div className="space-y-2 pt-3">
            {visibleItems.map((item) => (
              <div key={item.id} className="flex items-start gap-2 text-sm">
                <div className="mt-0.5 flex-shrink-0">{getToneIcon(item.tone)}</div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{item.label}</span>
                    <span className="text-[11px] text-muted-foreground">
                      {new Date(item.occurredAt).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
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
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  )
})
