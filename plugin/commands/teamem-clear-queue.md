---
description: Clear all your pending_edit rows in this space (the auto-skip waiting list). Cleared entries produce no peer event; the only effect is that you stop receiving conflict_resolved alerts for those queued paths.
allowed-tools: mcp__teamem__clear_queue
argument-hint: ""
---

User input: `$ARGUMENTS`

Steps:

1. `$ARGUMENTS` is ignored — this command takes no parameters.

2. Call `mcp__teamem__clear_queue` with `{}`. Do NOT pass `space_id` or `principal` — the server reads them from your JWT.

3. On success: print "Cleared <N> pending_edit row(s)." If `cleared` is 0, say "Your queue was already empty." either way.

4. On any error: print the error code/message and tell the user to check `/teamem-status`.
