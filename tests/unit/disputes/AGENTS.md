<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-09 | Updated: 2026-05-09 -->

# disputes

## Purpose

Unit tests for the dispute domain — state machine logic, move validation, termination conditions, and state transitions. Tests exercise the pure in-memory state machine with no database, clock, or I/O.

## Key Files

| File | Description |
|------|-------------|
| `state-machine.test.ts` | `validateMove()`, `applyMove()`, `checkTermination()` — all legal/illegal moves, state transitions, opener/target constraints, termination condition checks |

## For AI Agents

### Working In This Directory

- Dispute state-machine tests are pure logic with explicit time (`T0 = '2026-05-03T15:00:00.000Z'`).
- Each test focuses on one move type or termination condition; use `freshState()` helper to create isolated test state.
- Verify both success (move applied, state updated) and failure (move rejected, state unchanged).

### Testing Requirements

- Every legal move must be tested in at least one scenario (e.g., opener `propose_release_subset`, target `accept`, `reject`).
- Every illegal move must be tested (e.g., target proposing instead of responding, consecutive proposals without response).
- Termination conditions (`user_override`, `explicit`, `turns`, `wallclock`, `pref_changed`) must all be tested.

### Common Patterns

- **Fresh state**: `freshState(overrides)` returns initial state + optional overrides for testing specific branches.
- **Move validation**: `validateMove(state, move)` returns `{ ok: true }` or `{ ok: false, reason: '...' }`.
- **Move application**: `applyMove(state, move)` mutates state (or throws); verify new state reflects the move.
- **Termination check**: `checkTermination(state)` returns termination reason or null; verify conditions and timing.

## Dependencies

### Internal

- `src/domain/disputes/state-machine.js` — state machine implementation

### External

- `bun:test` — test runner

<!-- MANUAL: The state machine is pure logic; changes to it require corresponding test updates. When adding a new move type or termination condition, add tests immediately. -->
