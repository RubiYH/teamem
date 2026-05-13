---
description: Disband the current space (creator only). Soft-tombstone with a 7-day grace window — data is retained and `/teamem-restore` can undo within that window. After grace, the space is hard-deleted by GC.
allowed-tools: mcp__teamem__space_disband, mcp__teamem__get_briefing
argument-hint: "<exact-space-label>"
---

User input: `$ARGUMENTS`

Disband is **destructive on a 7-day timer**. Be deliberate.

Steps:

1. Trim `$ARGUMENTS` and treat it as the user's typed `label_confirmation`. If empty, refuse — the user must paste the exact space label.

2. Call `mcp__teamem__space_disband` with `{ label_confirmation: "<arg>" }`. Do NOT pass any other fields — `space_id` and `principal` come from the verified JWT.

3. Branch on the result:
   - **success**: print "Space disbanded. Data is retained for 7 days; run `/teamem-restore` within that window to undo. After grace, GC will hard-delete everything." Note that the user's MCP calls will now reject with 410 until they restore.
   - **`label_required` / `label_mismatch`**: tell the user the typed label didn't match. Do NOT guess at the correct label — ask them to verify with `/teamem-status` or by re-running this command with the exact label they remember.
   - **`not_creator`**: tell the user only the creator can disband and stop.
   - any other error: surface the typed code verbatim.

4. Do NOT call `mcp__teamem__get_briefing` after success — auth will reject with 410. The tool is in `allowed-tools` only so the agent can confirm the label *before* the disband if the user asked it to look up the label rather than typing it.

**Important warnings to surface to the user:**
- All teammates will be JWT-rejected immediately on their next call — disband is visible across the whole space within seconds.
- Restore only works for 7 days; after that the space is irretrievable.
- Members do not receive an in-band notification; the team lead should communicate the disband out-of-band before running this.
