const DEVBOX_NAME_MAX_LENGTH = 63

export function createTaskDevboxName(taskId: string): string {
  const normalizedTaskId = taskId
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')

  const baseName = `task-${normalizedTaskId || 'runtime'}`

  if (baseName.length <= DEVBOX_NAME_MAX_LENGTH) {
    return baseName
  }

  return baseName.slice(0, DEVBOX_NAME_MAX_LENGTH).replace(/-+$/g, '')
}
