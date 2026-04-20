import type {
  CodexGatewayCreateSessionInput,
  CodexGatewayHealth,
  CodexGatewayReady,
  CodexGatewaySessionResponse,
  CodexGatewayTurnInput,
} from '@/lib/codex-gateway/types'

export class CodexGatewayApiError extends Error {
  status: number
  body?: unknown

  constructor(message: string, status: number, body?: unknown) {
    super(message)
    this.name = 'CodexGatewayApiError'
    this.status = status
    this.body = body
  }
}

const CODEX_GATEWAY_STARTUP_TIMEOUT_MS = 60_000
const CODEX_GATEWAY_STARTUP_RETRY_MS = 1_000
const CODEX_GATEWAY_REQUEST_TIMEOUT_MS = 10_000

function buildUrl(baseUrl: string, path: string): string {
  const url = new URL(baseUrl)
  const basePath = url.pathname.replace(/\/+$/, '')
  const relativePath = path.replace(/^\/+/, '')

  url.pathname = `${basePath}/${relativePath}`
  return url.toString()
}

async function parseResponse(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') || ''

  if (contentType.includes('application/json')) {
    return await response.json()
  }

  const text = await response.text()
  return text || null
}

async function request<T>(baseUrl: string, path: string, init?: RequestInit, authToken?: string | null): Promise<T> {
  const headers = new Headers(init?.headers)
  const requestUrl = buildUrl(baseUrl, path)

  if (!headers.has('content-type') && init?.body) {
    headers.set('content-type', 'application/json')
  }

  if (authToken) {
    headers.set('authorization', `Bearer ${authToken}`)
  }

  const signal = init?.signal || AbortSignal.timeout(CODEX_GATEWAY_REQUEST_TIMEOUT_MS)

  const response = await fetch(requestUrl, {
    ...init,
    headers,
    cache: 'no-store',
    signal,
  })

  const body = await parseResponse(response)

  if (!response.ok) {
    const message =
      typeof body === 'object' && body && 'error' in body && typeof body.error === 'string'
        ? body.error
        : `Codex gateway request failed with status ${response.status}`

    throw new CodexGatewayApiError(message, response.status, body)
  }

  return body as T
}

export function getCodexGatewayEventStreamUrl(baseUrl: string, sessionId: string, authToken?: string | null): string {
  const url = new URL(buildUrl(baseUrl, `/api/sessions/${encodeURIComponent(sessionId)}/events`))
  if (authToken) {
    url.searchParams.set('access_token', authToken)
  }
  return url.toString()
}

export async function getCodexGatewayHealth(baseUrl: string): Promise<CodexGatewayHealth> {
  return await request<CodexGatewayHealth>(baseUrl, '/healthz')
}

export async function getCodexGatewayReady(baseUrl: string): Promise<CodexGatewayReady> {
  return await request<CodexGatewayReady>(baseUrl, '/readyz')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function waitForCodexGatewayReady(baseUrl: string): Promise<CodexGatewayReady> {
  const deadline = Date.now() + CODEX_GATEWAY_STARTUP_TIMEOUT_MS
  let lastError: unknown = null

  while (Date.now() < deadline) {
    try {
      const health = await getCodexGatewayHealth(baseUrl)
      if (!health.ok) {
        lastError = new Error('Codex gateway health check returned not ok')
        await sleep(CODEX_GATEWAY_STARTUP_RETRY_MS)
        continue
      }
    } catch (error) {
      lastError = error
      await sleep(CODEX_GATEWAY_STARTUP_RETRY_MS)
      continue
    }

    try {
      const ready = await getCodexGatewayReady(baseUrl)
      if (ready.ok) {
        return ready
      }

      lastError = new Error('Codex gateway readiness check returned not ok')
    } catch (error) {
      lastError = error
    }

    await sleep(CODEX_GATEWAY_STARTUP_RETRY_MS)
  }

  if (lastError instanceof Error) {
    throw lastError
  }

  throw new Error('Codex gateway startup check timed out')
}

export async function createCodexGatewaySession(
  baseUrl: string,
  input: CodexGatewayCreateSessionInput,
  authToken?: string | null,
): Promise<CodexGatewaySessionResponse> {
  return await request<CodexGatewaySessionResponse>(
    baseUrl,
    '/api/sessions',
    {
      method: 'POST',
      body: JSON.stringify(input),
    },
    authToken,
  )
}

export async function getCodexGatewaySessionState(
  baseUrl: string,
  sessionId: string,
  authToken?: string | null,
): Promise<CodexGatewaySessionResponse> {
  return await request<CodexGatewaySessionResponse>(
    baseUrl,
    `/api/sessions/${encodeURIComponent(sessionId)}/state`,
    undefined,
    authToken,
  )
}

export async function sendCodexGatewayTurn(
  baseUrl: string,
  sessionId: string,
  input: CodexGatewayTurnInput,
  authToken?: string | null,
): Promise<CodexGatewaySessionResponse> {
  return await request<CodexGatewaySessionResponse>(
    baseUrl,
    `/api/sessions/${encodeURIComponent(sessionId)}/turn`,
    {
      method: 'POST',
      body: JSON.stringify(input),
    },
    authToken,
  )
}

export async function interruptCodexGatewayTurn(
  baseUrl: string,
  sessionId: string,
  authToken?: string | null,
): Promise<CodexGatewaySessionResponse> {
  return await request<CodexGatewaySessionResponse>(
    baseUrl,
    `/api/sessions/${encodeURIComponent(sessionId)}/turn/interrupt`,
    {
      method: 'POST',
      body: JSON.stringify({}),
    },
    authToken,
  )
}

export async function deleteCodexGatewaySession(
  baseUrl: string,
  sessionId: string,
  authToken?: string | null,
): Promise<void> {
  await request(baseUrl, `/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' }, authToken)
}
