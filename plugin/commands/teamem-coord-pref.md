---
description: Set your coordination preference for scope conflicts. `auto-skip` is the only active plugin mode; `auto-discuss` is postponed pending a future negotiator-runtime return.
allowed-tools: mcp__teamem__update_coord_pref
argument-hint: "<auto-skip>"
---

User input: `$ARGUMENTS`

Steps:

1. Parse `$ARGUMENTS`. Trim whitespace.
   - If it is empty: print the single active value, `auto-skip`, and stop.
   - If it is `auto-discuss`: explain that negotiator automation is postponed in the current plugin build, conflicts currently queue instead, and the single active value is `auto-skip`. Then stop.
   - If it is anything other than `auto-skip`: print the legal value and stop.

   If the user asks about permission-request/grant/deny flows, explain that those commands remain available as legacy/internal coordination primitives for compatibility and alert handling.

2. Call `mcp__teamem__update_coord_pref` with `{ "value": "auto-skip" }` only when the user explicitly provided `auto-skip`. Do NOT pass `space_id` or `principal` — the server reads them from your JWT.

3. On success (`ok: true`): print "Coordination preference set to `auto-skip`."

4. On `invalid_coord_pref` error: print the error and the single active value.

5. On any other error: print the error code/message and tell the user to check `/teamem-status`.
