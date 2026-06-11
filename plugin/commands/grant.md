---
description: Grant a pending legacy/internal edit-permission request from a teammate (compatibility path). Atomically narrows your claim — only the requested paths leave your hold; the rest stays yours. The requester's gate-claim long-poll returns immediately with allow.
allowed-tools: mcp__teamem__respond_permission_request
argument-hint: "<req_id>"
---

User input: `$ARGUMENTS`

Steps:

1. Parse `$ARGUMENTS` as `<req_id>`. If empty, ask the user to copy the `req_id` from `/teamem:status`, the unread queue, or the relevant discussion record.

2. Call `mcp__teamem__respond_permission_request` with `{ "req_id": "<id>", "decision": "accept" }`. Do NOT pass `space_id` / `principal` / `actor` / `delegation` — the server reads them from your JWT.

3. On success: print "Granted req <id>. Released paths: <released_paths>. Kept paths: <kept_paths>. New claim for the requester: <new_claim_id>." The requester's edit will start within milliseconds.

4. On error:
   - `not_incumbent` → "You are not the incumbent on the cited claim. Only the holder of the blocking claim can grant."
   - `already_resolved` → "Request was already granted, denied, or expired. Nothing to do."
   - `permission_request_not_found` → "No request with that id. Check `/teamem:status` for active permission requests."
   - other → print the error code/message verbatim.
