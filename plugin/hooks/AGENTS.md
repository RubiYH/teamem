<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-09 | Updated: 2026-05-09 -->

# hooks

## Purpose

Claude Code lifecycle hook configuration and dispatch. Defines which hooks fire on which Claude events and routes them to bash scripts or subagents. The single source of truth for hook behavior in the plugin.

## Key Files

| File | Description |
|------|-------------|
| `hooks.json` | Lifecycle hook configuration: SessionStart, PreToolUse, Stop, and Notification matchers with command/agent routes |

## For AI Agents

### Working In This Directory

- **Manifest fail-closed behavior**: If `hooks.json` contains one malformed entry (unknown field, non-schema `userConfig`, etc.), Claude Code silently disables ALL hooks for the plugin with no error message. When a hook stops firing, first check this file for syntax errors or unknown fields. Bisect by stripping to minimal entries.
- **Hook type choices**: Hooks can be `"command"` (bash script with timeout) or `"agent"` (subagent prompt). Commands run inline; agents run in the background and do not block the main agent.
- **Matcher pattern**: Each hook block has a `"matcher"` field. `"*"` matches all. Notification routes are currently empty on purpose.

### Common Patterns

- **SessionStart**: Runs `session-start.sh` on every session. This script fetches the briefing if Teamem is active. Timeout 5s.
- **PreToolUse**: Runs `gate-claim.sh` before every tool use (Edit, Write, MultiEdit, NotebookEdit, apply_patch). This script calls `claim_scope` to reserve scope and refreshes existing claims. Timeout 30s because conflicts now queue immediately; stale `auto-discuss` prefs are degraded to the same queue path instead of opening disputes with no active negotiator runtime.
- **Stop**: Runs `release-claims.sh` for telemetry only. Claims survive session end and release through git evidence, explicit release, TTL expiry, or force-release.
- **Notification**: Intentionally empty. Discussion and alert delivery now come from Channels, SessionStart sync, stored threads, and unread notifications rather than watcher/negotiator subagents.

### Hook Execution Model

1. Claude Code fires the hook at the appropriate lifecycle point
2. For `"command"` hooks: bash script is executed with `$CLAUDE_PLUGIN_ROOT` env var set; script exits 0/1
3. For `"agent"` hooks: Claude creates a subagent session with the prompt and notification envelope in context. This plugin build does not currently use Notification agents.
4. Hook errors do not block the main agent (hooks are defensive)

## Dependencies

### Internal

- `../scripts/session-start.sh` (SessionStart hook: fetches briefing)
- `../scripts/gate-claim.sh` (PreToolUse hook: gate edits on claimed scope)
- `../scripts/release-claims.sh` (Stop hook: telemetry-only release lifecycle note)

### External

- Claude Code hook execution runtime (provides hook lifecycle, env vars, notification payloads)

<!-- MANUAL: -->
