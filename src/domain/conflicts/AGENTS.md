<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-01 | Updated: 2026-05-13 -->

# conflicts

## Purpose

Deterministic, explainable conflict-scoring engine. Maps a `ConflictSignal` (overlap count, contract drift, stale base, blockers, ownership mismatch) into a weighted `risk_score` [0–100] and a `PolicyMode` band: `advisory` (0–39), `soft_gate` (40–69), `hard_gate` (70–100).

## Key Files

| File         | Description                                                                                    |
| ------------ | ---------------------------------------------------------------------------------------------- |
| `types.ts`   | `PolicyMode`, `ConflictSignal`, `ConflictWeights`, `ConflictResult`                            |
| `config.ts`  | `DEFAULT_CONFLICT_WEIGHTS` + `loadConflictWeights(env)` reading `TEAMEM_WEIGHT_*` env vars     |
| `engine.ts`  | `evaluateConflict(signal, weights)` — pure function returning `ConflictResult`                 |

## For AI Agents

### Working In This Directory

- The engine is pure: same input → same output, no I/O. Keep it that way; callers assemble `ConflictSignal` values outside this package before invoking `evaluateConflict`.
- Weight env vars follow `TEAMEM_WEIGHT_<NAME>` (uppercase snake) — see `docs/troubleshooting.md` for the full list.
- Threshold band edges (40, 70) are hard-coded in `engine.ts`. If you change them, also update the internal implementation plan under `.docs/` and the engine tests.
- `reasons` is always non-empty — `['no_conflict_signals']` is returned when no rules fired (callers can rely on `reasons[0]` existing).

### Testing Requirements

- `tests/unit/conflicts/engine.test.ts` covers the three policy bands.
- When adding a new signal: add a unit test that flips that signal in isolation and verifies its `reason` string lands in `reasons`.

### Common Patterns

- Score accumulates via `+=`; overlap is multiplied by `overlapCount` and capped at 100 before adding.
- Final `riskScore` is double-clamped to `[0, 100]`.
- `required_actions` is derived from `policyMode`, not stored separately.

## Dependencies

### Internal

None.

### External

None.

<!-- MANUAL: -->
