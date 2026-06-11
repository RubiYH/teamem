---
description: Wipe the current space's projection state (creator only). Soft (default) is reversible via `/teamem:unwipe`; `--hard` is permanent and requires the typed space label.
allowed-tools: mcp__teamem__space_wipe
argument-hint: "[--hard <exact-space-label>]"
---

User input: `$ARGUMENTS`

Wipe is **destructive on the projection state** — every claim, decision, blocker, discussion, contract, and task row in the space is tombstoned (soft) or deleted (hard). Unlike disband, the space stays alive — JWTs keep working, members stay in. Use this when the team needs a clean slate without losing membership.

Steps:

1. Trim `$ARGUMENTS`. Branches:
   - **Empty** → soft wipe. Confirm with the user once: "Soft-wipe this space? Briefing will return empty until you run `/teamem:unwipe`. Y/n". Only proceed on explicit Y.
   - **Starts with `--hard`** → hard wipe. The remainder of the string MUST be the typed space label. If empty, refuse — paste the exact label after `--hard`. Confirm twice with the user before submitting: "HARD wipe is irreversible — events + projection rows for this space will be deleted permanently. Type the space label exactly, then confirm Y. Y/n". Only proceed on explicit Y.

2. Call `mcp__teamem__space_wipe`:
   - Soft: `{}`
   - Hard: `{ hard: true, label_confirmation: "<exact-label>" }`

3. Branch on the result:
   - **success (soft)**: print "Space soft-wiped. Briefing will return empty until you run `/teamem:unwipe`." Suggest the user run `/teamem:briefing` to confirm.
   - **success (hard)**: print "Space hard-wiped. Events + projection rows are gone. Members + room code are intact, but `/teamem:unwipe` will not work — you'd need to start a fresh space if you want history."
   - **`label_required` / `label_mismatch`**: tell the user the typed label didn't match for the `--hard` flag. Refuse to retry without verifying the label via `/teamem:status`.
   - **`not_creator`**: tell the user only the creator can wipe and stop.
   - **`space_disbanded`** (410): tell the user the space is currently disbanded — they must `/teamem:restore` before they can wipe.
   - any other error: surface the typed code verbatim.

**Important warnings to surface to the user:**
- Wipe does NOT 410 anyone — teammates' MCP calls keep working but their briefings go empty until restore.
- Soft-wipe survives a subsequent disband+restore cycle; tombstones are intact across that flow.
- Hard-wipe leaves no `space_wiped` event for `/teamem:unwipe` to anchor against. The choice is one-way.
