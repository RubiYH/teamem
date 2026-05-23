<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-09 | Updated: 2026-05-09 -->

# monitors

## Purpose

Monitor process configuration and launch coordination. Defines how the background event monitor (`bin/teamem-monitor`) is started and what events it polls for.

## Key Files

| File | Description |
|------|-------------|
| `monitors.json` | Monitor definition: name, command, description, session-start trigger (`always`) |

## For AI Agents

### Working In This Directory

- **Single monitor entry**: The `monitors.json` file defines one monitor process: `teamem-events`. Claude Code launches it at session start / plugin reload.
- **Command expansion**: The `command` field uses `${CLAUDE_PLUGIN_ROOT}` template variable, which Claude Code expands at runtime to the plugin installation directory.
- **Activation trigger**: `when: "always"` means the monitor process starts with the session. The process only polls Teamem while the session `active` flag or project `auto-on` flag is present, unless the session has a `disabled` override from `/teamem-off`.

### Common Patterns

- **Monitor lifecycle**: The monitor process runs in the background for the session and idles while Teamem is inactive. When active, it polls the Teamem server for new events (`teamem.get_updates` in long-poll mode) and emits notifications to Claude Code's event system.
- **Event routing**: The monitor polls for all event types and emits them as notifications/log records. The current plugin build does not attach watcher/negotiator Notification agents.
- **Process management**: The monitor PID is stored in `${CLAUDE_PLUGIN_DATA}/sessions/${SID}/monitor.pid` by `bin/teamem-monitor`. The `/teamem-off` command writes a session `disabled` override so the monitor idles without losing project-wide persistence.

## Dependencies

### Internal

- `../bin/teamem-monitor` (executable that runs the monitor loop)
- `../hooks/hooks.json` (defines how notifications are routed to agents)
- `../agents/` (briefing agent; monitor notifications no longer fan out to watcher/negotiator agents)

### External

- Claude Code monitor process execution environment (manages process lifetime, restart logic)

<!-- MANUAL: -->
