import { and, desc, eq, inArray } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { taskEvents } from '@/lib/db/schema'

type FailureSource =
  | 'gateway-fallback'
  | 'gateway-notification'
  | 'gateway-session'
  | 'gateway-state'
  | 'gateway-warning'

export interface CodexTurnFailureDiagnostic {
  error: string
  httpStatus?: number
  source: FailureSource
  turnStatus?: string | null
}

interface DiagnosticCandidate {
  error: string
  priority: number
  source: Exclude<FailureSource, 'gateway-fallback' | 'gateway-session'>
}

function normalizeDiagnosticText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function isReconnectWarning(value: string): boolean {
  return /^reconnecting\.\.\./i.test(value.trim())
}

function extractTextValue(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]

  if (typeof value !== 'string') {
    return null
  }

  const normalizedValue = normalizeDiagnosticText(value)
  return normalizedValue || null
}

function extractPayloadTextCandidates(payload: Record<string, unknown> | null | undefined): string[] {
  if (!payload) {
    return []
  }

  const candidates = [
    extractTextValue(payload, 'message'),
    extractTextValue(payload, 'error'),
    extractTextValue(payload, 'error_message'),
    extractTextValue(payload, 'errorMessage'),
    extractTextValue(payload, 'detail'),
    extractTextValue(payload, 'textPreview'),
  ]

  return candidates.filter((candidate): candidate is string => candidate !== null && !isReconnectWarning(candidate))
}

function buildCandidate(
  error: string,
  source: DiagnosticCandidate['source'],
  priority: number,
): DiagnosticCandidate | null {
  const normalizedError = normalizeDiagnosticText(error)

  if (!normalizedError || isReconnectWarning(normalizedError)) {
    return null
  }

  return {
    error: normalizedError,
    source,
    priority,
  }
}

function classifyDiagnosticPriority(error: string): number {
  const normalizedError = error.toLowerCase()

  if (normalizedError.includes('stream disconnected before completion')) {
    return 100
  }

  if (normalizedError.includes('systemerror') || normalizedError.includes('system error')) {
    return 90
  }

  if (normalizedError.includes('session is no longer available')) {
    return 80
  }

  return 50
}

function extractNotificationCandidates(payload: Record<string, unknown> | null | undefined): DiagnosticCandidate[] {
  if (!payload) {
    return []
  }

  const candidates = extractPayloadTextCandidates(payload)
    .map((candidate) => buildCandidate(candidate, 'gateway-notification', classifyDiagnosticPriority(candidate)))
    .filter((candidate): candidate is DiagnosticCandidate => Boolean(candidate))

  const method = extractTextValue(payload, 'method')
  const nestedStatus = payload.status
  const statusType =
    nestedStatus && typeof nestedStatus === 'object' && 'type' in nestedStatus && typeof nestedStatus.type === 'string'
      ? normalizeDiagnosticText(nestedStatus.type)
      : null

  if (method === 'thread/status/changed' && statusType) {
    const candidate = buildCandidate(statusType, 'gateway-notification', classifyDiagnosticPriority(statusType))
    if (candidate) {
      candidates.push(candidate)
    }
  }

  return candidates
}

function extractStateCandidates(payload: Record<string, unknown> | null | undefined): DiagnosticCandidate[] {
  if (!payload) {
    return []
  }

  const recentEvents = Array.isArray(payload.recentEvents) ? payload.recentEvents : []
  const candidates: DiagnosticCandidate[] = []

  for (const recentEvent of [...recentEvents].reverse()) {
    if (!recentEvent || typeof recentEvent !== 'object') {
      continue
    }

    const textPreview =
      'textPreview' in recentEvent && typeof recentEvent.textPreview === 'string'
        ? normalizeDiagnosticText(recentEvent.textPreview)
        : null
    const method =
      'method' in recentEvent && typeof recentEvent.method === 'string'
        ? normalizeDiagnosticText(recentEvent.method)
        : null
    const status =
      'status' in recentEvent && typeof recentEvent.status === 'string'
        ? normalizeDiagnosticText(recentEvent.status)
        : null

    if (textPreview) {
      const candidate = buildCandidate(textPreview, 'gateway-state', classifyDiagnosticPriority(textPreview))
      if (candidate) {
        candidates.push(candidate)
      }
    }

    if (method === 'thread/status/changed' && status) {
      const candidate = buildCandidate(status, 'gateway-state', classifyDiagnosticPriority(status))
      if (candidate) {
        candidates.push(candidate)
      }
    }
  }

  return candidates
}

export async function diagnoseCodexTurnFailure(input: {
  fallbackError: string
  httpStatus?: number
  sessionId?: string | null
  taskId: string
  turnStatus?: string | null
}): Promise<CodexTurnFailureDiagnostic> {
  if (input.httpStatus === 404 || input.httpStatus === 410) {
    return {
      error: 'Codex gateway session is no longer available',
      httpStatus: input.httpStatus,
      source: 'gateway-session',
      turnStatus: input.turnStatus ?? null,
    }
  }

  const eventFilters = [eq(taskEvents.taskId, input.taskId)]
  if (input.sessionId) {
    eventFilters.push(eq(taskEvents.sessionId, input.sessionId))
  }

  const recentEvents = await db
    .select({
      kind: taskEvents.kind,
      payload: taskEvents.payload,
    })
    .from(taskEvents)
    .where(
      and(
        ...eventFilters,
        inArray(taskEvents.kind, ['gateway.warning', 'gateway.notification', 'gateway.state.snapshot']),
      ),
    )
    .orderBy(desc(taskEvents.seq))
    .limit(40)

  let bestCandidate: DiagnosticCandidate | null = null

  for (const event of recentEvents) {
    let candidates: DiagnosticCandidate[] = []

    if (event.kind === 'gateway.warning') {
      candidates = extractPayloadTextCandidates(event.payload).flatMap((candidate) => {
        const nextCandidate = buildCandidate(candidate, 'gateway-warning', classifyDiagnosticPriority(candidate))
        return nextCandidate ? [nextCandidate] : []
      })
    } else if (event.kind === 'gateway.notification') {
      candidates = extractNotificationCandidates(event.payload)
    } else if (event.kind === 'gateway.state.snapshot') {
      candidates = extractStateCandidates(event.payload)
    }

    for (const candidate of candidates) {
      if (!bestCandidate || candidate.priority > bestCandidate.priority) {
        bestCandidate = candidate
      }
    }
  }

  return {
    error: bestCandidate?.error || input.fallbackError,
    httpStatus: input.httpStatus,
    source: bestCandidate?.source || 'gateway-fallback',
    turnStatus: input.turnStatus ?? null,
  }
}
