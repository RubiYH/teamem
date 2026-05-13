<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-09 | Updated: 2026-05-09 -->

# agents

## Purpose

Subagent prompt definitions for Teamem. The active plugin surface keeps only the briefing helper; watcher and negotiator runtime is postponed, and Channels plus SessionStart own discussion/event delivery.

## Key Files

| File | Description |
|------|-------------|
| `teamem-briefer.md` | Fetches and presents the current briefing (plan, claims, decisions, risks, progress) |

## For AI Agents

### Working In This Directory

- **Prompt format**: Each `.md` file is a complete Claude prompt (not a skill).
- **Trigger model**: The briefer is invoked directly by user-facing flows. Notification-driven watcher/negotiator subagents are intentionally absent in this plugin build.

### Common Patterns

- **Briefer**: Calls `mcp__teamem__get_briefing` to fetch the five-dimension briefing, then formats and presents it. No state changes.

## Dependencies

### Internal

- `../commands/teamem-discuss.md` (direct-send slash command for new discussions)

### External

- MCP tools: `mcp__teamem__get_briefing`

<!-- MANUAL: -->
