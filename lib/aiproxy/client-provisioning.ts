'use client'

let aiProxyProvisioningTask: Promise<boolean> | null = null
let aiProxyKubeconfig: string | null = null
let aiProxyKubeconfigTask: Promise<string | null> | null = null

export function registerAiProxyKubeconfig(kubeconfig: string): void {
  const normalizedKubeconfig = kubeconfig.trim()

  if (normalizedKubeconfig) {
    aiProxyKubeconfig = normalizedKubeconfig
  }
}

export function registerAiProxyKubeconfigTask(task: Promise<string | null | undefined>): void {
  aiProxyKubeconfigTask = task
    .then((kubeconfig) => {
      const normalizedKubeconfig = kubeconfig?.trim() || null

      if (normalizedKubeconfig) {
        aiProxyKubeconfig = normalizedKubeconfig
      }

      return normalizedKubeconfig
    })
    .catch(() => null)
}

export function getAiProxyProvisioningTask(runProvisioning: () => Promise<boolean>): Promise<boolean> {
  if (!aiProxyProvisioningTask) {
    aiProxyProvisioningTask = runProvisioning()
      .catch(() => false)
      .finally(() => {
        aiProxyProvisioningTask = null
      })
  }

  return aiProxyProvisioningTask
}

async function resolveAiProxyKubeconfig(): Promise<string | null> {
  if (aiProxyKubeconfig) {
    return aiProxyKubeconfig
  }

  if (!aiProxyKubeconfigTask) {
    return null
  }

  return await aiProxyKubeconfigTask
}

async function requestAiProxyProvisioning(kubeconfig: string | null): Promise<boolean> {
  const response = await fetch('/api/aiproxy/provision', {
    body: JSON.stringify(kubeconfig ? { kubeconfig } : {}),
    headers: {
      'Content-Type': 'application/json',
    },
    method: 'POST',
  })

  if (!response.ok) {
    return false
  }

  const body = (await response.json().catch(() => null)) as { success?: unknown } | null
  return body?.success === true
}

export async function ensureAiProxyProvisioned(): Promise<boolean> {
  const kubeconfig = await resolveAiProxyKubeconfig()
  return await getAiProxyProvisioningTask(() => requestAiProxyProvisioning(kubeconfig))
}

export function resetAiProxyProvisioningTaskForTests(): void {
  aiProxyProvisioningTask = null
  aiProxyKubeconfig = null
  aiProxyKubeconfigTask = null
}
