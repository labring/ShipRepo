import type { CodexGatewayState, CodexGatewaySummaryEvent } from '@/lib/codex-gateway/types'
import type { TaskEvent } from '@/lib/db/schema'

export interface TaskAgentActivityItem {
  detail: string
  groupKey: string
  id: string
  label: string
  occurredAt: string
  tone: 'default' | 'error' | 'success' | 'warning'
}

interface ActivitySummaryInput {
  itemType?: string | null
  method?: string | null
  status?: string | null
  textPreview?: string | null
}

function getToneFromStatus(status: string | null | undefined): TaskAgentActivityItem['tone'] {
  if (!status) {
    return 'default'
  }

  if (status === 'completed' || status === 'succeeded' || status === 'approved') {
    return 'success'
  }

  if (status === 'failed' || status === 'decline' || status === 'error') {
    return 'error'
  }

  if (status === 'interruptRequested' || status === 'interrupted' || status === 'warning') {
    return 'warning'
  }

  return 'default'
}

function normalizeDateValue(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString()
  }

  if (typeof value === 'string' && value.trim()) {
    const parsedDate = new Date(value)
    if (!Number.isNaN(parsedDate.getTime())) {
      return parsedDate.toISOString()
    }
  }

  return null
}

function getEventOccurredAt(value: unknown): string {
  return normalizeDateValue(value) || new Date(0).toISOString()
}

function normalizeOccurredAt(value: unknown, fallbackDate: unknown): string {
  return normalizeDateValue(value) || getEventOccurredAt(fallbackDate)
}

function normalizePreview(value: string | null | undefined): string {
  return value?.replace(/\s+/g, ' ').trim() || ''
}

function humanizeIdentifier(value: string | null | undefined): string {
  if (!value) {
    return 'Activity'
  }

  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[/-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\w/, (char) => char.toUpperCase())
}

function buildLifecycleItem(
  action: 'started' | 'completed',
  itemType: string | null | undefined,
  textPreview: string | null | undefined,
  status: string | null | undefined,
): Omit<TaskAgentActivityItem, 'id' | 'occurredAt'> | null {
  const preview = normalizePreview(textPreview)
  const tone = action === 'completed' ? getToneFromStatus(status) : 'default'

  if (itemType === 'agentMessage' || itemType === 'userMessage') {
    return null
  }

  if (itemType === 'commandExecution') {
    return {
      groupKey: 'command',
      label: action === 'completed' ? 'Command finished' : 'Running command',
      detail: preview || (action === 'completed' ? 'Shell command finished' : 'Executing shell command'),
      tone,
    }
  }

  if (itemType === 'fileChange') {
    return {
      groupKey: 'files',
      label: action === 'completed' ? 'Files updated' : 'Updating files',
      detail: preview || (action === 'completed' ? 'Workspace changes are ready' : 'Preparing workspace changes'),
      tone,
    }
  }

  if (itemType === 'reasoning') {
    return {
      groupKey: 'reasoning',
      label: action === 'completed' ? 'Analysis complete' : 'Analyzing task',
      detail: preview || (action === 'completed' ? 'Planning finished' : 'Thinking through the next step'),
      tone,
    }
  }

  const readableType = humanizeIdentifier(itemType)

  return {
    groupKey: itemType || 'activity',
    label: action === 'completed' ? `${readableType} finished` : `${readableType} in progress`,
    detail: preview || (action === 'completed' ? 'Step completed' : 'Working on the next step'),
    tone,
  }
}

function buildSummaryItemCopy(input: ActivitySummaryInput): Omit<TaskAgentActivityItem, 'id' | 'occurredAt'> | null {
  const preview = normalizePreview(input.textPreview)

  switch (input.method) {
    case 'thread/started':
    case 'thread/status/changed':
    case 'item/agentMessage/delta':
      return null
    case 'turn/started':
      return {
        groupKey: 'turn',
        label: 'Preparing response',
        detail: 'Agent is working on the next reply',
        tone: 'default',
      }
    case 'turn/completed':
      return {
        groupKey: 'turn',
        label: 'Response complete',
        detail: 'Latest reply is ready',
        tone: 'success',
      }
    case 'item/started':
      return buildLifecycleItem('started', input.itemType, preview, input.status)
    case 'item/completed':
      return buildLifecycleItem('completed', input.itemType, preview, input.status)
    case 'error':
      return {
        groupKey: 'error',
        label: 'Error',
        detail: preview || 'Something went wrong',
        tone: 'error',
      }
  }

  if (input.method?.includes('requestApproval')) {
    const isCommandApproval = input.method.includes('commandExecution')

    return {
      groupKey: isCommandApproval ? 'approval-command' : 'approval-files',
      label: isCommandApproval ? 'Command approved' : 'File changes approved',
      detail: preview || (isCommandApproval ? 'Approval was handled automatically' : 'Changes were approved'),
      tone: 'success',
    }
  }

  if (input.itemType) {
    return buildLifecycleItem('started', input.itemType, preview, input.status)
  }

  if (preview) {
    return {
      groupKey: input.method || 'activity',
      label: humanizeIdentifier(input.method || 'activity'),
      detail: preview,
      tone: getToneFromStatus(input.status),
    }
  }

  return null
}

