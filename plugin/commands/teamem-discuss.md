---
description: Send a discussion message directly to a teammate (or broadcast to the space). Useful for negotiating claim handoffs, blocked-on requests, or sharing context.
allowed-tools: mcp__teamem__post_message
argument-hint: "<principal|*> -- <topic>"
---

User input: `$ARGUMENTS`

Parse `$ARGUMENTS` as `<principal|*> -- <topic>`.

Fail closed on malformed input:
- If `--` is missing, stop and tell the user to use `/teamem-discuss <principal|*> -- <topic>`.
- If the recipient token before `--` is empty, stop and ask for a recipient principal or `*`.
- If the topic after `--` is empty or whitespace-only, stop and ask for a non-empty message body.

Recipient mapping:
- If the recipient token is `*`, this is a broadcast. Omit `recipient_principal` from the tool input.
- Otherwise treat the token as the exact direct `recipient_principal`.
- Never pass `"null"` as a string. `"null"` is a literal teammate name, not broadcast routing.

For broadcasts, call `mcp__teamem__post_message` exactly once with:

```json
{
  "body": "<trimmed topic>"
}
```

For direct sends, call `mcp__teamem__post_message` exactly once with:

```json
{
  "recipient_principal": "<exact principal>",
  "body": "<trimmed topic>"
}
```

Do not add `thread_id` or `in_reply_to` here. This command starts a direct discussion send.

For the Claude Code Channels POC:
- Directed sends target only the named recipient.
- Broadcast sends target non-senders in the same Teamem space.
- If the optional channel runtime is unavailable, the stored discussion still remains visible through Teamem's existing thread-reading and inbox paths.

If Teamem is not active in this session (no `${CLAUDE_PLUGIN_DATA}/sessions/${CLAUDE_SESSION_ID:-default}/active`), surface this one-line tip without changing the send behavior: `Teamem is idle — restart Claude Code with claude --teamem to enable SessionStart sync and optional channel delivery for this discussion.`
