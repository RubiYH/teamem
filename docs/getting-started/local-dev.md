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
