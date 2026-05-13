---
description: Show Teamem activation state, pinned space, monitor health, and the last few peer notifications.
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/bin/teamem-flag:*), Bash(cat:*), Bash(tail:*), Bash(ls:*)
---

Steps:

1. Run `${CLAUDE_PLUGIN_ROOT}/bin/teamem-flag status` and show its full stdout.
2. If a notifications log exists at `${CLAUDE_PLUGIN_DATA}/sessions/${CLAUDE_SESSION_ID:-default}/notifications.log`, print the last 5 lines with `tail -n 5`. Each line is one JSON peer event — render `principal`, `event_type`, and `summary` for each. If the file does not exist, say "no notifications yet".
3. Do not make any MCP calls. This command is purely informational.
