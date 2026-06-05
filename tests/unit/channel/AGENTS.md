<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-09 | Updated: 2026-05-09 -->

# channel

## Purpose

Unit tests for the Claude Code Channels integration: payload serialization,
event route classification, notification metadata, public payload shaping, and
runtime emission filtering for discussions, decisions, gotchas, legacy
permission alerts, sender gating, and noise suppression.

## Key Files

| File | Description |
|------|-------------|
| `payload.test.ts` | Event routing (`classifyTeamemChannelRoute`), Claude channel notification creation, metadata, decision full-text payloads, gotcha compact notices, and urgent permission alert instructions |
| `runtime.test.ts` | Runtime filtering via `shouldEmitTeamemChannelEvent` — directs messages/gotchas to recipients, broadcasts discussions/decisions/gotchas to non-senders, targets permission alerts to incumbents, filters self-authored and noise events |

## For AI Agents

### Working In This Directory

- Channel tests are pure-logic — no network, no SQLite, no I/O.
- Event shape is fixed: `event_id`, `event_type`, `principal`, optional `payload` and `scope`.
- Route classification returns `peer` or `dispute`; noise suppression is a separate payload/runtime predicate.
- Filtering prevents channel spam by suppressing self-authored broadcasts, unlisted senders, and routine beacons while preserving supported event classes.

### Testing Requirements

- Every supported event type must be routed to the correct channel route or filtered as noise.
- Verify that directed messages (`recipient_principal: 'alice'`) only route to the recipient, not to other members.
- Verify that broadcast messages (`recipient_principal: null`) route to all non-senders.
- Verify that decision lifecycle events broadcast to non-senders with full text.
- Verify that gotcha `finding_shared` events route to direct recipients or non-senders for broadcasts while omitting full body text.
- Test noise filtering for session-start beacons and unsupported/routine events without treating all scope events as globally forbidden.

### Common Patterns

- **Routing classification**: `classifyTeamemChannelRoute(event)` returns 'peer' or 'dispute'.
- **Envelope creation**: `createTeamemChannelEnvelope(event)` wraps event in Claude channel format with `name` and `summary`.
- **Runtime filter**: `shouldEmitTeamemChannelEvent(event, { myPrincipal, allowedSenders? })` returns boolean.
- **Event shape**: every test event includes `event_id`, `event_type`, `principal`; optional `payload`, `scope`.

## Dependencies

### Internal

- `src/channel/payload.js` — payload classification and envelope creation
- `src/channel/runtime.js` — runtime filtering logic

### External

- `bun:test` — test runner

<!-- MANUAL: Keep payload and routing logic in sync with actual event types emitted by tools. When a new event type is introduced, add classification + filter test. -->
