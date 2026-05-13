---
description: Share a gotcha with the team — a persistent lesson learned with tags, severity, and realtime/durable teammate notices.
allowed-tools: Bash(bash:*)
argument-hint: "<summary> [#tag1 #tag2 …] [--severity=info|warning|urgent]"
---

User input: `$ARGUMENTS`

Steps:

1. Run the bundled script exactly:

   ```bash
   bash "${CLAUDE_PLUGIN_ROOT}/scripts/teamem-gotcha.sh" "$ARGUMENTS"
   ```

2. Surface the script output directly. The script:
   - strips `#tag` tokens into a real JSON `tags` array,
   - strips `--severity=<info|warning|urgent>`,
   - sends `kind: "gotcha"` so the new gotcha Channel and SessionStart paths see it,
   - sends only the quick summary; richer `body`, `refs.paths`, or direct recipients should be shared by calling `teamem.share_finding` directly.

3. If parsing or the server call fails, show the typed error directly and ask the user to retry with a shorter summary or valid severity.

Notes:
- For richer payloads (body, refs.paths, recipient_principals) the agent should call `teamem.share_finding` directly rather than going through this slash command.
- `severity=urgent` alerts every teammate; only use for things that genuinely block other people's work right now.
