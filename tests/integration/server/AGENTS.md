<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-09 | Updated: 2026-05-09 -->

# server

## Purpose

Integration tests for the core server tools: claim scope with branch isolation, claim lifecycle modes (manual_only, ttl, on_commit), and git-driven release. Tests the full tool → event → projection cycle in-process against in-memory SQLite.

## Key Files

| File | Description |
|------|-------------|
| `claim-scope-branch.test.ts` | Branch isolation — same path on different branches do not block each other |
| `claim-scope-manual-modes.test.ts` | Slice #34 — mode semantics (expires_at nullability), lease_seconds validation, mode stickiness |
| `idempotency-collision.test.ts` | Idempotency keys prevent duplicate event emission on retried requests |
| `release-scope-via-git.test.ts` | Release via git evidence (HEAD_SHA_AT_ACQUIRE, current_head_sha validation) |
| `claim-scope-manual-modes.test.ts` | TTL expiry and lease_seconds enforcement |
| `boot-warning.test.ts` | Server boots without errors (smoke test for entrypoint) |
| `log-volume-rate-limit.test.ts` | Rate limiting on log volume per space |
| `mcp-streamable-http.test.ts` | HTTP chunked response support for streaming tool results |
| `spaces-join-race.test.ts` | Concurrent join attempts race condition handling |
| `test-fixture-audit.test.ts` | Event fixtures are valid JSON and typed correctly |

## For AI Agents

### Working In This Directory

- All tests use in-memory SQLite (`:memory:`) with migrations applied via `runAllMigrations(db)`.
- Import `createTeamemTools({ db, store })` to get the tool object.
- Call tool methods directly: `tools.claimScope(...)`, `tools.releaseScope(...)`, etc.
- Assert result objects have `.ok` boolean + `.data` payload (success) or `.error` (failure).
- Use `resetRateLimitBuckets()` in beforeEach to clear transient state.

### Testing Requirements

- **Branch isolation**: claims on feature/alice do NOT block claims on main for same path.
- **Mode semantics**: manual_only and on_commit have `expires_at IS NULL`; ttl has `expires_at = now + lease_seconds`.
- **Schema validation**: Server rejects ttl claims with `lease_seconds <= 0`; rejects manual_only/on_commit with lease_seconds (ttl-only field).
- **Git release**: evaluateRelease() checks SHA format (40 lowercase hex) and rejects invalid.
- **Idempotency**: Same idempotency_key emits event once, retries return cached result.
- **Rate limiting**: Exceed log-volume threshold per space → subsequent calls return error (recovers on time).
- **TTL expiry**: Query-time expiry check allows new claim from different principal on expired ttl claim.

### Common Patterns

- Helper `buildTestDb()` creates fresh `:memory:` DB with all migrations.
- Helper `seedActiveClaim()` creates a claim and returns claim_id for follow-up tests.
- Pass override objects to tools: `{ space_id, principal, actor, delegation, scope, repo_id, branch, auto_release_mode }`.
- Query claims table directly: `db.prepare('SELECT * FROM claims WHERE ...')` to assert projection state.

## Dependencies

### Internal

- `src/server/tools/index.ts` (tool implementations)
- `src/infra/db/sqlite-event-store.ts` (event log)
- `src/infra/projections/` (claim/member/decision tables)
- `src/server/rate-limit.ts` (rate limiting)
- `src/domain/git-evidence.ts` (release validation)

### External

- `bun:test`
- `bun:sqlite` (Database)

<!-- MANUAL: -->
