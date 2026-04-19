import { SEALOS_KUBECONFIG_STORAGE_KEY } from './constants'

export function storeSealosKubeconfig(kubeconfig: string): boolean {
  if (typeof window === 'undefined') {
    return false
  }

  try {
    window.localStorage.setItem(SEALOS_KUBECONFIG_STORAGE_KEY, kubeconfig)
    return true
  } catch {
    return false
  }
}
