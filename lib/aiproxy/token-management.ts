import 'server-only'

import { AIPROXY_AUTO_TOKEN_NAME, AIPROXY_TOKEN_MANAGEMENT_BASE_URL } from '@/lib/aiproxy/constants'
import {
  diagnoseAiProxyTokenInfo,
  isAiProxyTokenInfo,
  isUsableAiProxyTokenInfo,
  type AiProxyTokenInfo,
  type AiProxyTokenValidationIssue,
} from '@/lib/aiproxy/token-validation'
export {
  diagnoseAiProxyTokenInfo,
  isAiProxyTokenInfo,
  isUsableAiProxyTokenInfo,
  type AiProxyTokenInfo,
  type AiProxyTokenValidationIssue,
} from '@/lib/aiproxy/token-validation'

export type AiProxyTokenProvisioningResult =
  | {
      ok: true
      token: AiProxyTokenInfo
    }
  | {
      ok: false
      diagnostic?: AiProxyTokenValidationIssue
      reason: 'missing_kubeconfig' | 'request_failed' | 'unexpected_response' | 'unusable_token'
      status?: number
    }

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()

  if (!text) {
    return undefined
  }

  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

async function requestAiProxyTokenManagement(
  path: string,
  kubeconfig: string,
  init?: Omit<RequestInit, 'headers'> & { headers?: Record<string, string> },
): Promise<Response> {
  const baseUrl = trimTrailingSlash(AIPROXY_TOKEN_MANAGEMENT_BASE_URL)

  return await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...init?.headers,
      Authorization: encodeURIComponent(kubeconfig),
    },
  })
}

async function parseUsableToken(response: Response): Promise<AiProxyTokenProvisioningResult> {
  const payload = await readJson(response)
  const diagnostic = diagnoseAiProxyTokenInfo(payload)

  if (!isAiProxyTokenInfo(payload)) {
    return {
      diagnostic: diagnostic ?? undefined,
      ok: false,
      reason: 'unexpected_response',
      status: response.status,
    }
  }

  if (!isUsableAiProxyTokenInfo(payload)) {
    return {
      diagnostic: diagnostic ?? undefined,
      ok: false,
      reason: 'unusable_token',
      status: response.status,
    }
  }

  return {
    ok: true,
    token: payload,
  }
}

export async function getOrCreateAiProxyToken(kubeconfig: string): Promise<AiProxyTokenProvisioningResult> {
  const normalizedKubeconfig = kubeconfig.trim()

  if (!normalizedKubeconfig) {
    return {
      ok: false,
      reason: 'missing_kubeconfig',
    }
  }

  const tokenPath = `/tokens/${encodeURIComponent(AIPROXY_AUTO_TOKEN_NAME)}`
  let lookupResponse: Response

  try {
    lookupResponse = await requestAiProxyTokenManagement(tokenPath, normalizedKubeconfig, {
      method: 'GET',
    })
  } catch {
    return {
      ok: false,
      reason: 'request_failed',
    }
  }

  if (lookupResponse.status === 200) {
    return await parseUsableToken(lookupResponse)
  }

  if (lookupResponse.status !== 404) {
    return {
      ok: false,
      reason: 'request_failed',
      status: lookupResponse.status,
    }
  }

  let createResponse: Response

  try {
    createResponse = await requestAiProxyTokenManagement('/tokens', normalizedKubeconfig, {
      body: JSON.stringify({
        name: AIPROXY_AUTO_TOKEN_NAME,
      }),
      headers: {
        'Content-Type': 'application/json',
      },
      method: 'POST',
    })
  } catch {
    return {
      ok: false,
      reason: 'request_failed',
    }
  }

  if (createResponse.status !== 201) {
    return {
      ok: false,
      reason: 'request_failed',
      status: createResponse.status,
    }
  }

  return await parseUsableToken(createResponse)
}
