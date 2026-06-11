<!-- Parent: ../../AGENTS.md -->
<!-- Generated: 2026-05-09 | Updated: 2026-05-09 -->

# teamem-onboarding

## Purpose

Interactive onboarding skill for creating or joining a Teamem space. Guides the user through: space setup (create new or join existing), member name configuration, git hook installation, and Teamem-aware Claude launcher activation guidance. Used by the `/teamem:setup` slash command.

## Key Files

| File | Description |
|------|-------------|
| `SKILL.md` | Onboarding skill prompt: input collection, space creation/join flow, git hook installation, activation guidance |

## For AI Agents

### Working In This Directory

- **Skill invocation**: Invoked by `/teamem:setup` slash command or manually via skill delegation.
- **Input collection**: Prompts for:
  1. Space action: create new space or join existing
  2. Space name (for new) or room code (for join)
  3. Member name (pre-filled from `git config --global user.name`, with validation to reject generic names like `root`, `ubuntu`, `admin`)
  4. Optional server URL (defaults to `https://teamem.local:7654` or configured default)
- **Git hook installation**: After setup completes, the skill guides the user to run `bun run teamem install-git-hooks` in their repo. This installs post-commit and post-checkout hooks into the git hooks directory.
- **Session activation**: Guides the user to launch `claude` and choose Teamem, or use `claude --teamem ...`. The deprecated `/teamem-on` activation command is no longer shipped; already-running pure sessions should be restarted through the launcher when hooks and monitor delivery are needed.

### Common Patterns

- **Space creation logic**:
  1. Call `mcp__teamem__space_create` with space name and optional server URL
  2. Receive `space_id` and `room_code` on success
  3. Show room code to user for sharing with teammates (warn: only via secure channel)
- **Space join logic**:
  1. Call `mcp__teamem__space_join` with room code and server URL
  2. Receive `space_id` on success
  3. Confirm membership
- **Member name validation**: Reject generic names (`root`, `ubuntu`, `admin`, `user`, `guest`, `test`). Force manual entry on these. Derive defaults from `git config user.name` or `$USER`.
- **Git hook setup**: The installer script (`src/cli/install-git-hooks.ts`) is invoked as `bun run teamem install-git-hooks`. This templates the plugin root path into git hooks and marks them as teamem-managed (idempotency marker on line 2).
- **Server URL configuration**: Allow user to override the default server URL (set via env var `TEAMEM_SERVER_URL` or config). The skill passes this to setup commands.

### Post-Onboarding Checklist

After the skill completes, the user should:
1. Run `bun run teamem install-git-hooks` (git hook installation)
2. Launch `claude` and choose Teamem, or run `claude --teamem ...`
3. Use `/teamem:status` to verify activation and monitor state after launch

## Dependencies

### Internal

- `../` (parent skills directory; registered in `plugin.json`)
- `../../lib/setup.js` (interactive setup CLI; invoked by the skill)

### External

- MCP tools: `mcp__teamem__space_create`, `mcp__teamem__space_join`, `mcp__teamem__get_briefing`
- Git tools: `git config --global user.name`, `git rev-parse --show-toplevel`
- `bun` CLI (for running setup and git hook installer)
- Claude Code skill execution environment

<!-- MANUAL: -->
