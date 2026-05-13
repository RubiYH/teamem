<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-01 | Updated: 2026-05-01 -->

# db

## Purpose

SQLite-backed event store. Provides a thin client wrapper, a `runMigration` helper, and the `SqliteEventStore` repository implementing append + lookup + range-by-timestamp queries with idempotency-key deduplication.

## Key Files

| File                      | Description                                                                                          |
| ------------------------- | ---------------------------------------------------------------------------------------------------- |
| `sqlite-client.ts`        | `createSqliteClient(path)` (defaults to `:memory:`) + `runMigration(db, migrationPath)`              |
| `sqlite-event-store.ts`   | `SqliteEventStore` class — `append`, `getById`, `getUpdates(repoId, sinceTimestamp?, limit?)`        |
| `types.ts`                | `EventStore` interface (the abstraction `SqliteEventStore` implements)                               |

## Subdirectories

| Directory     | Purpose                                                                  |
| ------------- | ------------------------------------------------------------------------ |
| `migrations/` | Numbered SQL migration files — see `migrations/AGENTS.md`                |

## For AI Agents

### Working In This Directory

- `append` runs inside a single SQLite transaction (`db.transaction(() => {...})`) so the events row + idempotency_keys row are inserted atomically.
- Idempotency contract: same `idempotency_key` + same `event_id` → no-op success; same key + different `event_id` → throws `Error('Idempotency conflict ...')`.
- `getUpdates` uses **timestamp** (not row id) for ordering. Two events with identical timestamps are ordered non-deterministically — bear this in mind for large-batch tests.
- The `raw_json` column stores the canonical full event for replay; per-field columns exist for indexing only. `parseEvent` always reconstructs from `raw_json`.

### Testing Requirements

- `tests/unit/db/sqlite-event-store.test.ts` covers append + idempotency + lookup.
- Always start from `:memory:` and re-run the migration per test.

### Common Patterns

- Prepared statements with positional placeholders (`?1`, `?2`, ...).
- Type assertion `as { ... } | null` on `query().get()` results — Bun's `bun:sqlite` is untyped at the row level.

## Dependencies

### Internal

- `../../domain/events/types.ts` (`TeamemEvent`)

### External

- `bun:sqlite`
- `node:fs` (`readFileSync` for migration SQL)

<!-- MANUAL: -->