function buildSummaryEventItem(summaryEvent: CodexGatewaySummaryEvent, index: number): TaskAgentActivityItem | null {
  const copy = buildSummaryItemCopy(summaryEvent)

  if (!copy) {
    return null
  }

  const occurredAt =
    typeof summaryEvent.at === 'string' && summaryEvent.at.trim() ? summaryEvent.at : new Date(0).toISOString()

  return {
    id: `summary-${occurredAt}-${summaryEvent.method || summaryEvent.type || index}-${summaryEvent.itemId || index}`,
    occurredAt,
    ...copy,
  }
}

function buildTaskEventItem(event: TaskEvent): TaskAgentActivityItem | null {
  if (event.kind === 'gateway.warning') {
    return {
      id: event.id,
      groupKey: 'warning',
      label: 'Warning',
      detail: typeof event.payload?.message === 'string' ? event.payload.message : 'Gateway warning',
      occurredAt: getEventOccurredAt(event.createdAt),
      tone: 'warning',
    }
  }

  if (event.kind === 'gateway.session.opened') {
    return {
      id: event.id,
      groupKey: 'session',
      label: 'Session ready',
      detail: 'Gateway session ready',
      occurredAt: getEventOccurredAt(event.createdAt),
      tone: 'success',
    }
  }

  if (event.kind === 'gateway.session.closed') {
    return {
      id: event.id,
      groupKey: 'session',
      label: 'Session ended',
      detail: typeof event.payload?.reason === 'string' ? event.payload.reason : 'Gateway session closed',
      occurredAt: getEventOccurredAt(event.createdAt),
      tone: 'warning',
    }
  }

  if (event.kind === 'turn.interrupted') {
    return {
      id: event.id,
      groupKey: 'turn',
      label: 'Generation stopped',
      detail: 'Stopped generation',
      occurredAt: getEventOccurredAt(event.createdAt),
      tone: 'warning',
    }
  }

  if (event.kind === 'turn.failed') {
    return {
      id: event.id,
      groupKey: 'turn',
      label: 'Response failed',
      detail: typeof event.payload?.error === 'string' ? event.payload.error : 'Turn failed',
      occurredAt: getEventOccurredAt(event.createdAt),
      tone: 'error',
    }
  }

  return null
}

export function buildAgentActivityItemsFromTaskEvents(events: TaskEvent[]): TaskAgentActivityItem[] {
  const items: TaskAgentActivityItem[] = []

  for (const event of events) {
    if (event.kind === 'gateway.state.snapshot') {
      const recentEvents = Array.isArray(event.payload?.recentEvents) ? event.payload.recentEvents : []

      for (const [index, summaryEvent] of recentEvents.entries()) {
        if (!summaryEvent || typeof summaryEvent !== 'object') {
          continue
        }

        const item = buildSummaryEventItem(
          {
            at: normalizeOccurredAt(summaryEvent.at, event.createdAt),
            type: typeof summaryEvent.type === 'string' ? summaryEvent.type : 'event',
            method: typeof summaryEvent.method === 'string' ? summaryEvent.method : null,
            itemType: typeof summaryEvent.itemType === 'string' ? summaryEvent.itemType : null,
            itemId: typeof summaryEvent.itemId === 'string' ? summaryEvent.itemId : null,
            status: typeof summaryEvent.status === 'string' ? summaryEvent.status : null,
            textPreview: typeof summaryEvent.textPreview === 'string' ? summaryEvent.textPreview : null,
          },
          index,
        )

        if (item) {
          items.push(item)
        }
      }

      continue
    }

    const item = buildTaskEventItem(event)
    if (item) {
      items.push(item)
    }
  }

  const seenIds = new Set<string>()

  return items
    .toSorted((left, right) => left.occurredAt.localeCompare(right.occurredAt))
    .filter((item) => {
      const key = `${item.label}|${item.detail}|${item.occurredAt}`
      if (seenIds.has(key)) {
        return false
      }

      seenIds.add(key)
      return true
    })
}

export function buildAgentActivityItemsFromState(state: CodexGatewayState | null): TaskAgentActivityItem[] {
  if (!state?.recentEvents?.length) {
    return []
  }

  return state.recentEvents.flatMap((summaryEvent, index) => {
    const item = buildSummaryEventItem(summaryEvent, index)
    return item ? [item] : []
  })
}
