<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-09 | Updated: 2026-05-13 -->

# channel

## Purpose

Claude Code Channels POC integration. Routes selected Teamem events to Claude
Code's channel API (`notifications/claude/channel`). Polls
`/tools/teamem.get_updates` for new events, classifies peer vs. dispute routes,
renders human-readable summaries, and emits notifications with routing metadata.
Current peer coverage includes discussion messages, decision lifecycle
broadcasts, compact gotcha notices, and legacy/internal `permission_requested`
alerts. Normal queue-first file-claim conflicts are not ordinary Channel
alerts. Respects sender gating (`TEAMEM_CHANNEL_ALLOWED_SENDERS`) and
fresh-cursor priming on startup.

## Key Files

| File | Description |
|------|-------------|
| `index.ts` | Main channel server; stdio MCP entry point; polls on a loop, emits Claude channel notifications, manages session state (cursor, active flag, space pin) |
| `payload.ts` | Teamem event envelope types, route classification, summaries, Claude notification metadata, decision full-text payloads, gotcha compact-notice payloads, and urgent permission alert metadata |
| `runtime.ts` | Emission decision logic; filters events by sender, route type, recipient, decision broadcast, gotcha direct/broadcast routing, and permission incumbent; `shouldEmitTeamemChannelEvent()` determines whether to send a notification |

## Subdirectories

None.

## For AI Agents

### Working In This Directory

- **Session management**: respects `CLAUDE_SESSION_ID` and `CLAUDE_PLUGIN_DATA` env vars to locate session state directory (`sessions/<sid>/`); creates it if missing.
- **Channel startup evidence**: `channel.log` with `start session=...` only proves Claude spawned the MCP subprocess. A live path needs `require_active=0` (unless intentionally gated), a `primed cursor=...` line for fresh sessions or `loaded cursor=...` for reused sessions, and recipient `sessions/<sid>/notifications.log` entries for expected event envelopes.
- **Cursor priming**: on first startup, advance the channel cursor to the latest event id before emitting. On reused sessions, log and continue from the persisted cursor instead of re-priming. `teamem.get_updates` returns oldest-first when called without `since`; priming prevents old history from being replayed into the channel or delaying live messages.
- **Sender gating**: respect `TEAMEM_CHANNEL_ALLOWED_SENDERS` env (comma-separated list, e.g. `bob,alice`) for stricter local dev testing; space membership is the default trust boundary.
- **Active flag vs polling**: `TEAMEM_CHANNEL_REQUIRE_ACTIVE=1` makes polling conditional on `sessions/<sid>/active` file. Default (empty) is to poll on channel startup alone (explicit opt-in). Local `--plugin-dir` runs can use a different data slug/session id than slash commands, so active-file gating is fragile unless deliberately enabled.
- **Route classification**: `dispute_opened` and `discussion_posted` events carrying `payload.dispute_move` are "dispute" for log separation and future roadmap work. Other emitted events are peer events. The current plugin build has no watcher/negotiator Notification agent consuming these routes. `permission_requested` is a legacy/internal peer-channel event targeted only to `payload.incumbent_principal`.
- **Decision vs gotcha payload shape**: Decisions intentionally broadcast with full text so online teammates can update direction immediately. Gotchas intentionally emit lightweight `finding_shared` notices only (summary, severity, paths/tags, id/version) and must not include the full body; recipients fetch detail with `teamem.get_finding` and acknowledge with `teamem.acknowledge_finding`.
- **Notification metadata**: discussion notifications include `thread_id`, `message_id`, and `recipient_principal` in `meta` for deterministic thread handling. `permission_requested` notifications instead use the exact meta fields `req_id`, `blocking_claim_id`, `incumbent_principal`, `event_id`, `event_type`, and `principal`.
- **Discuss reply helper**: The experimental `teamem_reply` channel tool and inbound Discuss reply-helper subagent are postponed. Directed replies should use the normal `teamem.post_message` MCP path or a human-facing flow.
- **Boundary of proof**: `notifications.log` proves Teamem polled and called `notifications/claude/channel`; it is not proof that Claude Code accepted, rendered, or woke on the channel event. Check `/mcp`, the channel startup flag, org `channelsEnabled`, and Claude debug logs for UI/rendering failures.

### Testing Requirements

- Integration tests live in `tests/integration/channel/channel-server.test.ts`.
- Unit tests in `tests/unit/channel/` cover payload classification, runtime filters, and cursor management.
- Test both peer and dispute event routing separately. Dispute routes are classified separately; normal peer delivery must not depend on watcher/negotiator Notification agents.
- Test sender gating by setting `TEAMEM_CHANNEL_ALLOWED_SENDERS` and verifying events from unlisted senders are dropped.
- Test directed and broadcast discussion delivery through Channels, but do not add `teamem_reply` policy tests until the reply-helper roadmap item is reactivated.
- Test decision lifecycle routing as non-sender broadcast delivery with full decision text preserved.
- Test `finding_shared` routing as its own case: direct gotchas reach only recipients, broadcast gotchas reach non-senders, and both payload/log shapes omit body text.

### Common Patterns

- **Polling loop**: prime to the latest event id on empty cursor, then fetch events since last cursor, advance cursor to the latest event id, filter and emit notifications, sleep before next poll.
- **Event summarization**: `summarizeTeamemChannelEvent()` renders concise human-readable strings (e.g., "alice claimed scope [src/auth.ts, src/session.ts]"). `permission_requested` summaries must name requester, incumbent, requested paths, and `req_id`, and must urgently surface `/teamem:grant <req_id>` and `/teamem:deny <req_id>`.
- **Notification structure**: Claude channel expects `{ method: "notifications/claude/channel", params: { content: string, meta: Record<string, string> } }`.

## Dependencies

### Internal

- `src/bridge/http-client.js` (authenticated HTTPS POST for `/tools/teamem.get_updates`)
- `src/bridge/credentials.js` (space resolution and JWT management)
- `src/bridge/tool-bindings.js` (tool binding definitions)

### External

- `@modelcontextprotocol/sdk` — MCP stdio server
- `node:fs`, `node:path`, `node:os` — file and session state management

<!-- MANUAL: -->
