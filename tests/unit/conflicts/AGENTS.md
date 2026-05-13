<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-01 | Updated: 2026-05-13 -->

# conflicts (tests)

## Purpose

Unit tests for the pure conflict scoring engine in `src/domain/conflicts/`.

## Key Files

| File               | Description                                                                            |
| ------------------ | -------------------------------------------------------------------------------------- |
| `engine.test.ts`   | Verifies `evaluateConflict` returns `advisory` / `soft_gate` / `hard_gate` correctly + the matching `required_actions` |

## For AI Agents

### Working In This Directory

- These tests are the safety net for threshold tuning. If you change the band edges in `engine.ts` (40, 70), update the assertions here in lockstep.
- Each test crafts a `ConflictSignal` literal — keep the explicit, fully-spelled signals (no `...defaults` spread) so tests document the input matrix.

### Testing Requirements

- Add a test case for any new `ConflictSignal` field — at minimum: signal-on-only and signal-off-only.

### Common Patterns

- Default weights are used (no env override) — tests stay independent of `process.env`.

## Dependencies

### Internal

- `src/domain/conflicts/engine.ts`

### External

- `bun:test`

<!-- MANUAL: -->
