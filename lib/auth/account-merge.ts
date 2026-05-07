import type { keys } from '@/lib/db/schema'

type KeyProvider = (typeof keys.$inferSelect)['provider']

interface MergeKeyRow {
  id: string
  provider: KeyProvider
}

export function planUserKeyMerge({
  sourceKeys,
  targetKeys,
}: {
  sourceKeys: MergeKeyRow[]
  targetKeys: MergeKeyRow[]
}): {
  deleteKeyIds: string[]
  moveKeyIds: string[]
} {
  const targetProviders = new Set(targetKeys.map((key) => key.provider))
  const moveKeyIds: string[] = []
  const deleteKeyIds: string[] = []

  for (const key of sourceKeys) {
    if (targetProviders.has(key.provider)) {
      deleteKeyIds.push(key.id)
    } else {
      moveKeyIds.push(key.id)
    }
  }

  return {
    deleteKeyIds,
    moveKeyIds,
  }
}
