<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-09 | Updated: 2026-05-13 -->

# plugin

## Purpose

The Claude Code plugin distribution for Teamem. This directory contains the marketplace plugin manifest, slash commands, git hooks, hook configuration, prebuilt JavaScript bundles (committed; built from src/), monitors, agents, and skills. The plugin is self-contained and installable via `claude plugin install ./plugin --scope project` on any machine with Bun.

## Key Files

| File | Description |
|------|-------------|
| `.claude-plugin/plugin.json` | Marketplace manifest: name, current plugin version, skills path, MCP servers config |
| `.mcp.json` | MCP server declarations (`teamem-channel` for Channels POC) |
| `README.md` | User-facing installation, activation model, phase 1 Channels POC guide |
| `hooks/hooks.json` | Claude lifecycle hooks: `SessionStart`, `PreToolUse`, `Stop`, and disabled `Notification` routing — active hooks route to bash scripts only |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `.claude-plugin/` | Plugin manifest and metadata — see `.claude-plugin/AGENTS.md` |
| `agents/` | Subagent prompts (currently briefing only; watcher/negotiator runtime is postponed) |
| `bin/` | Executable entry points (teamem-call, teamem-flag, teamem-monitor) — see `bin/AGENTS.md` |
| `commands/` | Slash command markdown files for non-claim user workflows; claim lifecycle is MCP/hook-driven |
| `git-hooks/` | Git hooks for claim lifecycle (post-commit, post-checkout) — see `git-hooks/AGENTS.md` |
| `hooks/` | Claude hook configuration and dispatch — see `hooks/AGENTS.md` |
| `lib/` | Prebuilt JavaScript bundles (bridge.js, channel.js, setup.js) — see `lib/AGENTS.md` |
| `monitors/` | Monitor configuration and launch scripts — see `monitors/AGENTS.md` |
| `scripts/` | Bash runtime utilities (gate-claim.sh, release-claims.sh, session-start.sh, _common.sh) — see `scripts/AGENTS.md` |
| `skills/` | Teamem-specific skills (handoff, onboarding) — see `skills/AGENTS.md` |

## For AI Agents

### Working In This Directory

- **Bundled artifact model**: The plugin ships as a single marketplace install. All runtime logic lives in committed `.js` bundles. Source code for these bundles lives in `src/` at the project root; for bundle-source changes, rebuild with `bun run build:plugin`.
- **Plugin version**: Bump the version in `plugin/.claude-plugin/plugin.json` before each plugin iteration and mirror the same version in the root `.claude-plugin/marketplace.json`. Plugin command, hook, script, manifest, skill, agent, monitor, or bundled-runtime changes need this bump so Claude Code marketplace/cache consumers see the update.
- **Marketplace version gate**: If a change must reach users through `teamem update`, `teamem claude install/status/uninstall`, or `claude plugin update teamem@teamem-alpha`, verify both manifests were bumped before committing.
- **Cache integrity**: Claude Code validates `~/.claude/plugins/cache/...` — never edit cache files directly. Always: change source → bump version in `plugin.json` → clear cache (`rm -rf ~/.claude/plugins/cache/<plugin>`) → reinstall.
- **Marketplace trust**: The plugin is self-contained. All dependencies (Bun, Node, MCP SDK) are resolved at plugin execution time, not installation time. Hooks assume Bun is available; they exit gracefully if not.
- **Channels local-dev startup**: `--plugin-dir` loads commands/agents, but a development channel still needs the `--dangerously-load-development-channels server:teamem-channel` flag and a real `.mcp.json` `teamem-channel` entry in the launching repo. Placeholder paths such as `/path/to/teamem/plugin/lib/channel.js` make `/mcp` show the server as failed.
- **Plugin data slug drift**: Local plugin development commonly writes under `~/.claude/plugins/data/teamem-inline`, not `teamem`. Human runbooks should use `find ~/.claude/plugins/data -path '*teamem*' ...` for logs instead of hardcoding one slug.
- **Two-persona local E2E**: Distinct computers should use the normal default `~/.teamem/credentials.json` on each machine. Only when simulating Alice and Bob on one machine, avoid overwriting the default file back and forth by launching each Claude Code session with a distinct `TEAMEM_CREDENTIALS` path (for example `/tmp/teamem-alice.credentials.json` and `/tmp/teamem-bob.credentials.json`).
- **Fresh local reset**: A fresh DB is not enough for end-to-end retests. Also clear persona credentials and plugin session state (`~/.teamem/credentials.json`, any `TEAMEM_CREDENTIALS` files, `~/.claude/plugins/data/teamem*`, and repo-local `TEAMEM.md`) or Claude Code may keep authenticating against an old space.
- **npm bootstrapper boundary**: The npm `teamem` CLI in `packages/bootstrapper-cli` installs/updates this marketplace plugin and delegates setup here. Do not move MCP JSON writing into the bootstrapper; this plugin remains the MCP manifest owner.
- **Teamem-aware launcher transition**: `teamem cc` remains compatibility-only and exits non-zero with migration guidance. The installed Teamem-owned `claude` shim owns prompt/pure-vs-Teamem launch selection, readiness checks, plugin-owned activation intent/default Space behavior, and reversible cleanup. Do not re-teach the old `teamem cc` development-channel launch path here.
- **Marketplace repo name**: Bootstrapper defaults must point at `https://github.com/RubiYH/teamem`, not the old `teamem-poc` repo name.

