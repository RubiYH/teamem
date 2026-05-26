<!-- Parent: ../../AGENTS.md -->
<!-- Created: 2026-05-26 -->

# web

## Purpose

Teamem Cloud Next.js control plane. This app handles web authentication,
dashboard UI, control-plane persistence, hosted runtime provisioning, PostHog
analytics, and deployment smoke checks. It is not the Teamem runtime identity;
runtime Spaces, member identity, coordination, MCP tools, and plugin delivery
remain in the runtime/plugin surfaces.

## Key Files

| File | Description |
| --- | --- |
| `package.json` | Next.js scripts: `dev`, `build`, `start`, `typecheck`, `smoke:deploy`, `smoke:i18n` |
| `.env.example` | Canonical Teamem Cloud web env contract |
| `db/migrations/` | Control-plane SQL migrations |
| `scripts/deploy-smoke.ts` | Env and database-table deploy smoke |
| `scripts/i18n-smoke.ts` | Metadata/i18n smoke |
| `src/server/` | Server-side dashboard, auth, provisioning, and control-plane logic |
| `messages/` | English and Korean user-facing strings |

## For AI Agents

### Working In This Directory

- Keep web account identity separate from runtime member identity in code,
  copy, analytics, and setup commands.
- Keep `TEAMEM_CLOUD_RUNTIME_URL` aligned with the runtime's
  `TEAMEM_PUBLIC_URL`; setup commands shown to users must point at the runtime
  users can actually reach.
- Do not import `server-only` guarded web modules into CLI/runtime migration
  paths. Keep deploy/migration helpers runnable outside the Next.js request
  runtime when they are used by scripts.
- Keep PostHog client and server usage best-effort. Analytics failures must not
  block core setup, dashboard, or runtime-management paths.
- Update both `messages/en.json` and `messages/ko.json` for user-facing copy.

### Deployment And Env

- `apps/web/.env.example` is the canonical web env contract. Update it whenever
  web env validation, deploy smoke, auth, OAuth, Supabase, PostHog, or runtime
  provisioning config changes.
- Control-plane migrations are ordered and forward-only. Existing deployments
  that already ran an older migration must receive additive/backfill migrations,
  not edited historical SQL.
- Keep `docs/deploy/teamem-cloud.md`, root README references, and local-dev
  guidance aligned with web env and deployment behavior.
- Free-trial policy is copied into control-plane records for durability. Runtime
  provisioning failures that are terminal can void a reserved grant; uncertain
  runtime responses must not silently consume user quota without a retry path.

### Testing Requirements

Run focused checks from `apps/web/` before declaring web changes complete:

```bash
bun run typecheck
bun run build
bun run smoke:i18n
```

For deploy/env/database changes, also run when the required env is available:

```bash
bun run smoke:deploy
```

From the repo root, `bun run web:smoke:deploy` runs the deploy smoke in this
package.

## Dependencies

### Internal

- Root `src/cloud/` env/provisioning contracts
- Runtime cloud-admin provisioning endpoints
- `docs/deploy/teamem-cloud.md`

### External

- Next.js, React, `next-intl`
- Supabase, Postgres, Better Auth
- PostHog client and server SDKs

<!-- MANUAL: -->
