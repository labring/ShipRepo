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

function buildUrl(baseUrl: string, path: string): string {
  return new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString()
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

  if (!headers.has('content-type') && init?.body) {
    headers.set('content-type', 'application/json')
  }

  if (authToken) {
    headers.set('authorization', `Bearer ${authToken}`)
  }

  const response = await fetch(buildUrl(baseUrl, path), {
    ...init,
    headers,
    cache: 'no-store',
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

export async function deleteCodexGatewaySession(
  baseUrl: string,
  sessionId: string,
  authToken?: string | null,
): Promise<void> {
  await request(baseUrl, `/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' }, authToken)
}
