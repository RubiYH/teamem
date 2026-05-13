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
