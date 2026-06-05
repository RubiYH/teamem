<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-09 | Updated: 2026-05-09 -->

# disputes

## Purpose

Tests for Mode 6.C dispute negotiation compatibility: payload derivation,
event side-tagging, and deferred/future agent-facing helper functions. Verifies
that `dispute_opened` and `discussion_posted` move events carry the fields
needed for auto-negotiator routing to determine opener vs. target without
re-querying the server. The current plugin runtime does not attach
watcher/negotiator Notification agents; normal file-claim conflicts stay on the
queue-first path.

## Key Files

| File | Description |
|------|-------------|
| `payload-side-derivation.test.ts` | F22 regression — dispute_opened and move events include opened_by + target_principal for deferred/future agent routing |

## For AI Agents

### Working In This Directory

- Tests drive real server tools (`openDispute`, `disputePostMove`) against in-memory SQLite.
- Reads emitted events from the event store and asserts payload structure.
- Uses `deriveDisputeSide(whoami, payload)` helper to verify a future/deferred agent can compute its role.
- Tests both opener (bob) and target (alice) perspectives.

### Testing Requirements

- Every dispute_opened event MUST carry `opened_by` and `target_principal` in payload.
- Every discussion_posted event with a dispute_move MUST carry both fields (not just dispute_opened).
- `deriveDisputeSide()` must return non-null side for both opener and target when called with real server payloads.
- Schema must match the deferred agent-routing expectation; missing fields would break future auto-negotiator routing.

### Common Patterns

- Helper `setup()` seeds in-memory SQLite, creates spaces, and inserts test members.
- Call tools directly (tools.openDispute, tools.disputePostMove) and examine `store.events`.
- Use JSON paths to navigate event payload and assert presence of routing fields.

## Dependencies

### Internal

- `src/server/tools/index.ts` (openDispute, disputePostMove)
- `src/domain/disputes/derive-side.ts` (side-derivation helper)
- `src/infra/db/sqlite-event-store.ts` (event log read)

### External

- `bun:test`

<!-- MANUAL: -->
