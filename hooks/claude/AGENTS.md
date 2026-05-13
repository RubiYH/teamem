<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-09 | Updated: 2026-05-09 -->

# claude

## Purpose

Claude Code lifecycle hooks that fire during agent session events. These hooks publish Teamem events to track tool usage, session progress, and coordination.

## Key Files

| File | Description |
|------|-------------|
| `session-start.sh` | Fires at session start; publishes a session_started event |
| `pre-tool-use.sh` | Fires before a Claude tool executes; publishes a task_started event |
| `post-tool-use.sh` | Fires after a Claude tool executes; publishes a task_progressed event |

## For AI Agents

### Working In This Directory

- All three hooks are optional — the server works without them, but agents lose visibility into session and tool-use progress.
- Each hook reads environment variables set by Claude Code (session ID, project directory, etc.) and optional Teamem overrides (`TEAMEM_*`).
- Hooks log errors to `${HOME}/.cache/teamem/hook-errors.log` and always exit 0 (fail-open).
- Network timeout is 5 seconds per curl call; failures are silent and logged.

### Common Patterns

- **Session-start** records when an agent begins work, enabling the briefing to track concurrent sessions.
- **Pre-tool-use** marks the start of a task (tool name, intent from the agent); paired with post-tool-use.
- **Post-tool-use** records task completion and tool outcome; included in the "recent_progress" dimension of the briefing.
- All events use `task_id` derived from session ID or explicit `TEAMEM_TASK_ID` to link progress events together.

## Dependencies

### Internal

- `TEAMEM_SERVER_URL` — server endpoint (default: http://localhost:3000)
- `TEAMEM_BEARER_TOKEN` — authentication
- `TEAMEM_PRINCIPAL` — agent principal name
- `TEAMEM_TOOL_NAME` (post-tool-use only) — name of the Claude tool that just ran
- `CLAUDE_SESSION_ID`, `CLAUDE_PROJECT_DIR` — set by Claude Code harness

### External

- `curl` — HTTP POST
- `date` — UTC timestamp

<!-- MANUAL: -->
