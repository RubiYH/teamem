<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-01 | Updated: 2026-05-01 -->

# infra

## Purpose

Side-effecting infrastructure: SQLite client + event store (`db/`) and projection apply/rebuild (`projections/`). All I/O against the data store is funneled through this directory so the rest of the codebase stays testable with just an in-memory `Database`.

## Key Files

None at this level — see subdirectories.

## Subdirectories

| Directory      | Purpose                                                                       |
| -------------- | ----------------------------------------------------------------------------- |
| `db/`          | SQLite client, event store, schema migrations — see `db/AGENTS.md`            |
| `projections/` | Apply event → read-model updaters and full rebuild — see `projections/AGENTS.md` |

## For AI Agents

### Working In This Directory

- This layer **may** import from `../domain/` but **must not** import from `../server/` or `../hooks/`.
- All SQLite work uses the Bun runtime (`import { Database } from 'bun:sqlite'`). Do not switch to `better-sqlite3` without coordinating with the test setup helpers.
- New columns require a new migration file in `db/migrations/` and updates to `applyProjectionUpdate` and `rebuildProjections` to keep read models consistent.
- Both `apply-event.ts` and `sqlite-event-store.ts` use `?1`-style positional placeholders — keep that style.

### Testing Requirements

- Tests live under `tests/unit/db/`. Tool-level integration is exercised via `tests/integration/tools/`.
- Always run a fresh migration per test (`runMigration(db, ...)`) — schema state should not leak across cases.

### Common Patterns

- Repository pattern: classes (`SqliteEventStore`) accept a `Database` in the constructor.
- `JSON.parse`/`JSON.stringify` round-trip for `scope_json`, `payload_json`, etc. — the canonical event is reconstructed from `raw_json`.
- `INSERT OR REPLACE` for projection upserts (the event log is the source of truth, projections are derived).

## Dependencies

### Internal

- `../domain/events/types.ts` (`TeamemEvent`)

### External

- `bun:sqlite`
- `node:fs` (for `readFileSync` of migration files)

<!-- MANUAL: -->
