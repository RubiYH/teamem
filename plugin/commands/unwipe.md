---
description: Reverse all outstanding soft-wipes (creator only). Clears tombstones and brings briefing data back. Cannot reverse a hard-wipe.
allowed-tools: mcp__teamem__space_unwipe
argument-hint: ""
---

Steps:

1. Call `mcp__teamem__space_unwipe` with `{}`. Do NOT pass any fields — `space_id` and `principal` come from the verified JWT.

2. Branch on the result:
   - **success**: print "Space unwiped. Pre-wipe briefing data is restored." Suggest the user run `/teamem:briefing` to confirm.
   - **`not_creator`**: tell the user only the creator can unwipe and stop.
   - **`not_wiped`** (409): tell the user there is nothing to reverse — either the space was never wiped, or the last operation was a hard-wipe (which left no events to anchor against). For hard-wipe recovery, suggest creating a fresh space via `bun run setup`.
   - **`space_disbanded`** (410): tell the user the space is currently disbanded — they must `/teamem:restore` before they can unwipe.
   - any other error: surface the typed code verbatim.

This command reverses **every outstanding** soft-wipe in one call — including rows stranded by an earlier wipe that was never unwiped. Wipes that were already reversed leave no tombstones to clear.
