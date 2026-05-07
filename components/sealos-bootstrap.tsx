'use client'

import { useEffect } from 'react'
import { createSealosApp, sealosApp } from '@zjy365/sealos-desktop-sdk/app'
import {
  ensureAiProxyProvisioned,
  registerAiProxyKubeconfig,
  registerAiProxyKubeconfigTask,
} from '@/lib/aiproxy/client-provisioning'
import { storeSealosKubeconfig } from '@/lib/sealos/storage'

export function SealosBootstrap() {
  useEffect(() => {
    let isActive = true
    let cleanupApp: (() => void) | undefined

    const bootstrapSealos = async () => {
      console.info('Sealos bootstrap started')

      try {
        cleanupApp = createSealosApp()
        console.info('Sealos bootstrap initialized')
      } catch {
        if (isActive) {
          console.error('Sealos bootstrap failed')
        }
        return
      }

      try {
        const sealosSessionTask = sealosApp.getSession()
        registerAiProxyKubeconfigTask(sealosSessionTask.then((session) => session.kubeconfig || null))

        const sealosSession = await sealosSessionTask

        if (!isActive) {
          return
        }

        console.info('Sealos session loaded')

        if (!sealosSession.kubeconfig) {
          console.warn('Sealos kubeconfig missing')
          return
        }

        registerAiProxyKubeconfig(sealosSession.kubeconfig)
        void ensureAiProxyProvisioned()

        if (storeSealosKubeconfig(sealosSession.kubeconfig)) {
          console.info('Sealos kubeconfig stored')
        } else {
          console.error('Sealos kubeconfig storage failed')
        }
      } catch {
        if (isActive) {
          console.warn('Sealos session unavailable')
        }
      }
    }

    void bootstrapSealos()

    return () => {
      isActive = false
      cleanupApp?.()
    }
  }, [])

  return null
}
