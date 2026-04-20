import { getDevboxApiPrefix, getDevboxAuthToken, getDevboxBaseUrl } from './config'
import {
  CreateDevboxInput,
  CreateDevboxResult,
  DeleteDevboxResult,
  DevboxEnvelope,
  DevboxExecInput,
  DevboxExecResult,
  DevboxHealthData,
  DevboxInfo,
  DevboxListItem,
  PauseDevboxResult,
  RefreshPauseInput,
  RefreshPauseResult,
} from './types'

export class DevboxApiError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'DevboxApiError'
    this.status = status
  }
}

const DEVBOX_REQUEST_TIMEOUT_MS = 10_000

function buildUrl(pathname: string, searchParams?: URLSearchParams, includeApiPrefix: boolean = true): string {
  const basePath = includeApiPrefix ? `${getDevboxApiPrefix()}${pathname}` : pathname
  const url = new URL(basePath, getDevboxBaseUrl())
  if (searchParams) {
    url.search = searchParams.toString()
  }

  return url.toString()
}

async function parseJsonResponse<T>(response: Response): Promise<DevboxEnvelope<T>> {
  let payload: unknown

  try {
    payload = await response.json()
  } catch {
    throw new DevboxApiError(response.status, 'Devbox API returned an invalid JSON response')
  }

  if (!response.ok) {
    const message =
      typeof payload === 'object' && payload && 'message' in payload && typeof payload.message === 'string'
        ? payload.message
        : 'Devbox API request failed'

    throw new DevboxApiError(response.status, message)
  }

  return payload as DevboxEnvelope<T>
}

async function devboxRequest<T>(
  pathname: string,
  init?: Omit<RequestInit, 'headers'> & {
    headers?: HeadersInit
    skipAuth?: boolean
    searchParams?: URLSearchParams
    includeApiPrefix?: boolean
  },
): Promise<DevboxEnvelope<T>> {
  const headers = new Headers(init?.headers)

  if (!init?.skipAuth) {
    const token = await getDevboxAuthToken()
    headers.set('Authorization', `Bearer ${token}`)
  }

  if (init?.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }

  const signal = init?.signal || AbortSignal.timeout(DEVBOX_REQUEST_TIMEOUT_MS)

  const response = await fetch(buildUrl(pathname, init?.searchParams, init?.includeApiPrefix), {
    ...init,
    headers,
    cache: 'no-store',
    signal,
  })

  return await parseJsonResponse<T>(response)
}

export async function getDevboxHealth() {
  return await devboxRequest<DevboxHealthData>('/healthz', {
    method: 'GET',
    skipAuth: true,
    includeApiPrefix: false,
  })
}

export async function createDevbox(input: CreateDevboxInput) {
  return await devboxRequest<CreateDevboxResult>('', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export async function listDevboxes(upstreamID?: string) {
  const searchParams = new URLSearchParams()
  if (upstreamID) {
    searchParams.set('upstreamID', upstreamID)
  }

  return await devboxRequest<{ items: DevboxListItem[] }>('', {
    method: 'GET',
    searchParams,
  })
}

export async function getDevbox(name: string) {
  return await devboxRequest<DevboxInfo>(`/${encodeURIComponent(name)}`, {
    method: 'GET',
  })
}

export async function pauseDevbox(name: string) {
  return await devboxRequest<PauseDevboxResult>(`/${encodeURIComponent(name)}/pause`, {
    method: 'POST',
  })
}

export async function refreshDevboxPause(name: string, input: RefreshPauseInput) {
  return await devboxRequest<RefreshPauseResult>(`/${encodeURIComponent(name)}/pause/refresh`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export async function resumeDevbox(name: string) {
  return await devboxRequest<PauseDevboxResult>(`/${encodeURIComponent(name)}/resume`, {
    method: 'POST',
  })
}

export async function deleteDevbox(name: string) {
  return await devboxRequest<DeleteDevboxResult>(`/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  })
}

export async function execDevbox(name: string, input: DevboxExecInput) {
  return await devboxRequest<DevboxExecResult>(`/${encodeURIComponent(name)}/exec`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}
