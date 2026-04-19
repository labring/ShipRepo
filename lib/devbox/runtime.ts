import { eq } from 'drizzle-orm'
import { buildForcedCodexConfigToml, FORCED_CODEX_HOME, FORCED_CODEX_MODEL } from '@/lib/codex/defaults'
import { db } from '@/lib/db/client'
import { Task, tasks } from '@/lib/db/schema'
import { getUserApiKeys, resolveCodexGatewayFromApiKeys, type GatewayConfig } from '@/lib/api-keys/user-keys'
import { resolveCodexGatewayUrl } from '@/lib/codex-gateway/config'
import { createDevbox, DevboxApiError, execDevbox, getDevbox, listDevboxes } from '@/lib/devbox/client'
import { getDevboxArchiveAfterPauseTime, getDevboxDefaultImage, getDevboxNamespace } from '@/lib/devbox/config'
import { createTaskDevboxName } from '@/lib/devbox/naming'
import type { DevboxInfo, DevboxSshInfo } from '@/lib/devbox/types'
import { getUserGitHubToken } from '@/lib/github/user-token'
import type { TaskLogger } from '@/lib/utils/task-logger'
import { createAuthenticatedRepoUrl } from '@/lib/sandbox/config'

export interface TaskRuntimeSummary {
  provider: 'devbox'
  name: string
  namespace: string | null
  gatewayUrl: string | null
  state: string | null
  creationTimestamp: string | null
  deletionTimestamp: string | null
  ssh: {
    user: string
    host: string
    port: number
    target?: string
    link?: string
    command?: string
  } | null
}

interface EnsureTaskDevboxRuntimeOptions {
  githubToken?: string | null
  gatewayConfig?: GatewayConfig | null
  logger?: TaskLogger
}

const DEVBOX_SEAKILLS_INSTALL_COMMAND =
  'npx --yes skills add https://github.com/zjy365/seakills/tree/sandbox-skill-lite -y'
const DEVBOX_BOOTSTRAP_READY_TIMEOUT_MS = 60_000
const DEVBOX_BOOTSTRAP_READY_POLL_MS = 2_000
const DEVBOX_SKILL_INSTALL_MARKER = '__CODEX_SKILL_INSTALLED__:1'

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function getPauseAt(maxDurationMinutes: number | null): string {
  const durationMinutes = maxDurationMinutes || 300
  return new Date(Date.now() + durationMinutes * 60 * 1000).toISOString()
}

function sanitizeSshInfo(ssh?: DevboxSshInfo) {
  if (!ssh) {
    return null
  }

  return {
    user: ssh.user,
    host: ssh.host,
    port: ssh.port,
    target: ssh.target,
    link: ssh.link,
    command: ssh.command,
  }
}

function buildTaskRuntimeSummary(
  runtimeName: string,
  runtimeNamespace: string | null,
  gatewayUrl?: string | null,
  info?: DevboxInfo,
): TaskRuntimeSummary {
  return {
    provider: 'devbox',
    name: runtimeName,
    namespace: runtimeNamespace,
    gatewayUrl: gatewayUrl || null,
    state: info?.state.phase || null,
    creationTimestamp: info?.creationTimestamp || null,
    deletionTimestamp: info?.deletionTimestamp || null,
    ssh: sanitizeSshInfo(info?.ssh),
  }
}

async function clearMissingTaskRuntime(taskId: string) {
  await db
    .update(tasks)
    .set({
      runtimeProvider: null,
      runtimeName: null,
      runtimeNamespace: null,
      runtimeState: null,
      gatewayUrl: null,
      gatewaySessionId: null,
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, taskId))
}

