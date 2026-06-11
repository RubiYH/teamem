<!-- Parent: ../../AGENTS.md -->
<!-- Generated: 2026-05-09 | Updated: 2026-05-09 -->

# teamem-handoff

## Purpose

Structured skill for handing off claimed scope to a specific teammate. Guides the user through collecting handoff inputs (scope, recipient, status notes), composing a formatted message, releasing the user's claim, and verifying delivery through the recipient's inbox or next session sync.

## Key Files

| File | Description |
|------|-------------|
| `SKILL.md` | Handoff skill prompt: inputs collection, confirmation gate, tool invocations (post_message, release_scope) |

## For AI Agents

### Working In This Directory

- **Skill invocation**: Invoked manually via `/oh-my-claudecode:write-a-skill` (manual invocation) or when a user delegates handoff via skill invocation.
- **Confirmation gate**: Skill shows the handoff summary (scope, recipient, status, deadline) and requires explicit "ship it?" confirmation before releasing any claims or posting messages.
- **Message format**: Composing the message is part of the skill logic. The formatted message uses a checklist structure:
  ```
  Handoff: <scope summary>
  - Status: <done so far>
  - Pending: <what's left>
  - Branch / commits: <ref>
  - Deadline: <if any>
  - Notes: <gotchas>
  ```

### Common Patterns

- **Inputs needed** (collected before confirmation):
  1. Claim ID or scope paths the user is handing off
  2. Recipient principal (teammate's name in the space)
  3. Handoff note (status, pending work, gotchas)
  4. Optional deadline
- **Refusal cases**:
  - User tries to hand off a claim ID they did not enumerate themselves
  - Recipient principal is not in the user's active space
  - Teamem is idle (session was not launched with Teamem) — recipient won't see the message until their next Teamem-launched session
- **Tool sequence**:
  1. `mcp__teamem__post_message` with recipient and formatted note
  2. `mcp__teamem__release_scope` with claim ID
  3. User is told to check `/teamem:status` to see discussion in their inbox

## Dependencies

### Internal

- `../` (parent skills directory; registered in `plugin.json`)

### External

- MCP tools: `mcp__teamem__post_message`, `mcp__teamem__release_scope`, `mcp__teamem__get_briefing`
- Claude Code skill execution environment

<!-- MANUAL: -->
