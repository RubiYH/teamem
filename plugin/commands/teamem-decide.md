---
description: Record an architectural / process / product / plan decision so teammates see it in their next briefing.
allowed-tools: mcp__teamem__teamem_record_decision, mcp__plugin_teamem_teamem__teamem_record_decision
argument-hint: "<title> -- <summary> [--kind=plan|architectural|product|process]"
---

User input: `$ARGUMENTS`

Steps:

1. Parse `$ARGUMENTS`:
   - Everything before the first `--` is the title.
   - Everything after is the summary.
   - `--kind=<one of plan|architectural|product|process>` may appear anywhere; default is `architectural`.
   - If `--` is missing or title/summary is empty, ask the user to restructure as `title -- summary`.

2. Generate a `decision_id` of the shape `dec-<short-slug-from-title>` (lowercase, hyphenate, max 40 chars).

3. Call the available Teamem `record_decision` MCP tool with `{ decision_id, title, summary, kind }`. In installed Teamem sessions this is `mcp__teamem__teamem_record_decision`; in source-checkout local plugin sessions Claude may expose the same tool with a plugin-scoped name ending in `_record_decision`. Do NOT pass space_id/principal.

4. On success print "Recorded decision \<id\>". Note: a `kind=plan` decision **supersedes** all prior open plan decisions in this space — warn the user before submitting if `kind=plan` and they didn't explicitly ask for plan-kind.