### Common Patterns

- **Hook dispatch** (`hooks/hooks.json`): Maps Claude events (SessionStart, PreToolUse, etc.) to bash scripts or agent subagents. Bash hooks must use `bash "$CLAUDE_PLUGIN_ROOT"/scripts/X.sh` (shebang exec fails silently in Claude Code).
- **Bridge entry point** (`bin/teamem-call`): Thin wrapper that resolves `${CLAUDE_PLUGIN_ROOT}` and runs `bun run ${PLUGIN_ROOT}/lib/bridge.js call <tool> [args]`. Used by slash commands that need synchronous MCP tool invocation.
- **Plugin root resolution**: Scripts resolve plugin root via `${CLAUDE_PLUGIN_ROOT}` (set by Claude Code) or fallback to relative path. Template substitution `__TEAMEM_PLUGIN_ROOT__` is resolved by the installer for git hooks.
- **Claim lifecycle hooks**: `PreToolUse` calls `gate-claim.sh` (claim/refresh scope before file edits); `Stop` calls `release-claims.sh` for telemetry only (claims survive session end); `SessionStart` calls `session-start.sh` (stdout briefing prompt injection on startup/resume, Space Rules sync, decision/gotcha replay, durable notifications). The hook prompt is only an instruction for the main agent to perform the actual `get_briefing` read.
- **Claim cleanup boundary**: Claim cleanup is MCP/hook-driven, not a human slash-command surface. Agents may use `teamem.list_claims` and `teamem.force_release`; do not add `/teamem-claims` or `/teamem-force-release` command files without an explicit product decision.
- **Slash command format**: Each `.md` file in `commands/` is a complete command. Frontmatter includes `description`, `allowed-tools`, and `argument-hint`. Steps follow imperative logic (parse args, validate, call tools, format response).
- **Command component hygiene**: Do not put `AGENTS.md` or other non-command markdown files directly in `commands/`; Claude plugin validation treats every markdown file there as a command component. Keep command guidance in this file.
- **Subagent prompt format**: Each `.md` file in `agents/` is a complete Claude prompt (not a skill). Do not put `AGENTS.md` or other non-agent markdown files directly in `agents/`; Claude plugin validation treats every markdown file there as an agent component.
- **Channels proof points**: For channel smoke tests, `channel.log` plus `notifications.log` prove the plugin polled and emitted. They do not prove Claude Code rendered the event; `/mcp`, startup flags, org policy, and Claude debug logs own that layer.
- **Space Rules replica**: `TEAMEM.md` is the user-visible local replica and is gitignored. It should be created/rewritten only through `/teamem-rule init`, `/teamem-rule update`, and the `SessionStart` managed-block sync; do not document `snapshot.json` as a required user artifact.

### Pre-Commit Checklist

- For plugin manifest, command, monitor, hook, script, or runtime behavior changes, confirm whether marketplace users need a new plugin artifact. If yes, bump the mirrored plugin and marketplace versions in the same commit.
- For changes under `src/bridge/`, `src/channel/`, or `src/cli/setup.ts`, run `bun run build:plugin` and commit the regenerated `plugin/lib/*.js` bundles.
- For plugin activation, hook, monitor, or delivery behavior, run the relevant focused `tests/plugin/*.test.ts` files plus `bun run typecheck`; use `bun run lint` when TypeScript, test, or docs lint coverage is touched.
- Before committing, check that the installed Claude cache is not being edited directly and that the staged diff contains source/plugin files, not `~/.claude/plugins/cache/...` artifacts.

## Dependencies

### Internal

- `src/bridge/index.ts` → builds to `lib/bridge.js` (MCP tool bindings, stdio server)
- `src/cli/setup.ts` → builds to `lib/setup.js` (interactive setup wizard)
- `src/channel/index.ts` → builds to `lib/channel.js` via `bun run build:channel` or `bun run build:plugin` (Channels POC runtime)
- Project root `.omc/issues/` (PRDs, ADRs, acceptance slices)
- `src/domain/claim-identity-core.ts` (canonical repo_id canonicalization — must stay in lockstep with bash equivalents in `git-hooks/` and `scripts/`)
- `src/domain/git-evidence.ts` (SHA validation, git release evaluation)

### External

- `@modelcontextprotocol/sdk` ^1.0 (MCP stdio server)
- `hono` ^4.6 (HTTP client in bridge for server calls)
- `zod` ^3.23 (input validation in bridge tool bindings)
- `bun` (runtime for bundles; Claude Code assumes Bun is available on user's machine)

<!-- MANUAL: -->
