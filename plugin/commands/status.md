---
description: Show Teamem activation state, monitor health, current Space, current mode, and routed recent notifications.
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/bin/teamem-flag:*), mcp__teamem__teamem_whoami, mcp__teamem__teamem_get_current_sprint, mcp__teamem__teamem_list_claims, mcp__teamem__teamem_get_briefing, mcp__plugin_teamem_teamem__teamem_whoami, mcp__plugin_teamem_teamem__teamem_get_current_sprint, mcp__plugin_teamem_teamem__teamem_list_claims, mcp__plugin_teamem_teamem__teamem_get_briefing
---

Steps:

1. Run `${CLAUDE_PLUGIN_ROOT}/bin/teamem-flag status` and show the activation plus monitor lines.
2. Call `mcp__teamem__teamem_whoami` and render the Space label and id.
3. Call `mcp__teamem__teamem_get_current_sprint` and render `mode`. In Sprint mode, render only the current Sprint display name, slug, and `current_members`. Do not call `mcp__teamem__teamem_list_sprints`; archived Sprint inventory belongs in `/teamem:sprint list` and explicit history/audit commands.
4. Call `mcp__teamem__teamem_list_claims` with `scope="self", view="current"` and render active/paused claims in the current context.
5. If the current mode is Sprint, call `mcp__teamem__teamem_list_claims` with `scope="self", view="outside_current_context"` and render those active/paused claims as cleanup leftovers outside the current context.
6. Call `mcp__teamem__teamem_get_briefing` with `token_budget=1000`. Render `recent_notifications` as the recent routed notifications; show each notification's `event_type`, `principal`, `summary`, and `routing_reason`.
7. From the same briefing response, render only `meta.cross_context_overlap_awareness.overlapping_claims` as a count. Do not render full overlap detail in status.
