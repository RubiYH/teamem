<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-01 | Updated: 2026-05-13 -->

# db (tests)

## Purpose

Unit tests for the SQLite event store and the projection rebuild path. Each test runs against a fresh `:memory:` SQLite with `001_init.sql` applied.

## Key Files

| File                              | Description                                                                                               |
| --------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `sqlite-event-store.test.ts`      | `append` + lookup, idempotency dedup, claim/release projection lifecycle                                  |
| `rebuild-projections.test.ts`     | After dropping `claims`, `rebuildProjections` reproduces the released-claim state from the event log     |

## For AI Agents

### Working In This Directory

- Migration paths are resolved from the repo root; run tests from the project root unless the test explicitly sets its own fixture path.
- Tests share a `sampleEvent(overrides)` / `event(overrides)` helper pattern but each file defines its own; that's fine — a shared fixture module isn't worth the indirection here.
- Use absolute timestamps (e.g. `'2026-04-30T00:00:00.000Z'`) — never `new Date().toISOString()` inside a test, since timestamp is what `getUpdates` orders by.

### Testing Requirements

- New event types that touch projections need a rebuild test that exercises clear → re-apply.
- New event store methods need both a happy-path test and an idempotency / edge case test.

### Common Patterns

- `:memory:` database per test — no shared state.
- `applyProjectionUpdate` is called explicitly in the test setup since `SqliteEventStore.append` does NOT call it (the production caller for that wiring is `createTeamemTools.publishEvent`).

## Dependencies

### Internal

- `src/infra/db/sqlite-client.ts`
- `src/infra/db/sqlite-event-store.ts`
- `src/infra/projections/{apply-event,rebuild}.ts`
- `src/domain/events/types.ts`

### External

- `bun:test`, `node:path`

<!-- MANUAL: -->
