# Architecture

Teamem has three main parts:

```text
Claude Code plugin
  -> local Teamem bridge
  -> shared Teamem HTTP server
  -> SQLite event store and projections
```

## Claude Code plugin

The plugin provides slash commands, lifecycle hooks, optional channel delivery,
and the local bridge used by Claude Code.

## Local bridge

The bridge runs on each teammate's machine. It translates Teamem MCP tool calls
into authenticated HTTP requests to the shared server.

## Shared server

The server is a Bun + Hono application backed by SQLite. It stores events,
maintains projections for current team state, and serves tools such as
`teamem.get_briefing`, `teamem.claim_scope`, and `teamem.record_decision`.

## Briefing model

The primary read path is `teamem.get_briefing`, which returns current plan,
active claims, recent decisions, active risks, and recent progress.

## Trust model and known limitations

Teamem's threat model is "trusted teammates on a small shared server." Two
properties follow from that and should not be relied on as security
boundaries:

- **Member names are reusable identities.** A member's identity is the
  free-chosen name they joined with, and name uniqueness is only enforced
  among active members. After someone leaves or is kicked, anyone holding the
  room code can join under that name, and historical events attributed to
  that principal become indistinguishable from the new holder's activity.
  Treat the event log's `principal` as "whoever the team admitted under that
  name at the time," not as a verified person. Rotate the room code when
  someone departs, and avoid reusing departed names.
- **Claims are cooperative, not enforced.** Any member can force-release a
  teammate's claim (deliberate — recovering a stale claim must not require
  the creator), and the plugin's edit gate fails open when the bridge or
  server is unavailable. Claims prevent accidental collisions between
  cooperating agents; they are not an access-control mechanism.
