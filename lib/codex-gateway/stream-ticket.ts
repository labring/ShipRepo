import { decryptJWE } from '@/lib/jwe/decrypt'
import { encryptJWE } from '@/lib/jwe/encrypt'

interface ChatStreamTicketPayload {
  sessionId: string
  taskId: string
  userId: string
}

const CHAT_STREAM_TICKET_TTL = '12h'

export async function issueChatStreamTicket(payload: ChatStreamTicketPayload): Promise<string> {
  return await encryptJWE(payload, CHAT_STREAM_TICKET_TTL)
}

export async function readChatStreamTicket(ticket: string): Promise<ChatStreamTicketPayload | null> {
  const payload = await decryptJWE<ChatStreamTicketPayload>(ticket)

  if (
    !payload ||
    typeof payload.taskId !== 'string' ||
    typeof payload.userId !== 'string' ||
    typeof payload.sessionId !== 'string'
  ) {
    return null
  }

  return payload
}

export function buildTaskChatStreamUrl(taskId: string, ticket: string): string {
  return `/api/tasks/${taskId}/chat/stream?ticket=${encodeURIComponent(ticket)}`
}

export async function createTaskChatStreamDescriptor(payload: ChatStreamTicketPayload): Promise<{
  streamTicket: string
  streamUrl: string
}> {
  const streamTicket = await issueChatStreamTicket(payload)

  return {
    streamTicket,
    streamUrl: buildTaskChatStreamUrl(payload.taskId, streamTicket),
  }
}
