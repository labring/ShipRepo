export const GITHUB_AUTH_POPUP_PARAM = 'popup'
export const GITHUB_AUTH_POPUP_VALUE = 'true'
export const GITHUB_AUTH_POPUP_COOKIE = 'github_auth_popup'
export const GITHUB_AUTH_SUCCESS_MESSAGE_TYPE = 'github-auth-success'
export const GITHUB_AUTH_ERROR_MESSAGE_TYPE = 'github-auth-error'

export type GitHubAuthPopupMessage =
  | { type: typeof GITHUB_AUTH_SUCCESS_MESSAGE_TYPE; status: 'success' }
  | { type: typeof GITHUB_AUTH_ERROR_MESSAGE_TYPE; status: 'error' }

export function isGitHubAuthPopupMessage(value: unknown): value is GitHubAuthPopupMessage {
  if (!value || typeof value !== 'object') {
    return false
  }

  const message = value as { type?: unknown; status?: unknown }

  return (
    (message.type === GITHUB_AUTH_SUCCESS_MESSAGE_TYPE && message.status === 'success') ||
    (message.type === GITHUB_AUTH_ERROR_MESSAGE_TYPE && message.status === 'error')
  )
}
