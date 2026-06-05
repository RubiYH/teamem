---
description: Show your Teamem identity for the resolved space — principal, space_id, and label. Useful for diagnosing multi-principal / multi-space test setups.
allowed-tools: mcp__teamem__teamem_whoami, mcp__plugin_teamem_teamem__teamem_whoami
---

Steps:

1. Call `mcp__teamem__teamem_whoami` with an empty input object `{}`. Do NOT pass `space_id` or `principal` — the bridge resolves them from the verified JWT.

2. On success (`ok: true`), print exactly three lines:
   ```
   principal: <data.principal>
   space_id:  <data.space_id>
   label:     <data.label>
   ```
   Then add a one-line hint if the user is debugging across multiple HOME-overridden sessions:
   ```
   (this identity is read from your JWT — to see which credentials file is active, check ~/.teamem/credentials.json or your TEAMEM_CREDENTIALS_PATH override)
   ```

3. On `ok: false` with `error.code === "space_not_found"`: surface the server's enriched payload — print the `space_id`, `principal`, and `hint` fields verbatim. Then add: `Run /teamem-setup or rejoin via the CLI to recover.`

4. On any other error: print the error code and message verbatim and tell the user to check `/teamem-status` and the server log.