async function ensureTaskWorkspaceBootstrapped(
  task: Task,
  runtimeName: string,
  githubToken: string | null,
  logger?: TaskLogger,
): Promise<{ installedSkill: boolean }> {
  const authenticatedRepoUrl = task.repoUrl ? createAuthenticatedRepoUrl(task.repoUrl, githubToken) : null
  const branchName = task.branchName?.trim() || ''
  const managedCodexConfigToml = buildForcedCodexConfigToml()
  const bootstrapScript = [
    'set -e',
    'home_dir="${HOME:-/root}"',
    'workspace_dir=""',
    'installed_codex_skill=0',
    'if [ -d "$home_dir/workspace" ]; then',
    '  workspace_dir="$home_dir/workspace"',
    'elif [ -d /workspace ]; then',
    '  workspace_dir="/workspace"',
    'elif [ -d /app ] && [ -f /app/package.json ]; then',
    '  workspace_dir="/app"',
    'elif [ -d "$home_dir/.git" ] || [ -f "$home_dir/package.json" ] || [ -d "$home_dir/src" ]; then',
    '  workspace_dir="$home_dir"',
    'else',
    '  workspace_dir="$PWD"',
    'fi',
    'mkdir -p "$workspace_dir"',
    `codex_home_dir="\${CODEX_GATEWAY_CODEX_HOME:-${FORCED_CODEX_HOME}}"`,
    'mkdir -p "$codex_home_dir"',
    `cat > "$codex_home_dir/config.toml" <<'EOF'
${managedCodexConfigToml}EOF`,
    'user_codex_home="$home_dir/.codex"',
    'mkdir -p "$user_codex_home"',
    `cat > "$user_codex_home/config.toml" <<'EOF'
${managedCodexConfigToml}EOF`,
  ]

  if (authenticatedRepoUrl) {
    bootstrapScript.push(
      'cd "$workspace_dir"',
      'if [ ! -d .git ]; then',
      '  tmpdir="$(mktemp -d)"',
      '  cleanup() { rm -rf "$tmpdir"; }',
      '  trap cleanup EXIT',
      branchName
        ? `  git clone --depth 1 --branch ${shellEscape(branchName)} ${shellEscape(authenticatedRepoUrl)} "$tmpdir/repo"`
        : `  git clone --depth 1 ${shellEscape(authenticatedRepoUrl)} "$tmpdir/repo"`,
      '  cp -a "$tmpdir/repo"/. .',
      'fi',
    )
  }

  bootstrapScript.push(
    'agent_skill_marker="$workspace_dir/.agents/skills/sealos-deploy/SKILL.md"',
    'codex_skill_marker="$workspace_dir/.codex/skills/sealos-deploy/SKILL.md"',
    'if [ ! -f "$agent_skill_marker" ] && [ ! -f "$codex_skill_marker" ]; then',
    '  cd "$workspace_dir"',
    `  ${DEVBOX_SEAKILLS_INSTALL_COMMAND}`,
    '  installed_codex_skill=1',
    'fi',
    'printf \'%s\\n\' "__CODEX_SKILL_INSTALLED__:$installed_codex_skill"',
  )

  await logger?.info('Bootstrapping Devbox workspace')

  const startedAt = Date.now()
  let lastPendingError = false

  while (true) {
    try {
      const runtime = await getDevbox(runtimeName)
      if (runtime.data.state.phase !== 'Running') {
        lastPendingError = true
        if (Date.now() - startedAt >= DEVBOX_BOOTSTRAP_READY_TIMEOUT_MS) {
          break
        }
        await sleep(DEVBOX_BOOTSTRAP_READY_POLL_MS)
        continue
      }

      const execResponse = await execDevbox(runtimeName, {
        command: ['sh', '-lc', bootstrapScript.join('\n')],
        timeoutSeconds: 300,
      })

      if (execResponse.data.exitCode !== 0) {
        console.error('Devbox workspace bootstrap failed')
        throw new Error('Failed to bootstrap Devbox workspace')
      }

      await logger?.success('Devbox workspace bootstrapped')
      return {
        installedSkill: execResponse.data.stdout.includes(DEVBOX_SKILL_INSTALL_MARKER),
      }
    } catch (error) {
      if (
        error instanceof DevboxApiError &&
        error.status === 409 &&
        error.message.includes('devbox pod is not running')
      ) {
        lastPendingError = true
        if (Date.now() - startedAt >= DEVBOX_BOOTSTRAP_READY_TIMEOUT_MS) {
          break
        }
        await sleep(DEVBOX_BOOTSTRAP_READY_POLL_MS)
        continue
      }

      throw error
    }
  }

  if (lastPendingError) {
    throw new Error('Timed out waiting for Devbox workspace bootstrap')
  }

  throw new Error('Devbox workspace bootstrap did not complete')
}

