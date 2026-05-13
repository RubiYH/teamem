<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-09 | Updated: 2026-05-10 -->

# plugin

## Purpose

Claude Code plugin tests that verify the integration between the bridge, git hooks, slash commands, and the HTTP server. Tests here exercise the plugin's CLI interfaces, gate-claim logic, post-commit/post-checkout hooks, and the current discussion/deferred-dispute behavior.

## Key Files

| File | Description |
|------|-------------|
| `bundle-freshness.test.ts` | AC-18 — verifies plugin bundles (`plugin/lib/{bridge,setup,channel}.js`) are byte-equivalent to freshly built sources; fails if `bun build` output doesn't match committed bundles |
| `gate-claim-git-state.test.ts` | `gate-claim.sh` logic when git state is dirty, working tree uncommitted, or HEAD unchanged |
| `gate-claim-branch.test.ts` | Claim lifecycle across branch switch (acquire on one branch, check behavior on another) |
| `gate-claim-auto-discuss.test.ts` | Auto-discuss compatibility path — stale `auto-discuss` prefs degrade to queued work instead of opening disputes |
| `gate-claim-auto-discuss-marketplace.test.ts` | Same as above but with marketplace plugin environment |
| `gate-claim-multi-space.test.ts` | Claiming same path in two different spaces; verify claims are isolated |
| `gate-claim-space-switch.test.ts` | Switch between two spaces and verify claims pause/resume correctly |
| `gate-claim-warn.test.ts` | Conflict warning display when attempting to claim over an incumbent claim |
| `post-checkout-pause-resume.test.ts` | `post-checkout` hook pauses claims when switching away from a branch, resumes when switching back |
| `post-commit-release.test.ts` | `post-commit` hook releases claims whose commit SHAs validate via `evaluateRelease` |
| `release-claims-stop-noop.test.ts` | Releasing already-released claims is idempotent; no side effects |
| `session-start-unread-notifications.test.ts` | `fetchUnreadNotifications()` on session start; notifications queued while offline |
| `teamem-rule-init.test.ts` | `/teamem-rule init` managed TEAMEM.md creation/refresh and metadata safety |
| `teamem-rule-update.test.ts` | `/teamem-rule update` publish + rewrite from server snapshot |
| `install-flow.test.ts` | `install-git-hooks` command — creates/updates `.git/hooks/` with teamem-managed hooks |
| `install-flow.test.ts` | Git hooks installed with `# teamem-managed-hook` marker; backup on first install, abort if incumbent non-teamem |
| `teamem-call-no-source-tree.test.ts` | CLI fallback (no source tree) — `bun run dist/bridge.js call <tool>` invocation |
| `teamem-monitor-label-default.test.ts` | `/teamem-monitor` with default label (space label from env or interactive prompt) |
| `teamem-monitor-session-pin.test.ts` | `/teamem-monitor --pin` pins the space to the current Claude Code session |
| `teamem-monitor-no-source-tree.test.ts` | `/teamem-monitor` CLI fallback (no source tree) |
| `teamem-flag-no-shasum.test.ts` | `/teamem-flag` without shasum falls back to env var or prompts |
| `teamem-discuss-agent.test.ts` | Direct discuss command contract plus absence of postponed negotiator routing |
| `teamem-setup-no-source-tree.test.ts` | `/teamem-setup` CLI fallback (no source tree) |
| `teamem-space-no-source-tree.test.ts` | `/teamem-space` CLI fallback (no source tree) |
| `teamem-onboarding-no-source-tree.test.ts` | `/teamem-onboarding` CLI fallback (no source tree) |
| `dispute-end-to-end.test.ts` | Deferred dispute runtime boundaries — no Notification agents, monitor classification still matches server events |

## For AI Agents

### Working In This Directory

- Plugin tests are integration-level; they interact with file system (credentials, git hooks), HTTP (bridge + server), and in-memory SQLite.
- Use `spawnSync()` to invoke CLI commands (e.g., `bun run teamem ...`, `bun build ...`, `bash scripts/gate-claim.sh`).
- For tests that verify bundle freshness, spawn `bun build` in a temp directory, then byte-compare against committed `plugin/lib/` files.
- Marketplace-env tests use `setupMarketplaceEnv()` to mock `~/.claude/plugins/data/` structure.

### Testing Requirements

- **Bundle freshness** (bundle-freshness.test.ts) must run after any change to `src/bridge/`, `src/cli/setup.ts`, or `src/channel/` — the test fails if committed bundles are stale.
- All slash command tests must verify command output (stdout parsing) matches expected format.
- Tests that invoke git hooks (`post-checkout`, `post-commit`) must set up a real git repo with HEAD state.
- CLI fallback tests ("no-source-tree" variants) verify the bridge can run in stdio fallback mode without accessing `plugin/` directory.
- SessionStart tests must ensure decisions and gotcha notices come from `teamem.session_sync`, while durable unread notifications remain in `fetchUnreadNotifications`. Gotchas must not be surfaced twice.
- Teamem rule tests must include hostile labels/names that could break HTML comments (`--`, `<`, `>`) because `TEAMEM.md` metadata is stored in a comment.

### Common Patterns

- **Build verification**: `spawnSync('bun', ['build', src, '--outfile', tmpOut, '--target', 'bun', '--external', 'bun:sqlite'])` then compare temp output to committed bundle byte-by-byte.
- **Git hook setup**: `spawnSync('git', ['init'], { cwd })` then `spawnSync('bash', [...], { cwd })` to invoke hook scripts.
- **CLI invocation**: `spawnSync('bun', ['run', 'dist/bridge.js', 'call', toolName, '--repo-id', repoId, ...])` for fallback mode.
- **Output parsing**: capture `stdout`, split lines, find patterns (e.g., regex for claim info) to verify UX format.
- **Marketplace mocking**: `setupMarketplaceEnv({ space_id, jwt, ... })` to set environment variables that simulate Claude Code plugin context.
- **Credential cleanup in E2E-like tests**: If a test uses `TEAMEM_CREDENTIALS`, create a temp file and delete it. Never rely on the developer's real `~/.teamem/credentials.json`.

## Dependencies

### Internal

- `src/bridge/` — stdio MCP bridge implementation and tool bindings
- `src/cli/setup.ts` — setup CLI implementation
- `src/channel/` — channel runtime and payload handling
- `plugin/lib/{bridge,setup,channel}.js` — committed bundles (freshness test compares against these)
- `plugin/scripts/gate-claim.sh` — gate claim shell script (invoked in tests)
- `plugin/git-hooks/post-checkout`, `plugin/git-hooks/post-commit` — git hook scripts
- `plugin/commands/teamem-*.md` — slash command definitions
- `tests/helpers/migrations.js`, `tests/helpers/auth.js` — database and auth setup
- `tests/helpers/marketplace-env.ts` — marketplace environment simulation

### External

- `bun:test` — test runner
- `node:child_process` — `spawnSync` for CLI and git invocation
- `node:fs` — file operations (temp directories, reading bundles)
- `node:path` — path utilities
- `git` binary — git commands (init, config, etc.)

<!-- MANUAL: -->
