<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-09 | Updated: 2026-05-09 -->

# migration

## Purpose

Schema migration tests that verify forward migration application and database consistency across schema versions. Tests here apply migrations sequentially and inspect the resulting schema to confirm tables, columns, and indexes exist as expected.

## Key Files

| File | Description |
|------|-------------|
| `round-trip.test.ts` | Applies migrations 001, 002, 003 in sequence; verifies column presence/absence (e.g., `repo_id` → `space_id` rename in 003) and new tables created |

## For AI Agents

### Working In This Directory

- Migration tests use on-disk SQLite (copy from memory or use real file) to verify that migrations work with persistent state.
- Use `PRAGMA table_info(table_name)` to inspect schema state (list of columns with their types and constraints).
- After applying a migration, verify both presence of expected columns and absence of old columns (e.g., after rename).
- Test the exact transition between versions — verify pre-state, apply migration, verify post-state.

### Testing Requirements

- Each migration must be idempotent (applying it twice should fail safely or be a no-op).
- Schema changes must be verified at the column level, not just by checking "the migration ran."
- Test data (if any) must survive migration without corruption.

### Common Patterns

- **Schema snapshot**: `db.query('PRAGMA table_info(events)').all()` returns array of column metadata.
- **Column presence**: `colNames.includes('space_id')` and `!colNames.includes('repo_id')` to verify rename.
- **Table creation**: `db.query('SELECT name FROM sqlite_master WHERE type="table"').all()` to list all tables.
- **Before/after pattern**: capture schema before migration, apply, capture after, assert changes.

## Dependencies

### Internal

- `src/infra/db/sqlite-client.js` — SQLite client and `runMigration` function
- `src/infra/db/migrations/001_init.sql`, `002_decisions_kind_and_indexes.sql`, `003_room_codes_and_members.sql` — the migrations being tested

### External

- `bun:test` — test runner
- `bun:sqlite` — database driver
- `node:fs` — file operations for on-disk DB files
- `node:path` — path utilities

<!-- MANUAL: -->
