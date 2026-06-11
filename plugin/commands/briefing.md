---
description: Fetch the current Teamem briefing (current plan, active claims, recent decisions, active risks, recent progress).
allowed-tools: mcp__teamem__teamem_get_briefing, mcp__plugin_teamem_teamem__teamem_get_briefing
argument-hint: "[token_budget?]"
---

User input: `$ARGUMENTS`

Steps:

1. Parse `$ARGUMENTS`. If it contains a number, that is the `token_budget`. Otherwise default to 4000.
2. Call `mcp__teamem__teamem_get_briefing` with `{ "token_budget": <budget> }`. Do NOT pass `space_id` or `principal` — the bridge injects them from the JWT.
3. Render the response as five sections, in this order:
   - **Current plan** — `current_plan.title` and `current_plan.summary` (one paragraph each, omit empty fields).
   - **Active claims** — bullet list, one per claim: `principal · paths · expires_in_minutes`.
   - **Recent decisions** — bullet list, most recent first, of `title` (and `kind` in parens if present).
   - **Active risks** — bullet list of open blockers + unresolved conflicts. Empty section means "none open".
   - **Recent progress** — bullet list of completed tasks.
4. If the call fails, surface the error code and message verbatim and suggest `/teamem:setup`.

Keep the rendering compact. The user is reading this in a terminal.
