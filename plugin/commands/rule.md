---
description: Initialize local TEAMEM.md from the active space snapshot, or publish a local Space Rules draft back to the server.
allowed-tools: Bash(bash:*)
argument-hint: "init | update"
---

User input: `$ARGUMENTS`

Steps:

1. Parse `$ARGUMENTS`. Supported subcommands are `init` and `update`.

2. If the user passed `init`, run:

   ```bash
   bash "${CLAUDE_PLUGIN_ROOT}/scripts/teamem-rule-init.sh"
   ```

3. If the user passed `update`, run:

   ```bash
   bash "${CLAUDE_PLUGIN_ROOT}/scripts/teamem-rule-update.sh"
   ```

4. Surface the script output directly:
   - `init`: report whether `TEAMEM.md` was created from the starter template or whether only the Teamem-managed block was refreshed
   - `update`: report that the local draft was published and `TEAMEM.md` was rewritten from the regenerated server snapshot
   - if the server rejects the publish as stale or unauthorized, show that failure directly instead of trying to recover locally

5. If the user passed anything else, stop and tell them `/teamem:rule` currently supports only `init` and `update`.

6. If the script fails because credentials or membership are missing, direct the user to `/teamem:setup` or to restart Claude Code with `claude --teamem`.
