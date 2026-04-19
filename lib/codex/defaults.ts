// Chat tasks that run through Devbox -> Codex Gateway -> Codex app server are pinned here.
// Runtime env injection, gateway session creation, and managed Codex config all read these defaults.
export const FORCED_CODEX_MODEL = 'gpt-5.4'
export const FORCED_CODEX_REASONING_EFFORT = 'high'
export const FORCED_CODEX_HOME = '/codex-home'

export function buildForcedCodexConfigToml(): string {
  return [`model = "${FORCED_CODEX_MODEL}"`, `model_reasoning_effort = "${FORCED_CODEX_REASONING_EFFORT}"`, ''].join(
    '\n',
  )
}
