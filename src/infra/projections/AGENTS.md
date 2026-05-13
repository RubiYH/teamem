<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-01 | Updated: 2026-05-05 -->

# projections

## Purpose

Materialized read-model maintenance. `applyProjectionUpdate` is the per-event hook that refreshes the `claims`, `contracts`, and `blockers` tables; `rebuildProjections` replays the entire event log for a `repo_id` to reconstruct read-model state from scratch.

This is the "view" half of CQRS — the `events` table is the write log; this directory derives queryable state from it.

## Key Files

| File              | Description                                                                                                |
| ----------------- | ---------------------------------------------------------------------------------------------------------- |
| `apply-event.ts`  | `applyProjectionUpdate(db, event)` — switches on `event_type` and upserts into the matching read-model table |
| `rebuild.ts`      | `rebuildProjections(db, repoId)` — clears claims for the repo, re-applies every event in timestamp order, returns `{ replayed: count }` |

## For AI Agents

### Working In This Directory

- `applyProjectionUpdate` currently handles `scope_claimed`, `scope_released`, `contract_changed`, `blocker_raised`, `blocker_resolved`. Other event types are append-only history with no derived state.
- When you add a new derived table, add the matching `event_type` branch here AND extend `rebuildProjections` to clear that table before replay (currently only `claims` is cleared, which is a known gap if you add more rebuilds).
- Use `INSERT OR REPLACE` for projection upserts so re-applying the same event is idempotent — required for `rebuildProjections` correctness.
- Payload field reads use `String(event.payload.foo as string | undefined ?? '')` to coerce safely — keep this defensive style; payloads are typed as `Record<string, unknown>`.

### Testing Requirements

- `tests/unit/db/rebuild-projections.test.ts` verifies the rebuild correctly reproduces the released-claim end state.
- `tests/unit/db/sqlite-event-store.test.ts` covers the per-event apply path.

### Common Patterns

- Pure SQL via prepared statements; no ORM.
- Order matters in `rebuildProjections`: clear → query in `timestamp ASC` order → re-apply each event.

## Dependencies

### Internal

- `../db/` (uses `Database` from `bun:sqlite`)
- `../../domain/events/types.ts` (`TeamemEvent`)

### External

- `bun:sqlite`

<!-- MANUAL: -->

## Update 2026-05-05 — claim-lifecycle v2 events

The "currently handles 5 event types" line is stale. `applyProjectionUpdate` now handles every lifecycle event needed for rebuild parity:

- `scope_claimed`, `scope_released` (original)
- `scope_released_via_git`, `claim_force_released`, `claim_expired` — all transition the claim to `status='released', released_at=event.timestamp`
- `claim_paused` — sets `paused_at = event.timestamp, paused_reason = event.payload.reason`
- `claim_resumed` — clears `paused_at = NULL, paused_reason = NULL`
- Plus `contract_changed`, `blocker_raised`, `blocker_resolved`, `decision_recorded`, `discussion_posted`, `artifact_shared`, `finding_shared`, `conflict_queued`, `conflict_resolved`, `permission_requested/granted/denied/expired`, `task_started/progressed/completed`, `agent_focus_changed`

### Rebuild parity is non-optional

PRD-mandated invariant: every event type with an inline UPDATE in `src/server/tools/index.ts` MUST have a matching handler here. `rebuildProjections` replays through this file in timestamp order; missing handler = silent state corruption (a release event lands but the rebuilt `claims` row stays `active`). The five-place update rule lives in `../../domain/AGENTS.md`.

### Atomicity invariant

Tools that mutate projections inline must do so inside the SAME `db.transaction(...).immediate()` as the event-append. The handler in this file mirrors the inline UPDATE for replay; both must produce the same final state. Whenever you add a new inline UPDATE to a tool, add the matching handler here in the same PR.

### Handlers are if-blocks, not a switch

The file uses a sequence of `if (event.event_type === '...') { ... }` blocks for readability and so projections can be added incrementally without forcing an exhaustiveness check. Order doesn't matter (each block is independent); just keep related events grouped (claim-lifecycle handlers near each other, etc.).
