---
description: Deny a pending legacy/internal edit-permission request from a teammate (compatibility path). Your claim is unchanged; the requester's gate-claim long-poll returns with skip and they fall through to the auto-skip queue — they will be alerted when you eventually release.
allowed-tools: mcp__teamem__respond_permission_request
argument-hint: "<req_id>"
---

User input: `$ARGUMENTS`

Steps:

1. Parse `$ARGUMENTS` as `<req_id>`. If empty, ask the user to copy the `req_id` from `/teamem:status`, the unread queue, or the relevant discussion record.

2. Call `mcp__teamem__respond_permission_request` with `{ "req_id": "<id>", "decision": "deny" }`. Do NOT pass `space_id` / `principal` — the server reads them from your JWT.

3. On success: print "Denied req <id>. Your claim is unchanged. The requester's edit was rejected; they have been queued in the auto-skip lane and will be alerted when you release."

4. On error:
   - `not_incumbent` → "You are not the incumbent on the cited claim. Only the holder of the blocking claim can deny."
   - `already_resolved` → "Request was already granted, denied, or expired. Nothing to do."
   - `permission_request_not_found` → "No request with that id. Check `/teamem:status` for active permission requests."
   - other → print the error code/message verbatim.
