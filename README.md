# Analyze and Ship to Sealos

Analyze and Ship to Sealos is a Next.js app for running Sealos-focused coding and deployment tasks against GitHub repositories. A user selects a repo, submits a command, and the app runs a fixed `codex` + `gpt-5.4` execution path inside a Devbox runtime while surfacing logs, diffs, runtime state, and preview links in the UI.

![Analyze and Ship to Sealos Screenshot](screenshot.png)

## Why This Project Exists

- Turn a GitHub repository and a deployment-oriented prompt into a tracked task.
- Keep Sealos deployment work on a single, opinionated execution path instead of a generic agent router.
- Combine runtime management, chat, file changes, preview controls, and repository context in one app.
- Support per-user GitHub authentication, API keys, and connectors.

## What Developers Get

- A home command surface for starting Sealos deployment tasks.
- Task pages with logs, chat, file browsing, diff inspection, runtime controls, and preview actions.
- Repository pages for commits, issues, and pull requests.
- Persistent task state in Postgres through Drizzle ORM.
- Codex Gateway orchestration layered on top of Devbox runtime lifecycle management.

## Tech Stack

- Next.js 16
- React 19
- Tailwind CSS
- shadcn/ui
- PostgreSQL
- Drizzle ORM and drizzle-kit
- AI SDK 5
- Codex Gateway
- Devbox runtime infrastructure

## Quick Start

### Prerequisites

- Node.js 20+
- pnpm 9+
- A PostgreSQL database
- A GitHub OAuth app
- Access to the Sealos and Devbox environment this app targets
- An AI gateway key for Codex execution, unless you plan to provide user-scoped keys in the app

### 1. Install dependencies

```bash
git clone <your-repository-url>
cd ShipRepo
pnpm install
```

### 2. Configure environment variables

Create `.env.local`:

```bash
POSTGRES_URL=
SEALOS_HOST=
DEVBOX_TOKEN=
JWE_SECRET=
ENCRYPTION_KEY=
NEXT_PUBLIC_AUTH_PROVIDERS=github
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
AI_GATEWAY_API_KEY=
```

Optional:

- `APP_BASE_URL` for self-hosted callback overrides
- `NPM_TOKEN` for private npm installs inside task runtimes
- `MAX_SANDBOX_DURATION` to change the default runtime timeout
- `MAX_MESSAGES_PER_DAY` to change the per-user daily message limit

### 3. Apply database migrations

```bash
pnpm db:migrate
```

`drizzle.config.ts` loads `.env.local` first and falls back to `.env`, so `POSTGRES_URL` must be available before running Drizzle commands.

### 4. Start the app

```bash
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000), sign in with GitHub, choose a repository, and submit a Sealos-oriented task.

## Core Workflow

1. A user signs in with GitHub.
2. The home page lets the user choose a repository and submit a deployment-oriented command.
3. The app creates a task, stores it in Postgres, and starts the fixed `codex` + `gpt-5.4` flow.
4. A Devbox runtime is provisioned or resumed for the task.
5. The task is executed through the Codex Gateway.
6. The task page shows logs, runtime state, file changes, preview actions, and follow-up chat.

## Project Structure

- `app/`: Next.js App Router pages and API routes
- `components/`: UI for the home page, task workspace, repo views, auth, and dialogs
- `lib/codex-gateway/`: Codex Gateway sessions, turns, streaming, and completion handling
- `lib/devbox/`: runtime provisioning, reuse, health checks, and lease refresh
- `lib/db/`: schema, queries, settings, and checked-in migrations
- `lib/session/` and `lib/auth/`: authentication and session handling
- `app/repos/[owner]/[repo]/`: repository pages for commits, issues, and pull requests
- `app/tasks/[taskId]/`: task workspace entry point

## Further Reading

- [reference/architecture.md](reference/architecture.md): request flow, runtime lifecycle, and module boundaries
- [reference/configuration.md](reference/configuration.md): environment variables, auth setup, migrations, and runtime behavior

## Development

### Common commands

```bash
pnpm dev
pnpm build
pnpm type-check
pnpm lint
pnpm format
```

### Database commands

```bash
pnpm db:generate
pnpm db:migrate
pnpm db:studio
```

## Configuration Notes

- The current task execution path is intentionally pinned to `codex` + `gpt-5.4`.
- `NEXT_PUBLIC_AUTH_PROVIDERS` is expected to include `github`.
- Users can provide their own API keys in the app, which can override global key configuration.
- Connectors are managed from the application UI; if a connector stores OAuth credentials, `ENCRYPTION_KEY` must be set.

## Contributing

1. Fork the repository.
2. Create a branch for your change.
3. Run `pnpm format`, `pnpm type-check`, and `pnpm lint`.
4. Verify the change locally.
5. Open a pull request.

## License

Licensed under Apache 2.0. See [LICENSE](LICENSE).
