export interface CodexGatewayHealth {
  ok: boolean
  uptimeSeconds?: number
}

export interface CodexGatewayReady {
  ok: boolean
  activeSessions?: number
}

export interface CodexGatewaySessionInfo {
  id: string
  createdAt: string
  lastAccessAt: string
  expiresAt: string
}

export interface CodexGatewayTranscriptEntry {
  id: string
  role: string
  text: string
  status: string
  source: string
  createdAt: number
}

export interface CodexGatewaySummaryEvent {
  at: string
  type: string
  method?: string | null
  itemType?: string | null
  itemId?: string | null
  status?: string | null
  textPreview?: string | null
}

export interface CodexGatewayState {
  ready: boolean
  cwd: string
  startedAt?: string | null
  selectedModel?: string | null
  threadId?: string | null
  currentTurnId?: string | null
  activeTurn: boolean
  lastTurnStatus?: string | null
  transcript: CodexGatewayTranscriptEntry[]
  recentEvents: CodexGatewaySummaryEvent[]
}

export interface CodexGatewaySessionResponse {
  ok: boolean
  sessionId: string
  session: CodexGatewaySessionInfo
  state: CodexGatewayState
}

export interface CodexGatewayCreateSessionInput {
  model?: string
}

export interface CodexGatewayTurnInput {
  prompt: string
}
