<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-09 | Updated: 2026-05-09 -->

# monitors

## Purpose

Monitor process configuration and launch coordination. Defines how the background event monitor (`bin/teamem-monitor`) is started and what events it polls for.

## Key Files

| File | Description |
|------|-------------|
| `monitors.json` | Monitor definition: name, command, description, activation trigger (`on-skill-invoke:teamem-on`) |

## For AI Agents

### Working In This Directory

- **Single monitor entry**: The `monitors.json` file defines one monitor process: `teamem-events`. It is launched when the `/teamem-on` slash command is invoked.
- **Command expansion**: The `command` field uses `${CLAUDE_PLUGIN_ROOT}` template variable, which Claude Code expands at runtime to the plugin installation directory.
- **Activation trigger**: `when: "on-skill-invoke:teamem-on"` means the monitor starts when the user runs `/teamem-on`. The monitor runs for the lifetime of the session, polling for peer events and feeding plugin-owned delivery surfaces.

### Common Patterns

- **Monitor lifecycle**: The monitor process runs in the background for the entire session once activated. It polls the Teamem server for new events (`teamem.get_updates` in long-poll mode) and emits notifications to Claude Code's event system.
- **Event routing**: The monitor polls for all event types and emits them as notifications/log records. The current plugin build does not attach watcher/negotiator Notification agents.
- **Process management**: The monitor PID is stored in `${CLAUDE_PLUGIN_DATA}/sessions/${SID}/monitor.pid` by `bin/teamem-flag`. The `/teamem-off` command kills the monitor process by reading this file.

## Dependencies

### Internal

- `../bin/teamem-monitor` (executable that runs the monitor loop)
- `../hooks/hooks.json` (defines how notifications are routed to agents)
- `../agents/` (briefing agent; monitor notifications no longer fan out to watcher/negotiator agents)

### External

- Claude Code monitor process execution environment (manages process lifetime, restart logic)

<!-- MANUAL: -->
