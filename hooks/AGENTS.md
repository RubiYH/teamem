<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-09 | Updated: 2026-05-09 -->

# hooks

## Purpose

Top-level directory for Claude Code and Codex lifecycle hooks. These are standalone bash scripts that fire during agent session events (session start, pre-tool-use, post-tool-use, on-before-edit, on-after-edit, etc.). Each hook publishes a Teamem event to track agent progress and coordination.

**Note:** This directory contains raw hook scripts. The plugin's hooks manifest lives separately in `plugin/hooks/hooks.json` and references these scripts. For local development, hooks can also be registered in `.claude/settings.json`.

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `claude/` | Claude Code lifecycle hooks (session-start, pre-tool-use, post-tool-use) |
| `codex/` | Codex lifecycle hooks (on-before-edit, on-after-edit, on-task-start) |

## Key Files (at this level)

(None — subdirectories contain all hooks.)

## For AI Agents

### Working In This Directory

- Each hook script is self-contained and should `exit 0` (always succeeds, even on error) to avoid blocking the agent harness.
- Hooks use curl to POST events to the Teamem server at `TEAMEM_SERVER_URL` (default: http://localhost:3000).
- Authentication is via `TEAMEM_BEARER_TOKEN` (environment variable).
- Errors are logged to `${HOME}/.cache/teamem/hook-errors.log` (JSON format) rather than stderr.

### Testing Requirements

- Test hooks locally by setting `TEAMEM_SERVER_URL`, `TEAMEM_BEARER_TOKEN`, `TEAMEM_PRINCIPAL`, and running the script manually.
- Verify no network errors in `~/.cache/teamem/hook-errors.log`.
- The server must be running and accessible at the configured URL.

### Common Patterns

- All hooks follow the same error-handling pattern: log to `hook-errors.log` on network/auth failure, then `exit 0` (fail-open).
- Event bodies are JSON and include `repo_id`, `principal`, `actor`, `delegation`, `event_type`, and a type-specific `payload`.
- Hooks are optional — the coordination system works without them, but agents lose progress visibility.

## Dependencies

### Internal

- `src/server/routes.ts` — accepts POST to `/tools/*` with Bearer auth
- Environment variables: `TEAMEM_SERVER_URL`, `TEAMEM_BEARER_TOKEN`, `TEAMEM_PRINCIPAL`, `TEAMEM_ACTOR`, `TEAMEM_DELEGATION`, `TEAMEM_REPO_ID`, `TEAMEM_TASK_ID` (Codex only)

### External

- `curl` — HTTP client
- `date` — timestamp generation

<!-- MANUAL: hooks/ contains raw scripts; plugin/hooks/hooks.json registers them for the plugin. .claude/settings.json can also register these for local dev. -->
