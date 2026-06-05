<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-09 | Updated: 2026-05-09 -->

# channel

## Purpose

Tests for the Claude Code Channels POC: polling updates, event routing, cursor
priming, and channel-relevant tool payload contracts. Verifies that directed
discussion and direct gotcha events reach only recipients, broadcasts reach
non-senders, decision lifecycle events preserve full text for online teammates,
gotcha notices stay compact, and legacy permission alerts keep their incumbent
metadata. The experimental reply helper is postponed, so channel tests should
not expect a `teamem_reply` tool.

## Key Files

| File | Description |
|------|-------------|
| `channel-server.test.ts` | Polling schema, cursor priming, recipient filtering, discussion/permission/decision/gotcha channel emission |
| `decision-tool-bindings.test.ts` | Decision tool binding and session-sync replay payload contracts for channel-visible decision lifecycle events |

## For AI Agents

### Working In This Directory

- Import `pollChannelOnce()` from `src/channel/index.js`.
- Tests invoke `TOOL_BINDINGS['teamem.get_updates']` directly to verify payload shape.
- Channel events are typed as `TeamemChannelEvent` (raw from server) and filtered to `ClaudeChannelNotification` (recipient-only for local principal).

### Testing Requirements

- `discussion_posted` events addressed to the local principal MUST appear in polled updates.
- Broadcast discussion and gotcha events MUST emit to non-senders and MUST NOT emit to the sender.
- Decision lifecycle broadcasts MUST preserve full title/body text in channel-visible payloads.
- Gotcha notices MUST omit full body text and carry enough compact metadata for recipients to fetch details.
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
