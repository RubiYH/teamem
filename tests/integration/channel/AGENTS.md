<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-09 | Updated: 2026-05-09 -->

# channel

## Purpose

Tests for the Claude Code Channels POC: polling updates, discussion message routing, and cursor priming. Verifies that `discussion_posted` events are delivered to directed recipients and that broadcasts are delivered only to non-senders. The experimental reply helper is postponed, so channel tests should not expect a `teamem_reply` tool.

## Key Files

| File | Description |
|------|-------------|
| `channel-server.test.ts` | Polling schema + recipient filtering, update filtering |

## For AI Agents

### Working In This Directory

- Import `pollChannelOnce()` from `src/channel/index.js`.
- Tests invoke `TOOL_BINDINGS['teamem.get_updates']` directly to verify payload shape.
- Channel events are typed as `TeamemChannelEvent` (raw from server) and filtered to `ClaudeChannelNotification` (recipient-only for local principal).

### Testing Requirements

- discussion_posted events addressed to the local principal MUST appear in polled updates.
- Broadcast events (`recipient_principal: null`) MUST emit to non-senders and MUST NOT emit to the sender.
- Empty channel cursors MUST prime to the latest event without replaying old notifications.

### Common Patterns

- Build mock event list with `TeamemChannelEvent[]` typed payloads.
- Use `pollChannelOnce()` to test update filtering and cursor advancement.

## Dependencies

### Internal

- `src/channel/index.ts` (poll logic)
- `src/channel/payload.ts` (type definitions for Teamem channel events)
- `src/bridge/tool-bindings.ts` (tool registry for get_updates)

### External

- `bun:test`

<!-- MANUAL: -->
