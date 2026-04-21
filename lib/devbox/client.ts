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

const DEVBOX_REQUEST_TIMEOUT_MS = 60_000
const DEVBOX_EXEC_REQUEST_BUFFER_MS = 10_000

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
    timeoutMs?: number
  },
): Promise<DevboxEnvelope<T>> {
  const { headers: initHeaders, skipAuth, searchParams, includeApiPrefix, timeoutMs, ...requestInit } = init || {}
  const headers = new Headers(initHeaders)

  if (!skipAuth) {
    const token = await getDevboxAuthToken()
    headers.set('Authorization', `Bearer ${token}`)
  }

  if (requestInit.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }

  const signal = requestInit.signal || AbortSignal.timeout(timeoutMs ?? DEVBOX_REQUEST_TIMEOUT_MS)

  const response = await fetch(buildUrl(pathname, searchParams, includeApiPrefix), {
    ...requestInit,
    headers,
    cache: 'no-store',
    signal,
  })

  return await parseJsonResponse<T>(response)
}

export async function getDevboxHealth() {
  console.info('Devbox health request started')
  try {
    const result = await devboxRequest<DevboxHealthData>('/healthz', {
      method: 'GET',
      skipAuth: true,
      includeApiPrefix: false,
    })
    console.info('Devbox health request finished')
    return result
  } catch (error) {
    console.error('Devbox health request failed:', error)
    throw error
  }
}

export async function createDevbox(input: CreateDevboxInput) {
  console.info('Devbox create request started')
  try {
    const result = await devboxRequest<CreateDevboxResult>('', {
      method: 'POST',
      body: JSON.stringify(input),
    })
    console.info('Devbox create request finished')
    return result
  } catch (error) {
    console.error('Devbox create request failed:', error)
    throw error
  }
}

export async function listDevboxes(upstreamID?: string) {
  const searchParams = new URLSearchParams()
  if (upstreamID) {
    searchParams.set('upstreamID', upstreamID)
  }

  console.info('Devbox list request started')
  try {
    const result = await devboxRequest<{ items: DevboxListItem[] }>('', {
      method: 'GET',
      searchParams,
    })
    console.info('Devbox list request finished')
    return result
  } catch (error) {
    console.error('Devbox list request failed:', error)
    throw error
  }
}

export async function getDevbox(name: string) {
  console.info('Devbox get request started')
  try {
    const result = await devboxRequest<DevboxInfo>(`/${encodeURIComponent(name)}`, {
      method: 'GET',
    })
    console.info('Devbox get request finished')
    return result
  } catch (error) {
    console.error('Devbox get request failed:', error)
    throw error
  }
}

export async function pauseDevbox(name: string) {
  console.info('Devbox pause request started')
  try {
    const result = await devboxRequest<PauseDevboxResult>(`/${encodeURIComponent(name)}/pause`, {
      method: 'POST',
    })
    console.info('Devbox pause request finished')
    return result
  } catch (error) {
    console.error('Devbox pause request failed:', error)
    throw error
  }
}

export async function refreshDevboxPause(name: string, input: RefreshPauseInput) {
  console.info('Devbox refresh pause request started')
  try {
    const result = await devboxRequest<RefreshPauseResult>(`/${encodeURIComponent(name)}/pause/refresh`, {
      method: 'POST',
      body: JSON.stringify(input),
    })
    console.info('Devbox refresh pause request finished')
    return result
  } catch (error) {
    console.error('Devbox refresh pause request failed:', error)
    throw error
  }
}

export async function resumeDevbox(name: string) {
  console.info('Devbox resume request started')
  try {
    const result = await devboxRequest<PauseDevboxResult>(`/${encodeURIComponent(name)}/resume`, {
      method: 'POST',
    })
    console.info('Devbox resume request finished')
    return result
  } catch (error) {
    console.error('Devbox resume request failed:', error)
    throw error
  }
}

export async function deleteDevbox(name: string) {
  console.info('Devbox delete request started')
  try {
    const result = await devboxRequest<DeleteDevboxResult>(`/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    })
    console.info('Devbox delete request finished')
    return result
  } catch (error) {
    console.error('Devbox delete request failed:', error)
    throw error
  }
}

export async function execDevbox(name: string, input: DevboxExecInput) {
  console.info('Devbox exec request started')
  try {
    const timeoutMs = Math.max(
      DEVBOX_REQUEST_TIMEOUT_MS,
      (input.timeoutSeconds ?? 60) * 1000 + DEVBOX_EXEC_REQUEST_BUFFER_MS,
    )
    const result = await devboxRequest<DevboxExecResult>(`/${encodeURIComponent(name)}/exec`, {
      method: 'POST',
      body: JSON.stringify(input),
      timeoutMs,
    })
    console.info('Devbox exec request finished')
    return result
  } catch (error) {
    console.error('Devbox exec request failed:', error)
    throw error
  }
}
