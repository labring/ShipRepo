'use client'

import {
  GITHUB_AUTH_ERROR_MESSAGE_TYPE,
  GITHUB_AUTH_POPUP_PARAM,
  GITHUB_AUTH_POPUP_VALUE,
  GITHUB_AUTH_SUCCESS_MESSAGE_TYPE,
  isGitHubAuthPopupMessage,
} from '@/lib/auth/github-popup-contract'

const POPUP_WIDTH = 600
const POPUP_HEIGHT = 720
const POPUP_CLOSE_POLL_MS = 500
const POPUP_TIMEOUT_MS = 120000

export type GitHubPopupAuthErrorCode = 'popup_blocked' | 'popup_closed' | 'timeout' | 'auth_error'

export class GitHubPopupAuthError extends Error {
  constructor(readonly code: GitHubPopupAuthErrorCode) {
    super('GitHub authentication failed')
    this.name = 'GitHubPopupAuthError'
  }
}

export function startGitHubPopupAuth(authPath: string): Promise<void> {
  const authUrl = new URL(authPath, window.location.origin)
  authUrl.searchParams.set(GITHUB_AUTH_POPUP_PARAM, GITHUB_AUTH_POPUP_VALUE)
  authUrl.searchParams.set('next', `${window.location.pathname}${window.location.search}`)

  const left = Math.max(0, window.screenX + (window.outerWidth - POPUP_WIDTH) / 2)
  const top = Math.max(0, window.screenY + (window.outerHeight - POPUP_HEIGHT) / 2)
  const popup = window.open(
    authUrl.toString(),
    'github-auth',
    `popup=yes,width=${POPUP_WIDTH},height=${POPUP_HEIGHT},left=${Math.round(left)},top=${Math.round(top)}`,
  )

  if (!popup) {
    return Promise.reject(new GitHubPopupAuthError('popup_blocked'))
  }

  popup.focus()

  return new Promise((resolve, reject) => {
    let settled = false
    let closePoll: number | undefined
    let timeout: number | undefined

    const cleanup = () => {
      window.removeEventListener('message', handleMessage)
      if (closePoll !== undefined) {
        window.clearInterval(closePoll)
      }
      if (timeout !== undefined) {
        window.clearTimeout(timeout)
      }
    }

    const complete = (result: 'success' | GitHubPopupAuthErrorCode) => {
      if (settled) {
        return
      }

      settled = true
      cleanup()

      if (result === 'success') {
        resolve()
      } else {
        reject(new GitHubPopupAuthError(result))
      }
    }

    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || !isGitHubAuthPopupMessage(event.data)) {
        return
      }

      if (event.data.type === GITHUB_AUTH_SUCCESS_MESSAGE_TYPE) {
        complete('success')
        return
      }

      if (event.data.type === GITHUB_AUTH_ERROR_MESSAGE_TYPE) {
        complete('auth_error')
      }
    }

    window.addEventListener('message', handleMessage)

    closePoll = window.setInterval(() => {
      if (popup.closed) {
        complete('popup_closed')
      }
    }, POPUP_CLOSE_POLL_MS)

    timeout = window.setTimeout(() => {
      popup.close()
      complete('timeout')
    }, POPUP_TIMEOUT_MS)
  })
}
