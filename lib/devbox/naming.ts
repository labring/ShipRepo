import { createHash } from 'crypto'

const DEVBOX_NAME_LENGTH = 12
const DEVBOX_NAME_ALPHABET = 'abcdefghijklmnopqrstuvwxyz'

export function createTaskDevboxName(taskId: string): string {
  const digest = createHash('sha256').update(taskId).digest()
  let name = ''

  for (let index = 0; index < DEVBOX_NAME_LENGTH; index += 1) {
    const value = digest[index] ?? digest[index % digest.length]!
    name += DEVBOX_NAME_ALPHABET[value % DEVBOX_NAME_ALPHABET.length]
  }

  return name
}
