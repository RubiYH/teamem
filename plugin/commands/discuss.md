---
description: Send a discussion message directly to a teammate, the current Sprint, or the Space. Useful for negotiating claim handoffs, blocked-on requests, or sharing context.
allowed-tools: mcp__teamem__teamem_post_message, mcp__plugin_teamem_teamem__teamem_post_message
argument-hint: "<principal|*|**> -- <topic>"
---

User input: `$ARGUMENTS`

Parse `$ARGUMENTS` as `<principal|*|**> -- <topic>`.

Fail closed on malformed input:
- If `--` is missing, stop and tell the user to use `/teamem:discuss <principal|*|**> -- <topic>`.
- If the recipient token before `--` is empty, stop and ask for a recipient principal, `*`, or `**`.
- If the topic after `--` is empty or whitespace-only, stop and ask for a non-empty message body.

Recipient mapping:
- If the recipient token is `*`, this is a broadcast. Omit `recipient_principal` from the tool input. In Sprint mode this broadcasts to the current Sprint; in Space mode it remains Space-wide.
- If the recipient token is `**`, send `recipient_principal: "**"` for explicit Space-wide escalation.
- Never pass `"null"` as a string. `"null"` is a literal teammate name, not broadcast routing.
- Otherwise treat the token as the exact direct `recipient_principal`.

For broadcasts, call the matching form exactly once.

Tool naming:

- In installed Teamem sessions, the canonical tool name is `mcp__teamem__teamem_post_message`.
- In source-checkout local plugin sessions, Claude may expose the same Teamem tool with a plugin-scoped name ending in `_post_message`. If that plugin-scoped tool is available, call it instead of stopping. Do not report `mcp__teamem__teamem_post_message` as missing when an available Teamem `post_message` tool exists under a plugin-scoped name.

For `*` broadcasts, call the available Teamem `post_message` tool (`mcp__teamem__teamem_post_message` in installed sessions) with:

```json
{
  "body": "<trimmed topic>"
}
```

For `**` Space-wide escalation broadcasts, call the available Teamem `post_message` tool (`mcp__teamem__teamem_post_message` in installed sessions) with:

```json
{
  "recipient_principal": "**",
  "body": "<trimmed topic>"
}
```

For direct sends, call the available Teamem `post_message` tool (`mcp__teamem__teamem_post_message` in installed sessions) exactly once with:

```json
{
  "recipient_principal": "<exact principal>",
  "body": "<trimmed topic>"
}
```

Do not add `thread_id` or `in_reply_to` here. This command starts a direct discussion send.

For the Claude Code Channels POC:
- Directed sends target only the named recipient.
- `*` broadcast sends to the current Sprint in Sprint mode and the Space in Space mode.
- `**` broadcast escalates Space-wide, including members currently in Sprints.
- If the optional channel runtime is unavailable, the stored discussion still remains visible through Teamem's existing thread-reading and inbox paths.

If Teamem is not active in this session (no `${CLAUDE_PLUGIN_DATA}/sessions/${CLAUDE_SESSION_ID:-default}/active`), surface this one-line tip without changing the send behavior: `Teamem is idle — restart Claude Code with claude --teamem to enable SessionStart sync and optional channel delivery for this discussion.`
