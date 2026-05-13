<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-09 | Updated: 2026-05-09 -->

# chaos

## Purpose

Chaos-engineering style fault-injection tests that verify system resilience under failure conditions. Tests here use signals (SIGKILL), state corruption, and race conditions to ensure the database and event store remain consistent even when interrupted mid-operation.

## Key Files

| File | Description |
|------|-------------|
| `migration-sigkill.test.ts` | SIGKILL during migration 003 — verifies DB atomicity (clean pre- or post-state, never half-migrated) |

## For AI Agents

### Working In This Directory

- Chaos tests interact with real on-disk SQLite databases (not `:memory:`), then intentionally terminate processes mid-operation.
- Use `Bun.spawn()` to launch child processes, then call `.kill(9)` for SIGKILL.
- Verify that the database state after an interruption is either fully committed or fully rolled back — never partial.
- Cleanup temporary directories with `rmSync()` in a try/finally block; temp files may survive process kill.

### Testing Requirements

- Each test creates a temporary directory (`mkdtempSync`) for the on-disk database file.
- Use `PRAGMA table_info(table_name)` to inspect schema state (column presence/absence).
- Confirm the DB can be reopened and queried after the kill — no corruption in the file itself.
- Document the invariant being asserted (e.g., "no half-renamed columns").

### Common Patterns

- **Signal-based teardown**: `proc.kill(9)` for SIGKILL (uncatchable, most severe).
- **Schema inspection**: `PRAGMA table_info(...)` returns column metadata — check for renamed columns, new tables, index creation.
- **Boolean invariants**: use `expect(condition || other).toBe(true)` and `expect(condition && other).toBe(false)` to enforce "exactly one of two states" logic.

## Dependencies

### Internal

- `src/infra/db/sqlite-client.js` — low-level SQLite client and migration runner
- `src/infra/db/migrations/` — all schema definitions

### External

- `bun:test` — test runner
- `node:fs` — filesystem operations
- `node:os` — `tmpdir()` for temp directory creation

<!-- MANUAL: -->
