---
description: Wipe local Teamem state (credentials, daemon, caches). Source-checkout-only — marketplace-installed users follow the manual fallback below.
allowed-tools: Bash(bun:*), Bash(rm:*), Bash(${CLAUDE_PLUGIN_ROOT}/bin/teamem-flag:*)
argument-hint: "[--keep-credentials]"
---

User input: `$ARGUMENTS`

This is a **destructive operation** that wipes local Teamem state on the user's machine. Before running anything:

1. Tell the user exactly what will be wiped and ask for explicit "yes" confirmation. Subject to `$ARGUMENTS`:
   - default: `~/.teamem/credentials.json`, `~/.cache/teamem/`, `${CLAUDE_PLUGIN_DATA}/sessions/<sid>/`, plugin session active flag
   - `--keep-credentials`: preserve `~/.teamem/credentials.json`

2. **Source-checkout users** can run the canonical reset CLI:
   ```bash
   cd <teamem-checkout> && bun run reset --yes <flags>
   ```
   That handles docker volume + daemon teardown if applicable. This path requires you to know where the source tree lives — there is no bundled equivalent in the plugin because the reset CLI operates on the user's local Claude config and (optionally) docker volumes, not on server-side data the plugin can reach via MCP.

3. **Marketplace-installed users without a source checkout** must run the equivalent commands manually:
   ```bash
   # Remove credentials (skip if --keep-credentials)
   rm -f ~/.teamem/credentials.json

   # Remove hook + monitor caches
   rm -rf ~/.cache/teamem/

   # Remove plugin session state
   rm -rf "${CLAUDE_PLUGIN_DATA}/sessions"

   # Disable the plugin's session flag
   "${CLAUDE_PLUGIN_ROOT}/bin/teamem-flag" disable
   ```
   The Claude Code plugin tooling does not yet expose a one-shot reset MCP tool; the operations above are entirely client-side and local. v1.x will keep this manual; v2 may bundle a `reset.js` artifact alongside `bridge.js` and `setup.js`.

4. Disable the plugin's session flag so the next prompt sees a clean state:
   ```bash
   "${CLAUDE_PLUGIN_ROOT}/bin/teamem-flag" disable
   ```

5. Remind the user to run `/teamem-setup` if they want to reconnect.

Refuse to proceed if the user did not type "yes" (case-insensitive). Server-side data (events, claims, the team's space row) is **NOT** touched by this command — it only resets the user's own local connection state. To remove server-side data, the team lead uses `/teamem-disband` (soft) or `/teamem-wipe --hard` (compliance).
