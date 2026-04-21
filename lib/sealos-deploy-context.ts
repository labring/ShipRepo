import { getDevboxNamespace } from '@/lib/devbox/config'

const SEALOS_DEPLOY_CONTEXT_HEADING = '## Sealos Deploy Context'
const DEFAULT_SEALOS_REGION = 'staging-usw-1'
const DEFAULT_SEALOS_REGION_URL = 'https://staging-usw-1.sealos.io'

function normalizeRegionUrl(regionUrl: string): string {
  return regionUrl.replace(/\/+$/, '')
}

function buildTemplateApi(regionUrl: string): string {
  const normalizedRegionUrl = normalizeRegionUrl(regionUrl)
  const regionHost = normalizedRegionUrl.replace(/^https?:\/\//, '')

  return `https://template.${regionHost}/api/v2alpha/templates/raw`
}

export function buildSealosDeployContextPrompt(namespace?: string | null): string {
  const resolvedNamespace = namespace?.trim() || getDevboxNamespace()
  const regionUrl = normalizeRegionUrl(DEFAULT_SEALOS_REGION_URL)

  return `${SEALOS_DEPLOY_CONTEXT_HEADING}

\`\`\`json
${JSON.stringify(
  {
    region: DEFAULT_SEALOS_REGION,
    region_url: regionUrl,
    namespace: resolvedNamespace,
    template_api: buildTemplateApi(regionUrl),
  },
  null,
  2,
)}
\`\`\``
}

export function prependSealosDeployContext(prompt: string, namespace?: string | null): string {
  if (prompt.includes(SEALOS_DEPLOY_CONTEXT_HEADING)) {
    return prompt
  }

  return `${buildSealosDeployContextPrompt(namespace)}\n\n${prompt}`
}
