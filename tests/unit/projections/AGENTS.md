<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-09 | Updated: 2026-05-09 -->

# projections

## Purpose

Unit tests for projection handlers — the event-to-state mapping logic that updates claims, findings, focus, and pending-edits tables. Tests verify that `applyProjectionUpdate()` handlers match the inline UPDATEs performed by tools, ensuring rebuild-parity (events replayed through projections produce identical state).

## Key Files

| File | Description |
|------|-------------|
| `claim-lifecycle.test.ts` | Event handlers for `scope_claimed`, `scope_released`, `scope_released_via_git`, `claim_paused`, `claim_resumed`, `claim_force_released`, `claim_expired` — each test seeds a claim, applies one lifecycle event, asserts projection matches inline UPDATE |
| `pending-edits.test.ts` | `applyProjectionUpdate` for pending-edit tracking — queue, resolve, cancel operations |
| `focus-dedup.test.ts` | Focus event deduplication — agent focus changes are coalesced within 60s windows |
| `findings-ttl.test.ts` | Finding auto-expiry — findings expire 7 days after creation (or explicit clear) |

## For AI Agents

### Working In This Directory

- Projection tests use `:memory:` SQLite with all migrations applied.
- Each test seeds initial state (e.g., a scope_claimed event), applies one lifecycle event, then queries the projected table to verify state matches.
- The rebuild-parity invariant is critical: if a handler is missing, `rebuildProjections()` will silently corrupt state.

### Testing Requirements

- Every event type that tool code UPDATEs must have a handler in `applyProjectionUpdate()` and a corresponding test.
- Tests must verify that the projected state (SELECT from claims/findings/focus/pending_edits) matches what inline UPDATEs would produce.
- When adding a new event type, add the handler first, then add a test immediately.

### Common Patterns

- **Initial state**: `INSERT INTO spaces ...` and `INSERT INTO events (scope_claimed) ...` to seed base claim.
- **Apply event**: call `applyProjectionUpdate(db, event)` with the event to be projected.
- **Query result**: `db.prepare('SELECT ... FROM claims WHERE ...')` to inspect projected state.
- **Assertion**: compare `(released_at IS NOT NULL)` or `path` value against expected state after event application.

## Dependencies

### Internal

- `src/infra/projections/apply-event.js` — projection handlers (the code under test)
- `src/domain/events/types.js` — event shape definitions
- `tests/helpers/migrations.js` — database setup

### External

- `bun:test` — test runner
- `bun:sqlite` — in-memory database

<!-- MANUAL: CRITICAL: the rebuild-parity invariant states that every event type with an inline UPDATE in tools MUST have a handler here. Missing handlers cause silent corruption after rebuildProjections(). Audit before every release. -->
