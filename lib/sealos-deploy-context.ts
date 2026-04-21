import { getDevboxNamespace } from '@/lib/devbox/config'
import { getSealosRegion, getSealosRegionUrl, getSealosTemplateApiUrl } from '@/lib/sealos/config'

const SEALOS_DEPLOY_CONTEXT_HEADING = '## Sealos Deploy Context'

export function buildSealosDeployContextPrompt(namespace?: string | null): string {
  const resolvedNamespace = namespace?.trim() || getDevboxNamespace()
  const region = getSealosRegion()
  const regionUrl = getSealosRegionUrl()

  return `${SEALOS_DEPLOY_CONTEXT_HEADING}

\`\`\`json
${JSON.stringify(
  {
    region,
    region_url: regionUrl,
    namespace: resolvedNamespace,
    template_api: getSealosTemplateApiUrl(),
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
