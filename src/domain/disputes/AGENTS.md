<!-- Parent: ../../AGENTS.md -->
<!-- Generated: 2026-05-09 | Updated: 2026-05-09 -->

# disputes

## Purpose

Mode 6.C dispute negotiation domain logic (slice #12). Pure state machine for
bounded structured negotiation between two `auto-discuss`-opted-in teammates.
The server/tool surface still exposes this compatibility domain, but the plugin
runtime currently degrades stale `auto-discuss` file-claim conflicts to the
queue-first path because watcher/negotiator Notification agents are postponed.
This directory keeps the deterministic dispute state machine and side-derivation
helpers ready for explicit dispute-tool flows and future runtime reactivation.

## Key Files

| File | Description |
|------|-------------|
| `state-machine.ts` | Core dispute state machine; validates move legality (turn alternation, proposal targeting, move-type constraints); checks termination conditions (user_override, explicit, turns, wallclock, pref_changed); determines outcome (resolved vs. terminated) |
| `derive-side.ts` | Helper to derive a dispute side (opener or target) from an event payload for deferred/future auto-negotiator routing; given `whoami_principal` and a payload carrying `opened_by` and `target_principal`, returns 'opener', 'target', or null (misrouted event) |

## Subdirectories

None.

## For AI Agents

### Working In This Directory

- **Dispute state**: immutable type `DisputeState` carries `open_proposals` (keyed by move_id), `turn_count`, `last_side`, `opened_at`, and `status` (open|resolved|terminated).
- **Dispute config**: `terminations_enabled` is a ReadonlySet of enabled termination conditions; `max_turns` (default 4) and `max_seconds` (default 300) are hard limits.
- **Move types** (7 vocabulary): `propose_release_full`, `propose_release_subset`, `propose_release_after_task`, `propose_swap`, `accept`, `reject`, `concede_skip`. Constraints:
  - `propose_release_full` is opener-only on first move
  - `propose_release_after_task` is target-only (incumbent)
  - `concede_skip` is opener-only (unilateral fallthrough to auto-skip)
  - `accept`/`reject` must target an existing open proposal from the counterparty
  - Alternating turns enforced: cannot post twice from same side in a row
- **Termination conditions** (5 total): `user_override` (manual end_dispute), `explicit` (both parties agreed), `turns` (round-trip cap reached), `wallclock` (time limit exceeded), `pref_changed` (a party switched away from auto-discuss). Server allows creator to enable/disable any subset, but at least one must remain.
- **Outcome semantics**: on `accept`, the outcome is applied atomically (release + re-claim if subset); on termination, either "resolved" (agreement) or "terminated" (time/turn limit or unilateral concede).

### Testing Requirements

- Unit tests in `tests/unit/disputes/` cover:
  - `validateMove()` legality checks (turn alternation, proposal targeting, move-type constraints)
  - `applyMove()` state transitions
  - `checkTermination()` conditions (time, turn count, pref change)
- Integration tests in `tests/integration/disputes/` cover:
  - `deriveDisputeSide()` payload classification from real emitted dispute payloads
- Pure unit tests only — no DB, no I/O. Test with hardcoded state objects and verify return types.
- Test all 7 move types and all 5 termination conditions independently.
- Test edge cases: empty proposals, first move constraints, counterparty acceptance/rejection.

### Common Patterns

- **Pure state machine**: every function is deterministic and side-effect-free. Callers assemble the full state from the database, call pure functions here, and handle the result in the route layer.
- **Result types**: `LegalityCheck = { ok: true } | { ok: false; code: string; reason: string }`.
- **Turn alternation**: compare `move.side` against `state.last_side`; reject if same.
- **Proposal targeting**: `accept` / `reject` must cite an existing move_id in `open_proposals`; check that the counterparty is the one posting the response.

## Dependencies

### Internal

None — this directory has zero internal dependencies (pure domain logic).

### External

None — standard library only (or built-in Date for wallclock checks).

<!-- MANUAL: -->
