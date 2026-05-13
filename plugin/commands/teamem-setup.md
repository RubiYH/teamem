---
description: Walk through Teamem onboarding (create or join a space, write credentials). Run once on first install.
allowed-tools: Bash(bun:*)
argument-hint: ""
---

User input: `$ARGUMENTS`

Steps:

1. Hand off to the `teamem-onboarding` skill, which guides the user through the interactive setup flow (server URL prompt, member name pre-filled from `git config user.name` when available, create-or-join, room-code entry, and the current queue-first coordination default). The skill spawns the bundled setup CLI:

   ```bash
   bun run "${CLAUDE_PLUGIN_ROOT}/lib/setup.js"
   ```

   No source-tree dependency — `setup.js` is bundled into the plugin alongside `bridge.js` (see ADR-0003).

2. When setup completes successfully, tell the user to run `/teamem-on` to activate the plugin for the current session (and `/teamem-on --persist` to auto-activate future sessions in this project).

3. If `setup.js` is missing under `${CLAUDE_PLUGIN_ROOT}/lib/`, the plugin install is broken — tell the user to reinstall via `claude plugin install` from a Teamem source checkout that ran `bun run build:plugin` first.

Never run setup non-interactively from this slash command — it prompts the user for a server URL, room code, and member name and those decisions need their input. The non-interactive `--json` mode is reserved for e2e tests.
