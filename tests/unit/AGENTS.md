<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-01 | Updated: 2026-05-13 -->

# unit

## Purpose

Fast, deterministic unit tests for individual modules. Mirrors the `src/` tree — every subdirectory here corresponds to a `src/` directory of the same name.

## Key Files

| File              | Description                                                  |
| ----------------- | ------------------------------------------------------------ |
| `config.test.ts`  | `loadConfig()` defaults vs. explicit env overrides           |

## Subdirectories

| Directory    | Purpose                                                                        |
| ------------ | ------------------------------------------------------------------------------ |
| `conflicts/` | Conflict engine policy-band tests — see `conflicts/AGENTS.md`                  |
| `db/`        | SQLite event store + projection rebuild tests — see `db/AGENTS.md`             |
| `events/`    | Event envelope validator tests — see `events/AGENTS.md`                        |
| `hooks/`     | Claude Code hook adapter tests — see `hooks/AGENTS.md`                         |

## For AI Agents

### Working In This Directory

- Unit tests SHOULD avoid touching the database where possible. Db-touching tests technically live here (e.g. `db/`) but use `:memory:` and complete in milliseconds.
- New test files: import from the source via the `.js` ESM extension (`'../../src/config.js'`).
- Keep tests deterministic — no `Date.now()`, no real network, no real filesystem outside fixtures.

### Testing Requirements

- N/A — these ARE the tests.

### Common Patterns

- One `describe` per module under test; `it` names describe behavior in plain English.
- Helpers like `sampleEvent(overrides)` are defined per-file rather than shared.

## Dependencies

### Internal

- All of `src/`.

### External

- `bun:test`, `node:fs`, `node:path`.

<!-- MANUAL: -->
