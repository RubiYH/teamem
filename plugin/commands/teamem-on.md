---
description: Activate Teamem for this session — hooks fire, monitor polling is enabled, and one briefing loads. Add --persist to also enable future sessions in this project.
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/bin/teamem-flag:*), Bash(${CLAUDE_PLUGIN_ROOT}/bin/teamem-call:*), mcp__teamem__get_briefing
argument-hint: "[space?] [--persist]"
---

You are activating Teamem for this Claude Code session.

User input: `$ARGUMENTS`

Steps:

1. Parse `$ARGUMENTS`. The first non-flag token (if any) is the space label. The flag `--persist` means the user wants project-wide auto-on.
2. Run `${CLAUDE_PLUGIN_ROOT}/bin/teamem-flag enable` with `--space <space>` if a space was given and `--persist` if the flag was present. Show the script's stdout to the user verbatim.
3. Fetch a fresh briefing with `mcp__teamem__get_briefing` (token_budget=2000) so the main agent has team context loaded. If the call fails (auth missing, server unreachable), tell the user how to recover (`/teamem-setup` or `bun run setup --check` in their Teamem source checkout) and stop.
4. Print a 2-3 line summary of the briefing: current_plan title + active_claims count + open blockers count. Do not dump the full briefing — that's what `/teamem-briefing` is for.
5. Remind the user: "From now on Edit/Write tool calls will auto-claim scope. Run `/teamem-off` to silence Teamem. Run `/teamem-status` to inspect."

Never invent a space the user didn't ask for. If they belong to multiple spaces and didn't pass one, fall back to the configured `default_space`. If no default exists, prompt them to pass a label.
