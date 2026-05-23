<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-09 | Updated: 2026-05-09 -->

# bin

## Purpose

Executable entry points for Teamem runtime operations. Thin wrappers that invoke the bundled MCP bridge (`lib/bridge.js`) in different modes: synchronous CLI mode (teamem-call), session state management (teamem-flag), and background event polling (teamem-monitor).

## Key Files

| File | Description |
|------|-------------|
| `teamem-call` | Invokes the bridge in `call <tool>` mode; used by slash commands that need synchronous MCP tool responses |
| `teamem-flag` | Manages per-session activation state (enable/disable/status); controls active, disabled, and persisted flags |
| `teamem-monitor` | Spawns background long-poll process that fetches Teamem events for session logs and future delivery surfaces |

## For AI Agents

### Working In This Directory

- **Self-contained resolution**: All three scripts resolve `${CLAUDE_PLUGIN_ROOT}` (set by Claude Code) and fallback to relative path (for local dev). No dependency on source-tree symlinks or global `$PATH` config.
- **Bridge invocation model**: Each script routes to `bun run ${PLUGIN_ROOT}/lib/bridge.js` with different argument modes:
  - `teamem-call`: `bridge.js call <tool> [args...]` (blocking, returns JSON)
  - `teamem-flag`: reads/writes session state files (`active`, `disabled`, `space`, project `auto-on`)
  - `teamem-monitor`: `bridge.js poll [--cursor ...]` (blocking long-poll, emits notifications/log entries for plugin-owned delivery surfaces)
- **Error handling**: All scripts exit gracefully (exit 0) when Bun is missing, plugin root is unavailable, or bridge bundle is not found. Errors are logged to `${HOME}/.cache/teamem/hook-errors.log` but do not block the main agent.

### Common Patterns

- **teamem-call usage**: Slash commands invoke via `teamem-call <tool> --space <space> --actor <principal> --token-budget <N> --json '<payload>'`. Returns JSON with `ok` (true/false), `result` (on success), or `error` (on failure).
- **teamem-flag state**: Session state lives in `${CLAUDE_PLUGIN_DATA}/sessions/${SID}/` with files: `active` (timestamp of activation), `disabled` (session opt-out over project auto-on), `space` (pinned space name), and `monitor.pid` (background process). Project-wide persistence writes to `${CLAUDE_PLUGIN_DATA}/projects/<project-key>/auto-on`.
- **teamem-monitor polling**: Reads cursor from `${SESSION_DIR}/channel-cursor` and polls for new events. On startup, advances cursor to latest event before live delivery (prevents replaying old history). Emits `discussion_posted` and other event envelopes to Claude's notification system.

## Dependencies

### Internal

- `lib/bridge.js` (MCP stdio server; bundled artifact built from `src/bridge/index.ts`)
- `scripts/_common.sh` (shared bash utilities: `teamem_resolve_session_dir`, `teamem_is_active`, `teamem_log`, `teamem_bridge_js`)
- `scripts/session-start.sh` (invoked by SessionStart hook; injects a startup/resume briefing prompt and runs session sync if active)

### External

- `bun` (CLI runtime; must be available on user's machine)
- `.claude/plugin-data/` or `CLAUDE_PLUGIN_DATA` env var (session and project state directory)

<!-- MANUAL: -->
