<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-09 | Updated: 2026-05-09 -->

# projections

## Purpose

Tests for projection rebuild parity: verifies that replaying all event types through `rebuildProjections()` produces identical claim/member/decision rows as inline UPDATE statements in the live tools. Every event type must have a handler in `src/infra/projections/apply-event.ts`, or rebuild silently corrupts state.

## Key Files

| File | Description |
|------|-------------|
| `rebuild-claim-lifecycle.test.ts` | Slice #14 — sequence claim-lifecycle events and assert rebuilt state matches live UPDATEs |

## For AI Agents

### Working In This Directory

- Tests use real event types (scope_claimed, scope_released, scope_released_via_git, claim_paused, claim_resumed, claim_force_released) from `src/domain/events/types.ts`.
- Sequence events into the event log, then call `rebuildProjections(db)` on a fresh DB.
- Assert the rebuilt claims table row-for-row matches what a live claim.scope tool would have produced.
- Use helper `claimEvent(opts)`, `releaseEvent(opts)`, etc. to build typed event objects.

### Testing Requirements

- For each event type, verify a handler exists in `apply-event.ts` (add one if missing).
- Ensure event-to-projection mapping is faithful: schema_version matches, all fields preserved, no side effects.
- Test event sequences: claim → pause → resume → force_release should produce correct final state.
- Verify projection rebuild is deterministic: running twice on same logs produces same schema.

### Common Patterns

- Helper `setup()` creates in-memory DB with all migrations.
- Insert space row and members (requester auth).
- Build typed event objects and append to store.
- Call `rebuildProjections(db)` and query `claims` table to assert state.

## Dependencies

### Internal

- `src/infra/projections/rebuild.ts` (rebuild logic)
- `src/infra/projections/apply-event.ts` (event handlers — verify coverage!)
- `src/domain/events/types.ts` (event type definitions)
- `src/infra/db/sqlite-event-store.ts` (event append/read)

### External

- `bun:test`
- `bun:sqlite` (Database type)

<!-- MANUAL: -->
