import type { CodexGatewayState, CodexGatewaySummaryEvent } from '@/lib/codex-gateway/types'
import type { TaskEvent } from '@/lib/db/schema'

export interface TaskAgentActivityItem {
  detail: string
  id: string
  label: string
  occurredAt: string
  tone: 'default' | 'error' | 'success' | 'warning'
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

function buildSummaryEventItem(summaryEvent: CodexGatewaySummaryEvent, index: number): TaskAgentActivityItem {
  const label = summaryEvent.method || summaryEvent.type || 'event'
  const detail = summaryEvent.textPreview || summaryEvent.itemType || ''
  const occurredAt =
    typeof summaryEvent.at === 'string' && summaryEvent.at.trim() ? summaryEvent.at : new Date(0).toISOString()

  return {
    id: `summary-${occurredAt}-${summaryEvent.method || summaryEvent.type || index}-${summaryEvent.itemId || index}`,
    label,
    detail,
    occurredAt,
    tone: getToneFromStatus(summaryEvent.status),
  }
}

function buildTaskEventItem(event: TaskEvent): TaskAgentActivityItem | null {
  if (event.kind === 'gateway.warning') {
    return {
      id: event.id,
      label: 'warning',
      detail: typeof event.payload?.message === 'string' ? event.payload.message : 'Gateway warning',
      occurredAt: getEventOccurredAt(event.createdAt),
      tone: 'warning',
    }
  }

  if (event.kind === 'gateway.server_request') {
    const method = typeof event.payload?.method === 'string' ? event.payload.method : 'server-request'
    const result = typeof event.payload?.result === 'string' ? event.payload.result : ''

    return {
      id: event.id,
      label: method,
      detail: result || 'Server request',
      occurredAt: getEventOccurredAt(event.createdAt),
      tone: getToneFromStatus(result),
    }
  }

  if (event.kind === 'gateway.notification') {
    const method = typeof event.payload?.method === 'string' ? event.payload.method : 'notification'
    const detail =
      typeof event.payload?.message === 'string'
        ? event.payload.message
        : typeof event.payload?.textPreview === 'string'
          ? event.payload.textPreview
          : 'Agent notification'

    return {
      id: event.id,
      label: method,
      detail,
      occurredAt: getEventOccurredAt(event.createdAt),
      tone: 'default',
    }
  }

  if (event.kind === 'gateway.session.opened') {
    return {
      id: event.id,
      label: 'session',
      detail: 'Gateway session ready',
      occurredAt: getEventOccurredAt(event.createdAt),
      tone: 'success',
    }
  }

  if (event.kind === 'gateway.session.closed') {
    return {
      id: event.id,
      label: 'session-closed',
      detail: typeof event.payload?.reason === 'string' ? event.payload.reason : 'Gateway session closed',
      occurredAt: getEventOccurredAt(event.createdAt),
      tone: 'warning',
    }
  }

  if (event.kind === 'turn.started') {
    return {
      id: event.id,
      label: 'turn',
      detail: 'Started response',
      occurredAt: getEventOccurredAt(event.createdAt),
      tone: 'default',
    }
  }

  if (event.kind === 'turn.completed') {
    return {
      id: event.id,
      label: 'turn',
      detail: 'Completed response',
      occurredAt: getEventOccurredAt(event.createdAt),
      tone: 'success',
    }
  }

  if (event.kind === 'turn.interrupted') {
    return {
      id: event.id,
      label: 'turn',
      detail: 'Stopped generation',
      occurredAt: getEventOccurredAt(event.createdAt),
      tone: 'warning',
    }
  }

  if (event.kind === 'turn.failed') {
    return {
      id: event.id,
      label: 'turn',
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

        items.push(
          buildSummaryEventItem(
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
          ),
        )
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

  return state.recentEvents.map((summaryEvent, index) => buildSummaryEventItem(summaryEvent, index))
}
