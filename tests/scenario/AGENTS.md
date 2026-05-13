<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-01 | Updated: 2026-05-13 -->

# scenario

## Purpose

Multi-event simulations that emulate realistic multi-agent coordination workflows: duplicate scope claims, contract-drift escalation, deferred publish replay, and a perf smoke check (`< 100 ms` budget at 200 events).

These tests are coarser than integration tests — they validate the **system behaves correctly under sequenced agent activity**, not just per-tool correctness.

## Key Files

| File                       | Description                                                                                                |
| -------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `team-workflow.test.ts`    | 3 scenarios: duplicate active claims reject with `scope_conflict`; idempotent publish replay; perf smoke for `getUpdates` at 200 events |
| `placeholder.test.ts`      | One trivial `expect(true).toBe(true)` — keeps the suite non-empty even if the scenarios above are skipped |

## For AI Agents

### Working In This Directory

- The perf assertions (`expect(updatesMs).toBeLessThan(100)`) are smoke checks, not SLAs. Treat CI overload carefully before tightening thresholds.
- Use `publishTaskStarted(ctx, id, principal, path)` style helpers for repeated event boilerplate in scenarios.
- New scenarios should be self-contained: build a fresh `setup()` triple, drive it through a sequence of tool calls, and assert on the final policy/projection state.
- The `placeholder.test.ts` file exists so the `tests/scenario/` glob always matches at least one passing test — leave it in place when adding new scenarios.

### Testing Requirements

- N/A — this directory is the test layer.

### Common Patterns

- Timestamps are constructed with embedded ids (`2026-04-30T03:00:${id}.000Z`) so events have deterministic ordering.
- Performance measurement uses `performance.now()` deltas around a single tool call.

## Dependencies

### Internal

- `src/server/tools/index.ts`
- `src/infra/db/`

### External

- `bun:test`, `node:path`

<!-- MANUAL: -->
