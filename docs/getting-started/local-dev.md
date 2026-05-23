# Local Development

Teamem is a Bun project. The server uses Hono and SQLite, and the Claude Code
plugin uses bundled Bun entrypoints.

## Prerequisites

- Bun 1.2 or newer
- Git
- Docker, if you want to run the server with Docker Compose
- Claude Code, if you want to test the plugin

## Install

```bash
bun install
cp .env.example .env
```

Set `TEAMEM_JWT_SECRET` in `.env` before starting the server:

```bash
openssl rand -hex 32
```

## Run the server

With Docker Compose:

```bash
docker compose up --build -d
```

With Bun:

```bash
mkdir -p data
bun run server
```

## Build plugin bundles

```bash
bun run build:plugin
```

Run this after changing bridge, setup, or channel runtime code.

## Run the web control plane

Teamem Cloud's Next.js control plane lives in `apps/web`. Copy its own env
example before running it locally:

```bash
cp apps/web/.env.example apps/web/.env.local
cd apps/web
bun install
bun run dev
```

The web env includes Better Auth, GitHub OAuth, Supabase, the hosted runtime
provisioning token, and PostHog analytics settings. See
[Teamem Cloud Deployment](../deploy/teamem-cloud.md) for the full hosted
configuration.

## Test and verify

```bash
bun test
bun run typecheck
bun run lint
node_modules/.bin/prettier --check .
```

For bootstrapper-only changes:

```bash
cd packages/bootstrapper-cli
bun test ./tests
bun run typecheck
bun run build
```
