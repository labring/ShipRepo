import 'server-only'

import { and, eq } from 'drizzle-orm'
import { AIPROXY_MODEL_BASE_URL } from '@/lib/aiproxy/constants'
import { getOrCreateAiProxyToken, type AiProxyTokenValidationIssue } from '@/lib/aiproxy/token-management'
import { encrypt } from '@/lib/crypto'
import { db } from '@/lib/db/client'
import { keys } from '@/lib/db/schema'
import { generateId } from '@/lib/utils/id'

export type AiProxyApiKeyProvisioningResult =
  | {
      mode: 'created' | 'existing'
      ok: true
    }
  | {
      diagnostic?: AiProxyTokenValidationIssue
      ok: false
      reason: 'missing_kubeconfig' | 'request_failed' | 'unexpected_response' | 'unusable_token'
    }

async function findExistingAiProxyKey(userId: string) {
  const [existing] = await db
    .select({ id: keys.id })
    .from(keys)
    .where(and(eq(keys.userId, userId), eq(keys.provider, 'aiproxy')))
    .limit(1)

  return existing ?? null
}

export async function provisionUserAiProxyApiKey(input: {
  kubeconfig?: string | null
  userId: string
}): Promise<AiProxyApiKeyProvisioningResult> {
  const existing = await findExistingAiProxyKey(input.userId)

  if (existing) {
    return {
      mode: 'existing',
      ok: true,
    }
  }

  const kubeconfig = input.kubeconfig?.trim()

  if (!kubeconfig) {
    return {
      ok: false,
      reason: 'missing_kubeconfig',
    }
  }

  const tokenResult = await getOrCreateAiProxyToken(kubeconfig)

  if (!tokenResult.ok) {
    return {
      diagnostic: tokenResult.diagnostic,
      ok: false,
      reason: tokenResult.reason,
    }
  }

  const insertResult = await db
    .insert(keys)
    .values({
      baseUrl: AIPROXY_MODEL_BASE_URL,
      id: generateId(21),
      provider: 'aiproxy',
      userId: input.userId,
      value: encrypt(tokenResult.token.key),
    })
    .onConflictDoNothing({
      target: [keys.userId, keys.provider],
    })
    .returning({ id: keys.id })

  if (insertResult.length > 0) {
    return {
      mode: 'created',
      ok: true,
    }
  }

  const conflictingExisting = await findExistingAiProxyKey(input.userId)

  if (conflictingExisting) {
    return {
      mode: 'existing',
      ok: true,
    }
  }

  return {
    ok: false,
    reason: 'request_failed',
  }
}
