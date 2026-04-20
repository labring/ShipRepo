import { createHash } from 'node:crypto'

const DEVBOX_NAME_LENGTH = 12
const DEVBOX_NAME_ALPHABET = 'abcdefghijklmnopqrstuvwxyz'
const DEVBOX_UPSTREAM_ID_SAFE_PATTERN = /^([A-Za-z0-9][-A-Za-z0-9_.]*[A-Za-z0-9]|[A-Za-z0-9])$/
const DEVBOX_UPSTREAM_ID_HASH_LENGTH = 24

export function createTaskDevboxName(taskId: string): string {
  const digest = createHash('sha256').update(taskId).digest()
  let name = ''

  for (let index = 0; index < DEVBOX_NAME_LENGTH; index += 1) {
    const value = digest[index] ?? digest[index % digest.length]!
    name += DEVBOX_NAME_ALPHABET[value % DEVBOX_NAME_ALPHABET.length]
  }

  return name
}

export function createTaskDevboxUpstreamId(taskId: string): string {
  if (DEVBOX_UPSTREAM_ID_SAFE_PATTERN.test(taskId)) {
    return taskId
  }

  return `task-${createHash('sha256').update(taskId).digest('hex').slice(0, DEVBOX_UPSTREAM_ID_HASH_LENGTH)}`
}
