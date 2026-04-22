export function buildTaskEventUserMessageId(eventId: string): string {
  return `task-user-event-${eventId}`
}

export function buildTaskClientMessageId(clientMessageId: string): string {
  return `task-user-client-${clientMessageId}`
}

export function buildProjectedAssistantMessageId(sessionId: string, transcriptCursor: number): string {
  return `codex-agent-${sessionId}-${transcriptCursor}`
}
