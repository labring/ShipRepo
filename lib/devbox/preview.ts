import { eq } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { type Task, tasks } from '@/lib/db/schema'
import { buildDevboxUrl, execInTaskWorkspace, ensureOwnedTaskRuntime } from '@/lib/devbox/task-compat'

export interface TaskPreviewRuntime {
  packageJson: Record<string, unknown>
  packageManager: 'pnpm' | 'yarn' | 'npm'
  port: number
  previewUrl: string | null
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function detectPreviewPort(packageJson: Record<string, unknown>): number {
  const dependencies = (packageJson.dependencies as Record<string, unknown> | undefined) || {}
  const devDependencies = (packageJson.devDependencies as Record<string, unknown> | undefined) || {}
  const hasVite = 'vite' in dependencies || 'vite' in devDependencies

  return hasVite ? 5173 : 3000
}

function buildViteOverride(): string {
  return `import { defineConfig, mergeConfig } from 'vite'

let userConfig = {}
try {
  const importedConfig = await import('./vite.config.js')
  userConfig = importedConfig.default || {}
} catch {
  userConfig = {}
}

export default mergeConfig(userConfig, defineConfig({
  server: {
    host: '0.0.0.0',
    strictPort: false,
    allowedHosts: true,
  }
}))`
}

async function readPackageJson(task: Task): Promise<Record<string, unknown> | null> {
  const { result } = await execInTaskWorkspace(task, 'if [ -f package.json ]; then cat package.json; fi', {
    timeoutSeconds: 30,
  })

  const content = result.stdout.trim()
  if (!content) {
    return null
  }

  return JSON.parse(content) as Record<string, unknown>
}

async function detectPackageManager(task: Task): Promise<'pnpm' | 'yarn' | 'npm'> {
  const { result } = await execInTaskWorkspace(
    task,
    [
      'if [ -f pnpm-lock.yaml ]; then',
      "  printf 'pnpm\\n'",
      'elif [ -f yarn.lock ]; then',
      "  printf 'yarn\\n'",
      'else',
      "  printf 'npm\\n'",
      'fi',
    ].join('\n'),
    { timeoutSeconds: 20 },
  )

  const packageManager = result.stdout.trim()
  return packageManager === 'pnpm' || packageManager === 'yarn' ? packageManager : 'npm'
}

async function installDependencies(task: Task, packageManager: 'pnpm' | 'yarn' | 'npm') {
  let installCommand = 'npm install --no-audit --no-fund'

  if (packageManager === 'pnpm') {
    installCommand = 'pnpm config set store-dir /tmp/pnpm-store && pnpm install --frozen-lockfile'
  } else if (packageManager === 'yarn') {
    installCommand = 'yarn install --frozen-lockfile'
  }

  await execInTaskWorkspace(task, installCommand, { timeoutSeconds: 600 })
}

function getDevCommand(packageJson: Record<string, unknown>, packageManager: 'pnpm' | 'yarn' | 'npm') {
  const dependencies = (packageJson.dependencies as Record<string, unknown> | undefined) || {}
  const devDependencies = (packageJson.devDependencies as Record<string, unknown> | undefined) || {}
  const hasVite = 'vite' in dependencies || 'vite' in devDependencies
  const nextVersion = String(dependencies.next || devDependencies.next || '')
  const isNext16 = nextVersion.startsWith('16.') || nextVersion.startsWith('^16.') || nextVersion.startsWith('~16.')

  let command = packageManager === 'npm' ? 'npm run dev' : `${packageManager} dev`

  if (hasVite) {
    command =
      packageManager === 'npm'
        ? 'npm run dev -- --config vite.sandbox.config.js --host 0.0.0.0'
        : `${packageManager} dev --config vite.sandbox.config.js --host 0.0.0.0`
  } else if (isNext16) {
    command = packageManager === 'npm' ? 'npm run dev -- --webpack' : `${packageManager} dev --webpack`
  }

  return { command, hasVite }
}

export async function ensureTaskPreviewRuntime(task: Task): Promise<TaskPreviewRuntime> {
  const { task: runtimeTask, runtimeName } = await ensureOwnedTaskRuntime(task)
  const packageJson = await readPackageJson(runtimeTask)

  if (!packageJson) {
    throw new Error('No package.json found in runtime workspace')
  }

  const scripts = (packageJson.scripts as Record<string, unknown> | undefined) || {}
  if (typeof scripts.dev !== 'string' || !scripts.dev.trim()) {
    throw new Error('No dev script found in package.json')
  }

  const packageManager = await detectPackageManager(runtimeTask)
  await installDependencies(runtimeTask, packageManager)

  const port = detectPreviewPort(packageJson)
  const previewUrl = buildDevboxUrl(runtimeName, port)

  return {
    packageJson,
    packageManager,
    port,
    previewUrl,
  }
}

export async function startTaskPreview(task: Task): Promise<{
  runtimeName: string
  previewUrl: string | null
  port: number
}> {
  const { task: runtimeTask, runtimeName } = await ensureOwnedTaskRuntime(task)
  const preview = await ensureTaskPreviewRuntime(runtimeTask)
  const { command, hasVite } = getDevCommand(preview.packageJson, preview.packageManager)
  const baseCommand = [
    `lsof -ti:${preview.port} | xargs -r kill -9 2>/dev/null || true`,
    hasVite
      ? `cat > vite.sandbox.config.js <<'EOF'
${buildViteOverride()}
EOF`
      : null,
    `nohup sh -lc ${shellEscape(command)} > .codex-devserver.log 2>&1 &`,
    'sleep 3',
  ]
    .filter(Boolean)
    .join('\n')

  await execInTaskWorkspace(runtimeTask, baseCommand, { timeoutSeconds: 60 })

  await db
    .update(tasks)
    .set({
      sandboxUrl: preview.previewUrl,
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, runtimeTask.id))

  return {
    runtimeName,
    previewUrl: preview.previewUrl,
    port: preview.port,
  }
}

export async function stopTaskPreview(task: Task): Promise<void> {
  const preview = await ensureTaskPreviewRuntime(task)
  await execInTaskWorkspace(
    task,
    [`lsof -ti:${preview.port} | xargs -r kill -9 2>/dev/null || true`, 'sleep 1'].join('\n'),
    { timeoutSeconds: 30 },
  )
}
