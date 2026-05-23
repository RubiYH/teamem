---
description: Deactivate Teamem for this session. Hooks become no-ops, monitor polling idles. MCP server stays connected for ad-hoc /teamem-* calls.
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/bin/teamem-flag:*)
argument-hint: "[--forget]"
---

User input: `$ARGUMENTS`

Steps:

1. Run `${CLAUDE_PLUGIN_ROOT}/bin/teamem-flag disable`. Show its stdout.
2. If `$ARGUMENTS` contains `--forget`, also run `${CLAUDE_PLUGIN_ROOT}/bin/teamem-flag forget` to clear the project-wide auto-on flag (so the next session does NOT re-activate). Show its stdout too.
3. Print: "Teamem is silent. /teamem-on to re-enable. /teamem-briefing still works on demand."

Do not call any MCP tools — deactivation is a local file operation only.
