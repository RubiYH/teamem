<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-09 | Updated: 2026-05-09 -->

# auth

## Purpose

Tests for space creation, JWT issuance, authentication middleware, and space governance routes (disband, restore, join). These tests verify the HTTP server's auth layer: token generation, credential validation, space lifecycle boundaries (disbanded state), and room-code-based join flows.

## Key Files

| File | Description |
|------|-------------|
| `spaces.test.ts` | AC2 suite — POST /spaces (create + JWT), rate limiting, auth middleware |
| `disband-cascade.test.ts` | Soft-disband behavior — projection rows survive, JWT rejects with 410 |
| `disband-prevents-join.test.ts` | F27 regression — disbanded spaces reject join attempts with leaked room codes |
| `helpers.ts` | setupAuthApp() to boot test HTTP server + in-memory SQLite |

## For AI Agents

### Working In This Directory

- Import `setupAuthApp()` from `helpers.ts` to boot a test Hono + SQLite instance with JWT signing enabled.
- Tests use `bun:test` with in-memory SQLite (`:memory:`) and pre-seed spaces via `POST /spaces`.
- All auth routes return JSON responses; assert `res.status` and `res.json()` payloads.
- JWT validation is enforced by `src/server/auth.ts` middleware; tests pass tokens via `Authorization: Bearer` header.

### Testing Requirements

- Verify JWT generation in `POST /spaces` returns valid token with correct claims.
- Space lifecycle boundary checks: abandoned spaces reject all operations with `410 space_disbanded`.
- Room-code joins must check `spaces.disbanded_at` to prevent leaked-code attacks during grace window.
- Auth middleware must rate-limit failed token checks per space to prevent brute-force attacks.

### Common Patterns

- Helper `post(app, path, body, token?)` abstracts HTTP request setup with optional Bearer token.
- Space seeding: `POST /spaces` returns `{ space_id, jwt, room_code }` tuple.
- Cascading tests use `seedRowsForSpace(db, space_id, prefix)` to populate claims/members before disband.

## Dependencies

### Internal

- `src/server/auth.ts` (JWT middleware, auth checks)
- `src/server/spaces.ts` (disband, restore, join routes)
- `src/infra/db/` (in-memory SQLite)

### External

- `bun:test`
- `hono` (test app via setupAuthApp)

<!-- MANUAL: -->
