---
description: Restore a soft-disbanded space within its 7-day grace window (creator only). After grace, the space is gone for good.
allowed-tools: mcp__teamem__space_restore
argument-hint: ""
---

Steps:

1. Call `mcp__teamem__space_restore` with `{}`. Do NOT pass any fields — `space_id` and `principal` come from the verified JWT.

2. Branch on the result:
   - **success**: print "Space restored. JWTs work again and all data is intact." Recommend the user run `/teamem:status` to confirm.
   - **`not_creator`**: tell the user only the creator can restore and stop.
   - **`not_disbanded`**: tell the user the space is already active; nothing to restore. Stop.
   - **`grace_expired`**: tell the user the 7-day grace window has elapsed — the space has been hard-deleted by GC and cannot be recovered. Suggest creating a fresh space via `bun run setup`.
   - any other error: surface the typed code verbatim.

3. The MCP call goes through `POST /spaces/restore`, which bypasses the standard auth-middleware 410 gate (a disbanded space normally rejects all calls). The route verifies the JWT manually and checks `is_creator` before flipping the tombstone.

Do not call any other Teamem MCP tool from this command — restore is the only valid action when the space is disbanded.
