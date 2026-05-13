<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-09 | Updated: 2026-05-09 -->

# channel

## Purpose

Unit tests for the Claude Code channels integration: payload serialization/deserialization, event routing (peer vs. dispute channels), filtering (self-authored, noise), and runtime filtering logic.

## Key Files

| File | Description |
|------|-------------|
| `payload.test.ts` | Event routing (`classifyTeamemChannelRoute`), Claude channel notification creation, noise filtering (session-start beacons, non-discussion events) |
| `runtime.test.ts` | Runtime filtering via `shouldEmitTeamemChannelEvent` — directs messages to recipients, broadcasts to non-senders, filters self-authored events |

## For AI Agents

### Working In This Directory

- Channel tests are pure-logic — no network, no SQLite, no I/O.
- Event shape is fixed: `event_id`, `event_type`, `principal`, optional `payload` and `scope`.
- Routing logic determines channel destination: 'peer' for directed messages, 'dispute' for dispute moves, 'noise' for ignored events.
- Filtering prevents channel spam by suppressing self-authored messages and routine beacons.

### Testing Requirements

- Every event type must be routed to the correct channel (peer, dispute, or filtered as noise).
- Verify that directed messages (`recipient_principal: 'alice'`) only route to the recipient, not to other members.
- Verify that broadcast messages (`recipient_principal: null`) route to all non-senders.
- Test noise filtering: session-start beacons, task events, scope events must NOT emit channel notifications.

### Common Patterns

- **Routing classification**: `classifyTeamemChannelRoute(event)` returns 'peer', 'dispute', or 'noise'.
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
