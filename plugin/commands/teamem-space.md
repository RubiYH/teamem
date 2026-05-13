---
description: Space governance — list, leave, kick, rotate-code. Disband and restore live in their own /teamem-disband and /teamem-restore commands.
allowed-tools: mcp__teamem__space_leave, mcp__teamem__space_kick, mcp__teamem__space_rotate_code, mcp__teamem__get_briefing
argument-hint: "list|leave|kick <member>|rotate-code"
---

User input: `$ARGUMENTS`

Steps:

1. Parse `$ARGUMENTS`:
   - `list` → use `/teamem-status` instead. That command surfaces every space in the user's local credentials file and is the supported v1 path. Tell the user to run `/teamem-status` and stop.
   - `leave` → call `mcp__teamem__space_leave` with `{}`. The bridge fills `space_id` and `principal` from the verified JWT.
   - `kick <member_name>` → confirm with the user (destructive — kicked member's next API call returns 401), then call `mcp__teamem__space_kick` with `{ member_name: "<arg>" }`. Creator-only.
   - `rotate-code` → call `mcp__teamem__space_rotate_code` with `{}`. Surface the new room code to the user with a reminder it must be shared via a SECURE channel.
   - Any other subcommand: refuse and remind the user `/teamem-disband` and `/teamem-restore` have their own slash commands.

2. For destructive subcommands (`kick`, `leave`): show the user what will happen and ask for explicit "yes" confirmation before invoking the MCP tool.

3. Branch on the typed error code:
   - `creator_must_disband` (leave): tell the user the creator can't leave; they must `/teamem-disband` instead.
   - `not_creator` (kick): tell the user only the creator can kick.
   - `cannot_self_kick`: refuse — use `/teamem-disband` if the creator wants to leave the team.
   - `target_not_found` (kick): the named member is not in the space.
   - `member_kicked` / `space_disbanded` (any): the user's own JWT is rejecting; redirect to `/teamem-setup`.

4. After `rotate-code`, remind the user the new code expires in 30 days and must be shared securely.

This command does NOT activate Teamem — it's pure space governance. Activation is `/teamem-on`. Disband + restore use their own dedicated slash commands so the destructive label-confirmation flow is isolated. Listing local credentials is a local-only read; `/teamem-status` is the supported entry point.
