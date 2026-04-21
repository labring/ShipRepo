function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

function getHostFromUrl(url: string): string {
  return normalizeUrl(url).replace(/^https?:\/\//, '')
}

function deriveRegionFromHost(host: string): string {
  return host.replace(/\.sealos\.io$/, '')
}

function normalizeHost(host: string): string {
  return getHostFromUrl(host)
}

function getRequiredEnv(name: 'SEALOS_HOST'): string {
  const value = process.env[name]
  if (!value?.trim()) {
    throw new Error('Missing required environment variable: SEALOS_HOST')
  }

  return value
}

export function getSealosHost(): string {
  return normalizeHost(getRequiredEnv('SEALOS_HOST'))
}

export function getSealosRegion(): string {
  return deriveRegionFromHost(getSealosHost())
}

export function getSealosRegionHost(): string {
  return getSealosHost()
}

export function getSealosRegionUrl(): string {
  return `https://${getSealosHost()}`
}

export function getSealosTemplateApiUrl(): string {
  return `https://template.${getSealosRegionHost()}/api/v2alpha/templates/raw`
}

export function getSealosDevboxBaseUrl(): string {
  return `https://devbox-server.${getSealosRegionHost()}`
}
