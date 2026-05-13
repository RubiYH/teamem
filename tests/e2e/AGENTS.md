<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-09 | Updated: 2026-05-10 -->

# e2e

## Purpose

End-to-end integration tests that exercise the full bridge → server → database roundtrip without network boundaries. Tests here spin up an in-process Hono server, apply real migrations, exercise real tool bindings, and verify full lifecycle behaviors (space creation, authentication, concurrent claims, release logic).

## Key Files

| File | Description |
|------|-------------|
| `bridge-server-roundtrip.test.ts` | Full bridge + server + DB roundtrip with real JWT auth; tests tool responses and error codes |
| `setup-create.test.ts` | Space creation flow (POST /spaces) and JWT minting |
| `setup-join.test.ts` | Member joining via room code and credentials file persistence |
| `concurrent-claim-race.test.ts` | Multiple agents claiming same path simultaneously; atomicity and conflict detection |
| `bridge-after-disband.test.ts` | Space disband and member eviction; POST /tools on disbanded space returns 410 |
| `bridge-expiry-warning.test.ts` | TTL-mode claims with `lease_seconds`; expiry checks and warning logic |
| `multi-space-corruption.test.ts` | Verify claims in one space don't leak into another via wrong `space_id` |
| `mcp-auth-bypass-regression.test.ts` | Auth validator regression — no bypass via malformed JWT or missing space_id |
| `mcp-auth-bypass-fuzz.test.ts` | Fuzz test of auth bypass vectors (bad tokens, missing headers, etc.) |

## For AI Agents

### Working In This Directory

- Each test spins up a `new Hono()` app with `createRouter(tools, db, jwtSecret)` and JWT middleware.
- Use `:memory:` SQLite and run all migrations via `runAllMigrations(db)` in setup.
- Call `resetRateLimitBuckets()` and `resetAuthCheckLogBuckets()` before each test to isolate rate-limit state.
- The bridge's HTTP client methods (via `app.request()`) return responses that match the tool binding schemas.

### Testing Requirements

- Every JWT claim assertion must use the same `TEST_JWT_SECRET` across all test instances.
- Verify both success (2xx) and error (4xx, 5xx) response codes, especially auth failures (401, 403).
- For concurrent tests, use `Promise.all()` to launch multiple simultaneous requests, then check claim state consistency.
- Assert that response bodies match the expected shape (use `expect(res.json()).toMatchObject({ ... })`).
- For true SQLite lock/race coverage, prefer separate subprocesses/SQLite connections over a single in-process connection. `concurrent-claim-race.test.ts` uses `tests/helpers/tool-subprocess.ts` for this reason.
- Setup CLI e2e tests may need a real local HTTP server. In sandboxed runners, loopback bind failures are environmental; keep the helper path and rerun with appropriate permission instead of downgrading the test to an in-process fake.

### Common Patterns

- **Server setup**: `setupServerApp()` returns `{ app, db }` with all middleware and routes wired.
- **Bootstrap space**: `bootstrapAlice(app)` creates a space via POST /spaces, returns `{ space_id, jwt }`.
- **Mint JWT**: `mintTestJwt({ space_id, member_name, exp? })` — uses `TEST_JWT_SECRET`.
- **Tool invocation**: `app.request('/tools/teamem.claim_scope', { method: 'POST', body: JSON.stringify(...), headers: { 'Authorization': `Bearer ${jwt}` } })`.
- **Snapshot assertions**: store initial state (e.g., claims before operation), then compare after operation to verify mutations.
- **No free-port reservation**: Avoid helpers that "reserve" a free port by binding and closing before the real server starts. That creates a TOCTOU race. Start the actual server on explicit loopback candidate ports and close it through the returned server handle.

## Dependencies

### Internal

- `src/infra/db/sqlite-client.js`, `src/infra/db/sqlite-event-store.js` — DB and event store
- `src/server/tools/index.js` — tool factory
- `src/server/routes.js` — Hono router
- `src/server/auth.js` — JWT middleware
- `src/server/rate-limit.js` — rate limiter state management
- `tests/helpers/migrations.js`, `tests/helpers/auth.js` — shared setup helpers

### External

- `bun:test` — test runner
- `hono` — HTTP server framework
- `node:path` — path utilities

<!-- MANUAL: -->
