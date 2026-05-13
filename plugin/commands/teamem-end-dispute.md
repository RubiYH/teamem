---
description: Legacy/manual termination of an open Mode 6.C dispute. Keep for older dispute threads or direct tool use; the current plugin build does not auto-open or auto-negotiate disputes.
allowed-tools: mcp__teamem__end_dispute
argument-hint: "<thread_id> <accept|deny|skip>"
---

User input: `$ARGUMENTS`

Steps:

1. Trim `$ARGUMENTS`. Two positional words are required: `<thread_id> <action>`.
   - `thread_id` — the dispute thread id (from `/teamem-status` or a stored dispute record).
   - `action` — one of `accept`, `deny`, `skip`. Anything else: refuse and ask the user to retry.
   - If either is missing, refuse and tell them the expected shape.

2. Confirm with the user before submitting if the action is `accept` — that applies the latest open proposal atomically (release / split / swap). For `deny` or `skip`, no double-confirmation is needed.

3. Call `mcp__teamem__end_dispute` with `{ thread_id, action }`. Do NOT pass `space_id` or `principal` — they come from the verified JWT.

4. Branch on the result:
   - **success (`status: resolved`)**: print "Dispute resolved with outcome: \<outcome\>." Suggest `/teamem-briefing` to confirm the new claim state.
   - **success (`status: terminated`)**: print "Dispute terminated (\<outcome\>)." If outcome is `skip`, remind the user their auto-skip queue entry (if any) will resolve when the incumbent releases.
   - **`dispute_not_found`**: tell the user the thread id doesn't match any dispute they're a party to.
   - **`dispute_closed`**: tell the user the dispute already ended.
   - **`not_dispute_party`**: tell the user only the opener or target can end the dispute — they're a bystander.
   - **`no_open_proposal`**: only fires for `action: accept`. Tell the user there's no open proposal to accept; they need to `deny` or `skip` instead.
   - any other error: surface the typed code verbatim.
