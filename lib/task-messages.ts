import { db } from '@/lib/db/client'
import { taskMessages } from '@/lib/db/schema'
import { generateId } from '@/lib/utils/id'

interface AppendTaskMessageInput {
  taskId: string
  role: 'user' | 'agent'
  content: string
}

export async function appendTaskMessage({ taskId, role, content }: AppendTaskMessageInput): Promise<void> {
  const trimmedContent = content.trim()

  if (!trimmedContent) {
    return
  }

  await db.insert(taskMessages).values({
    id: generateId(12),
    taskId,
    role,
    content: trimmedContent,
  })
}
