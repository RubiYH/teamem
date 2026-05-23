<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-09 | Updated: 2026-05-10 -->

# commands

## Purpose

Slash command definitions for Teamem. Each `.md` file is a complete command that Claude Code exposes as `/teamem-<name>`. Commands provide user-facing entry points for setup, diagnostics, decisions, gotchas, discussion, and administrative operations. Claim lifecycle operations are MCP/tool-driven rather than slash-command-driven.

## Key Files

| File | Description |
|------|-------------|
| `teamem-briefing.md` | Fetch and display the current plan, claims, decisions, risks, progress |
| `teamem-clear-queue.md` | Clear pending-edit queue from auto-skip conflicts |
| `teamem-coord-pref.md` | Set the active conflict coordination preference (`auto-skip`; `auto-discuss` is postponed) |
| `teamem-decide.md` | Record an architectural or process decision for the team |
| `teamem-deny.md` | Deny a pending legacy/internal edit-permission request |
| `teamem-disband.md` | Disband the current space (soft-tombstone for 7 days) |
| `teamem-discuss.md` | Send a discussion message to a teammate or broadcast |
| `teamem-end-dispute.md` | Terminate an open dispute (user override) |
| `teamem-gotcha.md` | Share a persistent gotcha with summary, tags, and severity |
| `teamem-grant.md` | Grant a pending legacy/internal edit-permission request |
| `teamem-off.md` | Deactivate Teamem for this session (stop monitor, keep MCP) |
| `teamem-on.md` | Activate Teamem for this session (enable monitor polling, fetch briefing) |
| `teamem-reset.md` | Reset session state (clear cursor, retry claims, remove local state) |
| `teamem-restore.md` | Restore a soft-disbanded space within the 7-day grace window |
| `teamem-rule.md` | Initialize or publish Space Rules through the managed `TEAMEM.md` replica |
| `teamem-setup.md` | Create or join a Teamem space (delegates to teamem-onboarding skill) |
| `teamem-space.md` | Manage space membership, code rotation, membership operations |
| `teamem-status.md` | Show current session activation status and recent events |
| `teamem-unwipe.md` | Recover a soft-wiped space's projection state |
| `teamem-whoami.md` | Show current principal and space identity |
| `teamem-wipe.md` | Wipe space's projection state (soft or hard) |

## For AI Agents

### Working In This Directory

- **Frontmatter contract**: Each command has YAML frontmatter with `description` (user-facing help text), `allowed-tools` (which MCP tools the command can invoke), and `argument-hint` (expected syntax). Claude Code validates against this contract.
- **Imperative steps**: Command bodies are step-by-step instructions that Claude Code executes. Steps include: argument parsing, validation, tool invocation, error handling, and formatted response.
- **Tool invocation pattern**: Commands invoke MCP tools via `mcp__teamem__<tool_name>` (bridge auto-parses JSON payloads). The `allowed-tools` frontmatter field lists which tools are available.
- **Error handling**: Commands show error codes verbatim (e.g., `409 scope_conflict`, `401 not_member`). They suggest next steps (run `/teamem-status`, contact space creator, etc.) but do NOT auto-remediate.

### Common Patterns

- **Claim lifecycle**: There are intentionally no claim lifecycle slash commands. Agents should translate natural-language claim requests into MCP tools (`teamem.claim_scope`, `teamem.list_claims`, `teamem.release_scope`, `teamem.force_release`) and ask for confirmation before risky force-release actions.
- **Coordination** (`teamem-coord-pref`, `teamem-discuss`, `teamem-end-dispute`, `teamem-grant`, `teamem-deny`): The active user-facing preference is `auto-skip`. `auto-discuss` is retained only as a postponed/legacy concept, and stale rows degrade to queueing in `gate-claim.sh`. `teamem-grant` / `teamem-deny` remain legacy/internal permission-response commands for compatibility and alert handling. `/teamem-discuss` is a direct sender: it parses `<principal|*> -- <topic>`, fail-closes on malformed input, and makes one `mcp__teamem__post_message` call.
- **Space operations** (`teamem-on`, `teamem-off`, `teamem-setup`, `teamem-space`, `teamem-disband`, `teamem-restore`, `teamem-wipe`, `teamem-unwipe`): Activation state is per-session. Disband/restore use 7-day soft-tombstone. Wipe/unwipe mask projection rows. Code rotation changes the room code for the space.
- **Information** (`teamem-briefing`, `teamem-decide`, `teamem-gotcha`, `teamem-status`, `teamem-whoami`): Read-only or audit-trail operations plus lightweight memory sharing. Briefing includes token budgets for long-form responses. Gotcha records persistent lessons through the `teamem.share_finding` substrate. `/teamem-on` performs an actual briefing read after activation; the SessionStart hook only emits a stdout prompt that instructs the main agent to perform that read on startup/resume.
- **Space Rules** (`teamem-rule`): `/teamem-rule init` creates or refreshes the managed `TEAMEM.md` block from the server snapshot or starter template. `/teamem-rule update` publishes the local managed-block body and rewrites from the regenerated server snapshot. Do not add free-form subcommands without matching scripts and tests.
- **Local E2E persona separation**: Slash commands use the active bridge credentials. On distinct computers, each teammate can use the default `~/.teamem/credentials.json`. For one-machine Alice/Bob simulation only, launch Claude Code with distinct `TEAMEM_CREDENTIALS` paths per session or commands will operate as whichever persona last overwrote the default credentials file.

## Dependencies

### Internal

- `../bin/teamem-call` (used by all commands to invoke MCP tools)
- `../agents/` (some commands delegate to subagents for complex workflows: teamem-setup → teamem-onboarding)
- `../skills/` (teamem-handoff and teamem-onboarding skills are invoked by commands)

### External

- MCP tools: `mcp__teamem__*` (full tool surface from `src/server/tools.ts`)
- Claude Code command execution environment (provides `$ARGUMENTS`, standard input/output, environment variables)

<!-- MANUAL: -->
