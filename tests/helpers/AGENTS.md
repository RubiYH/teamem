<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-09 | Updated: 2026-05-10 -->

# helpers

## Purpose

Shared test utilities and harnesses used across all test suites. Includes database migration runners, JWT minting, marketplace environment simulation, and credential file helpers.

## Key Files

| File | Description |
|------|-------------|
| `migrations.ts` | `runAllMigrations(db)` — applies 001, 002, 003 in order; `runMigration(db, path)` wrapper |
| `auth.ts` | `mintTestJwt({ space_id, member_name, exp? })` — creates signed JWT with `TEST_JWT_SECRET` |
| `marketplace-env.ts` | `setupMarketplaceEnv()` and related utilities for simulating Claude Code marketplace plugin environment |
| `tool-subprocess.ts` | Runs tool calls in separate Bun subprocesses against one SQLite file to exercise real cross-connection concurrency |
| `http-server.ts` | Starts test HTTP servers on explicit loopback candidate ports and returns a close wrapper |

## For AI Agents

### Working In This Directory

- These are not test files themselves; they export utility functions imported by test files.
- Keep helpers deterministic — no `Date.now()` side effects except where time manipulation is explicit (e.g., `exp` param in JWT).
- Each helper should be granular and composable (e.g., `runAllMigrations` composes `runMigration`).

### Testing Requirements

- N/A — these ARE helpers used by tests elsewhere.

### Common Patterns

- **Migration runner**: Call `runAllMigrations(db)` in test setup to get a fresh, fully-migrated database.
- **JWT generation**: `mintTestJwt({ space_id: 'sp-xxx', member_name: 'alice' })` returns a valid HS256 JWT.
- **Marketplace simulation**: `setupMarketplaceEnv()` mocks Claude Code plugin environment variables and data paths.
- **Concurrency helper**: Use `tool-subprocess.ts` for SQLite transaction race tests. In-process `Promise.all()` can share one SQLite connection and miss cross-connection lock behavior; socket/free-port harnesses add TOCTOU flake.
- **HTTP helper**: Prefer `http-server.ts` for setup-flow tests that need real fetch. Some sandboxes block loopback bind; if the helper-based suite fails with local bind permission errors, rerun the same test command with approved sandbox escalation rather than replacing it with a fake transport.

## Dependencies

### Internal

- `src/infra/db/sqlite-client.js` — `createSqliteClient`, `runMigration`
- `src/server/jwt.js` — `signJwt` (for auth.ts)
- `src/infra/db/migrations/` — all SQL migration files

### External

- `bun:test` (used by dependents, not by helpers directly)
- `hono/jwt` — JWT signing (via `sign` function)
- `node:fs/promises`, `node:path` — filesystem operations (for marketplace-env.ts)

<!-- MANUAL: -->
