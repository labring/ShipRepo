import { getDevboxNamespace } from '@/lib/devbox/config'
import { getSealosRegion, getSealosRegionUrl, getSealosTemplateApiUrl } from '@/lib/sealos/config'

const SEALOS_DEPLOY_CONTEXT_HEADING = '## ShipRepo Context'
const SEALOS_DEPLOY_TASK_CONTRACT = `## ShipRepo Task Contract

Your primary goal is to prepare and deploy the selected repository to Sealos.

Use the built-in Sealos deployment skill when it is available. That skill owns the deployment workflow and should handle analysis, fixes, preview, and shipping steps as needed.

Do not broaden the task into unrelated coding, refactoring, or lifecycle operations unless the user explicitly asks for them. If required deployment information is missing, ask only for the missing deployment input.`

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

  return `${buildSealosDeployContextPrompt(namespace)}\n\n${SEALOS_DEPLOY_TASK_CONTRACT}\n\n${prompt}`
}
