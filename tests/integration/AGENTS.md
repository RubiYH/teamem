<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-01 | Updated: 2026-05-13 -->

# integration

## Purpose

Tests that exercise multiple layers together: tool handlers → event store → projections. Still in-process and in-memory, but verifies the full publish → projection → read cycle.

## Key Files

| File              | Description                                                          |
| ----------------- | -------------------------------------------------------------------- |
| `smoke.test.ts`   | Trivial `bootstrap()` smoke check — proves the entrypoint loads      |

## Subdirectories

| Directory  | Purpose                                                                       |
| ---------- | ----------------------------------------------------------------------------- |
| `tools/`   | Per-tool integration tests for `teamem.*` — see `tools/AGENTS.md`             |

## For AI Agents

### Working In This Directory

- Integration tests still use `:memory:` SQLite and run synchronously — no async server boot.
- The `tools/` subtree should grow whenever a new MCP tool is added.
- Keep `smoke.test.ts` tiny — it's intentionally a 1-assert check that the module graph loads cleanly.

### Testing Requirements

- N/A — these are tests.

### Common Patterns

- `setup()` helper at the top of each file builds `{ db, tools }` (or `{ db, tools, registry }`).

## Dependencies

### Internal

- `src/index.ts`, plus everything `tools/` covers.

### External

- `bun:test`

<!-- MANUAL: -->
