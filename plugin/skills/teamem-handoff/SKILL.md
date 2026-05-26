---
name: teamem-handoff
description: Hand a claimed scope from the user to a specific teammate — release my claim, post a discussion message explaining the handoff, optionally request the teammate to claim it next. Use when the user is stopping work mid-feature and wants someone else to pick it up.
allowed-tools: mcp__teamem__post_message, mcp__teamem__release_scope, mcp__teamem__get_briefing
---

# Teamem Handoff

You are coordinating a clean handoff of in-flight work to a teammate.

## Inputs you need

- The `claim_id` (or scope paths) the user is handing off.
- The `recipient_principal` (teammate's name in the space).
- A **handoff note**: what's done, what's pending, where to look. 2-5 sentences.
- Optional: the user's preferred completion deadline.

If any are missing, ask before doing anything.

## Steps

1. Confirm the handoff with the user — show them the four inputs and ask "ship it?". Do not proceed without explicit confirmation.

2. Compose the handoff message. Format it like a checklist for the recipient:

   ```
   Handoff: <scope summary>
   - Status: <done so far>
   - Pending: <what's left>
   - Branch / commits: <ref>
   - Deadline: <if any>
   - Notes: <gotchas>
   ```

3. Post the message via `mcp__teamem__post_message`:
   - `recipient_principal`: the teammate
   - `body`: the formatted note above
   - (no `thread_id` — handoffs start a new thread)

4. Release the user's claim via `mcp__teamem__release_scope` with the `claim_id`.

5. Tell the user the recipient can pick the message up via SessionStart sync, `/teamem-status`, or optional channel delivery; they can run `/teamem-status` to see the discussion in their inbox.

## Refusal cases

- Refuse to release a claim_id the user didn't enumerate themselves (cross-check against their `active_claims`).
- Refuse to handoff to a principal who is not in the user's active space (verify via `get_briefing` if uncertain).
- Refuse if Teamem is idle (the session was not launched with Teamem) — without active subscribers, the recipient won't see the message until their next Teamem-launched session.