export async function ensureTaskDevboxRuntime(
  task: Task,
  options: EnsureTaskDevboxRuntimeOptions = {},
): Promise<TaskRuntimeSummary> {
  const logger = options.logger
  const githubToken = options.githubToken ?? (await getUserGitHubToken())

  if (task.runtimeName) {
    try {
      const existingRuntime = await getDevbox(task.runtimeName)
      const runtimeNamespace = task.runtimeNamespace || getDevboxNamespace()
      const gatewayUrl = resolveCodexGatewayUrl(task.runtimeName, task.gatewayUrl, existingRuntime.data)

      const bootstrapResult = await ensureTaskWorkspaceBootstrapped(task, task.runtimeName, githubToken, logger)

      await db
        .update(tasks)
        .set({
          runtimeProvider: 'devbox',
          runtimeName: task.runtimeName,
          runtimeNamespace,
          runtimeState: existingRuntime.data.state.phase,
          gatewayUrl,
          updatedAt: new Date(),
        })
        .where(eq(tasks.id, task.id))

      const runtimeSummary = buildTaskRuntimeSummary(
        task.runtimeName,
        runtimeNamespace,
        gatewayUrl,
        existingRuntime.data,
      )

      console.info('Devbox runtime info available')

      return runtimeSummary
    } catch (error) {
      if (!(error instanceof DevboxApiError && error.status === 404)) {
        throw error
      }

      await clearMissingTaskRuntime(task.id)
    }
  }

  const existingDevboxes = await listDevboxes(task.id)
  const existingDevbox = existingDevboxes.data.items[0]

  if (existingDevbox) {
    const runtimeNamespace = getDevboxNamespace()
    const gatewayUrl = resolveCodexGatewayUrl(existingDevbox.name, task.gatewayUrl)

    const bootstrapResult = await ensureTaskWorkspaceBootstrapped(task, existingDevbox.name, githubToken, logger)

    await db
      .update(tasks)
      .set({
        runtimeProvider: 'devbox',
        runtimeName: existingDevbox.name,
        runtimeNamespace,
        runtimeState: existingDevbox.state.phase,
        gatewayUrl,
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, task.id))

    await logger?.success('Linked existing Devbox runtime')

    const runtimeSummary: TaskRuntimeSummary = {
      provider: 'devbox',
      name: existingDevbox.name,
      namespace: runtimeNamespace,
      gatewayUrl,
      state: existingDevbox.state.phase,
      creationTimestamp: existingDevbox.creationTimestamp,
      deletionTimestamp: existingDevbox.deletionTimestamp,
      ssh: null,
    }

    console.info('Devbox runtime info available')

    return runtimeSummary
  }

  const gatewayConfig =
    options.gatewayConfig === undefined ? resolveCodexGatewayFromApiKeys(await getUserApiKeys()) : options.gatewayConfig

  const runtimeName = createTaskDevboxName(task.id)
  const runtimeEnv: Record<string, string> = {
    TASK_ID: task.id,
    CODEX_GATEWAY_HOST: '0.0.0.0',
    CODEX_GATEWAY_PORT: '1317',
    CODEX_GATEWAY_MODEL: FORCED_CODEX_MODEL,
    CODEX_GATEWAY_CODEX_HOME: FORCED_CODEX_HOME,
  }

  if (task.repoUrl) {
    runtimeEnv.REPO_URL = task.repoUrl
  }

  if (githubToken) {
    runtimeEnv.GITHUB_TOKEN = githubToken
  }

  if (gatewayConfig) {
    runtimeEnv.CODEX_GATEWAY_OPENAI_BASE_URL = gatewayConfig.baseUrl
    runtimeEnv.CODEX_GATEWAY_OPENAI_API_KEY = gatewayConfig.apiKey
  }

  if (process.env.CODEX_GATEWAY_JWT_SECRET) {
    runtimeEnv.CODEX_GATEWAY_JWT_SECRET = process.env.CODEX_GATEWAY_JWT_SECRET
  }

  await logger?.info('Creating Devbox runtime')

  const createResponse = await createDevbox({
    name: runtimeName,
    image: getDevboxDefaultImage(),
    upstreamID: task.id,
    kubeAccess: {
      enabled: true,
      roleTemplate: 'edit',
    },
    env: runtimeEnv,
    pauseAt: getPauseAt(task.maxDuration),
    archiveAfterPauseTime: getDevboxArchiveAfterPauseTime(),
    labels: [
      { key: 'app.kubernetes.io/component', value: 'runtime' },
      { key: 'app.kubernetes.io/managed-by', value: 'coding-agent-template' },
    ],
  })

  const infoResponse = await getDevbox(runtimeName)
  const gatewayUrl = resolveCodexGatewayUrl(runtimeName, task.gatewayUrl, infoResponse.data)

  const bootstrapResult = await ensureTaskWorkspaceBootstrapped(task, runtimeName, githubToken, logger)

  await db
    .update(tasks)
    .set({
      runtimeProvider: 'devbox',
      runtimeName,
      runtimeNamespace: createResponse.data.namespace,
      runtimeState: infoResponse.data.state.phase,
      gatewayUrl,
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, task.id))

  await logger?.success('Devbox runtime created')

  const runtimeSummary = buildTaskRuntimeSummary(
    runtimeName,
    createResponse.data.namespace,
    gatewayUrl,
    infoResponse.data,
  )

  console.info('Devbox runtime info available')

  return runtimeSummary
}
