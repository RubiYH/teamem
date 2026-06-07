---
description: Sprint lifecycle — create, join, leave, list, history, archive, reopen, or inspect your current Sprint. Space mode means no Sprint.
allowed-tools: mcp__plugin_teamem_teamem__teamem_create_sprint, mcp__plugin_teamem_teamem__teamem_join_sprint, mcp__plugin_teamem_teamem__teamem_leave_sprint, mcp__plugin_teamem_teamem__teamem_get_current_sprint, mcp__plugin_teamem_teamem__teamem_list_sprints, mcp__plugin_teamem_teamem__teamem_archive_sprint, mcp__plugin_teamem_teamem__teamem_reopen_sprint, mcp__plugin_teamem_teamem__teamem_get_sprint_history, mcp__teamem__teamem_create_sprint, mcp__teamem__teamem_join_sprint, mcp__teamem__teamem_leave_sprint, mcp__teamem__teamem_get_current_sprint, mcp__teamem__teamem_list_sprints, mcp__teamem__teamem_archive_sprint, mcp__teamem__teamem_reopen_sprint, mcp__teamem__teamem_get_sprint_history
argument-hint: "current|create <name> -- <goal>|join <slug-or-id>|leave|list|history <slug-or-id> [--limit N]|archive <slug-or-id>|reopen <slug-or-id>"
---

User input: `$ARGUMENTS`

Steps:

1. Parse the first word as the subcommand. Supported subcommands are `current`, `create`, `join`, `leave`, `list`, `history`, `archive`, and `reopen`.

2. Tool call rule: do not use ToolSearch, Bash, `/mcp`, or any discovery/probing command to find Sprint tools. The allowed tools are already listed in this command. In source-checkout local plugin sessions, call the exact `mcp__plugin_teamem_teamem__teamem_*` tool name first. In installed Teamem sessions, if the source-checkout name is not available, call the exact `mcp__teamem__teamem_*` installed name with the same input.

3. Branch:
   - `current` or empty input: call `mcp__plugin_teamem_teamem__teamem_get_current_sprint` with `{}`. Installed fallback: `mcp__teamem__teamem_get_current_sprint`.
   - `list`: call `mcp__plugin_teamem_teamem__teamem_list_sprints` with `{}`. Installed fallback: `mcp__teamem__teamem_list_sprints`.
   - `create <name> -- <goal>`: split on the first `--`. Trim both sides. If either side is empty, stop and tell the user to use `/teamem-sprint create <name> -- <goal>`. Call `mcp__plugin_teamem_teamem__teamem_create_sprint` with `{ "display_name": "<name>", "goal": "<goal>" }`. Installed fallback: `mcp__teamem__teamem_create_sprint`.
   - `join <slug-or-id>`: trim the remaining argument. If empty, stop and ask for a Sprint slug or id. Call `mcp__plugin_teamem_teamem__teamem_join_sprint` with `{ "sprint": "<slug-or-id>" }`. Installed fallback: `mcp__teamem__teamem_join_sprint`.
   - `leave`: call `mcp__plugin_teamem_teamem__teamem_leave_sprint` with `{}`. Installed fallback: `mcp__teamem__teamem_leave_sprint`.
   - `archive <slug-or-id>`: trim the remaining argument. If empty, stop and ask for a Sprint slug or id. Call `mcp__plugin_teamem_teamem__teamem_archive_sprint` with `{ "sprint": "<slug-or-id>" }`. Installed fallback: `mcp__teamem__teamem_archive_sprint`.
   - `reopen <slug-or-id>`: trim the remaining argument. If empty, stop and ask for a Sprint slug or id. Call `mcp__plugin_teamem_teamem__teamem_reopen_sprint` with `{ "sprint": "<slug-or-id>" }`. Installed fallback: `mcp__teamem__teamem_reopen_sprint`.
   - `history <slug-or-id> [--limit N]`: parse the slug/id and optional positive integer `--limit`. If no slug/id is present, stop and ask for one. Call `mcp__plugin_teamem_teamem__teamem_get_sprint_history` with `{ "sprint": "<slug-or-id>" }` and include `"limit": N` only when provided. Installed fallback: `mcp__teamem__teamem_get_sprint_history`.
   - Anything else: print the supported subcommands and stop.

4. Do NOT pass `space_id`, `principal`, `actor`, or `delegation`; the bridge and server derive those from the verified JWT/request context.

5. On success:
   - If the returned context mode is `space`, print `Space mode`.
   - If the returned context mode is `sprint`, print `<slug> — <display_name>` and the goal.
   - For `list`, print one compact line per Sprint: `<slug> — <display_name> [<state>]`, goal, current members, and last activity.
   - For `archive`, print the returned `message` and the count of `released_claims`.
   - For `history`, print only the returned lifecycle history entries. Do not call current/status/update tools as a side effect.
   - For create/join/leave responses, also print the returned `message`. If `idempotent` is true, say no lifecycle event was emitted.

6. On duplicate create (`sprint_already_exists`), print the server message and the `hint` from `error.details` (`join` for active Sprints, `reopen` for archived Sprints).

7. On other errors, surface the typed error code/message verbatim and suggest `/teamem-status` only for auth or membership errors.
