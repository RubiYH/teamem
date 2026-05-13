<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-09 | Updated: 2026-05-09 -->

# server

## Purpose

Unit tests for server-side logic: MCP authentication validator, JWT middleware behavior, rate limiting, and route-level auth gates. Tests here use an in-process Hono server with real SQLite and JWT secrets.

## Key Files

| File | Description |
|------|-------------|
| `mcp-auth-validator.test.ts` | AC1-AC8b, AC15, AC15b — /mcp auth gate (JWT validation, space membership check, JWT expiry), rate-limit bucket isolation, no bypass via malformed token or missing space_id |

## For AI Agents

### Working In This Directory

- Server unit tests stand up a real Hono app with `createRouter()` and JWT middleware.
- Use `:memory:` SQLite with full migrations applied for isolated test state.
- Reset rate-limit and auth-log buckets between tests via `resetRateLimitBuckets()` and `resetAuthCheckLogBuckets()`.

### Testing Requirements

- Test both success (200) and failure paths (401, 403, 429) for every auth gate.
- Verify that rate-limit buckets are independent per principal + space + operation.
- Verify that JWT expiry is checked and tokens older than `exp` are rejected.

### Common Patterns

- **Server setup**: `buildApp({ jwtSecret?, allowNoAuth? })` returns configured Hono app with auth middleware.
- **Request**: `app.request('/tools/teamem.claim_scope', { method: 'POST', body: JSON.stringify(...), headers: { 'Authorization': `Bearer ${jwt}` } })`.
- **Response check**: `expect(response.status).toBe(200)` or `.toBe(401)` depending on auth outcome.
- **Rate limit**: loop N+1 times, expect N successes and the N+1-th to fail with 429 (Too Many Requests).

## Dependencies

### Internal

- `src/server/routes.js`, `src/server/auth.js` — router and auth middleware (code under test)
- `src/infra/db/sqlite-client.js`, `src/infra/db/sqlite-event-store.js` — DB setup
- `src/server/tools/index.js` — tool factory
- `tests/helpers/migrations.js`, `tests/helpers/auth.js` — database and JWT helpers

### External

- `bun:test` — test runner
- `hono` — HTTP server framework

<!-- MANUAL: The /mcp endpoint is a critical security boundary. Changes to auth logic require comprehensive test updates. When adding a new rate-limit bucket or auth check, add corresponding tests immediately. -->
