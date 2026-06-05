<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-09 | Updated: 2026-06-02 -->

# plugin

## Purpose

Claude Code plugin tests that verify the integration between the bridge, git hooks, slash commands, live Claude plugin loading, copied demo workspaces, and the HTTP server. Tests here exercise the plugin's CLI interfaces, gate-claim logic, post-commit/post-checkout hooks, runtime/headless/interactive live smokes, multi-profile coordination, and the current discussion/deferred-dispute behavior.

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
| `teamem-live-smoke-helpers.ts` | Shared live smoke gates, Teamem runtime preflight, MCP env passthrough, and single-host interactive lock |
| `teamem-demo-repository-workspace.ts` | Copies `tests/fixtures/demo-repository-template/` into a safe temp git workspace for live smokes |
| `teamem-interactive-readiness.ts` | Claude TTY readiness and startup-safety prompt handling for interactive smokes |
| `teamem-runtime-*-smoke.test.ts` | L3 runtime/headless live smokes through real plugin MCP evidence |
| `teamem-interactive-*-smoke.test.ts` | L4 interactive live smokes through real Claude TTY, hook traces, and runtime evidence |
| `teamem-multi-profile-*.ts` | L5 Alice/Bob profile isolation and multi-profile live smoke coverage |
| `teamem-channels-session-planner.ts` | L5 Channels gate, profile, launch-parity, split-case, and readiness planning helpers |
| `teamem-channels-evidence.ts` | L5 Channels evidence assertions for channel MCP traces, recipient notification logs, rendered channel-source transcript evidence, and negative recipients |
| `teamem-channels-direct-smoke.test.ts` | Opt-in L5 live Channels smoke covering direct, `*`, and `**` discussion delivery with Alice/Bob/Carol sessions |
| `teamem-channels-claim-conflict-smoke.test.ts` | Opt-in L5 live Channels smoke proving normal file-claim conflicts stay queue-first and Channel-quiet |
| `teamem-channels-knowledge-smoke.test.ts` | Opt-in L5 live Channels smoke covering real decision and gotcha slash-command delivery to passive recipients without Alice echo |
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
- Live Teamem plugin smokes are opt-in and should skip cleanly unless their env gates are set. L3 runtime/headless tests use `TEAMEM_CLAUDE_PLUGIN_E2E`; stateful flows also use `TEAMEM_CLAUDE_PLUGIN_STATEFUL_E2E`; L4 interactive flows add `TEAMEM_CLAUDE_PLUGIN_INTERACTIVE_E2E`; L5 multi-profile flows add `TEAMEM_CLAUDE_PLUGIN_MULTI_PROFILE_E2E`.
- Use `TEAMEM_MCP_INSTRUMENTATION_OPTIONS` from `teamem-live-smoke-helpers.ts` for live Teamem smokes so Teamem credential/Space env reaches proxied MCP children without hardcoding those keys into `plugin-e2e-module/`.
- Live interactive smokes should run under `withLiveInteractiveSmokeLock(...)` when they share local Claude/plugin/runtime state. Preserve failed artifacts and copied demo workspaces; cleanup only after success.
- Live smokes should launch against a copied demo workspace from `tests/fixtures/demo-repository-template/`, never the Teamem source checkout. Report preserved workspace/artifact paths in failures.
- Treat MCP traces, hook traces, runtime tool reads, and copied-workspace file state as proof. Do not treat assistant prose alone as proof that a Teamem command, claim, handoff, or Space Rules sync happened.
- Scope-claim conflict smokes must use neutral fixture markers and require edit-like `PreToolUse` denial evidence (`Edit`, `Write`, or `MultiEdit`) with incumbent claim/principal metadata. Do not let the prompt itself tell Bob to stop before the hook runs.
- Multi-profile L5 tests must keep Alice/Bob profile credentials, plugin data, transcripts, MCP traces, hook traces, and runtime evidence separate. Use `teamem dev claude --profile <name> --dry-run` planning through `teamem-multi-profile-coordinator.ts`; do not overwrite the developer's default `~/.teamem/credentials.json`.
- L5 Channels tests add Carol to the multi-profile set. Every live Channels run
  requires Alice, Bob, and Carol developer-owned profile credentials, with Carol
  resolved from `TEAMEM_CAROL_PROFILE` or the default `carol` profile.
- L5 Channels scenarios are exact and intentionally split. Direct discussion
  smokes cover direct to Bob, `*` no-Sprint Space broadcast, and `**` explicit
  Space-wide broadcast. In this no-Sprint setup both broadcast forms must
  deliver Space-wide to Bob and Carol, while Alice receives no sender echo.
- L5 Channels knowledge smokes prove Alice's real decision and gotcha slash
  commands are recorded through MCP/runtime evidence and rendered to passive Bob
  and Carol through Channels, while Alice receives no sender echo.
- L5 Channels quiet conflict smokes prove normal Space-mode file-claim conflicts
  remain queue-first through hook/runtime evidence and do not create Channel
  alerts or permission-request regressions.
- Every L5 Channels split case launches fresh Alice, Bob, and Carol Claude Code
  sessions. Workspace/artifact reuse is an explicit local/debug option only and
  must keep unique markers plus timing or offset filters so old evidence cannot
  satisfy a later case.
- Keep Channels evidence layers separate. Channel MCP trace evidence means a
  proxied `notifications/claude/channel` message; recipient notification log
  evidence means the exact Teamem envelope in the recipient log; rendered TTY
  evidence means a post-checkpoint raw or normalized `teamem-channel` peer-event
  source line. Claude's compact UI may elide the marker from the rendered line,
  so exact marker identity belongs to transport/log evidence; durable
  `read_thread` visibility is fallback/runtime history coverage; assistant
  prose is diagnostic only; screenshot, pixel, and terminal cell-grid evidence
  are unsupported for this slice.
- Negative sender checks must allow Alice's own slash-command input echo,
  including Claude TTY line wrapping of the body marker, while still rejecting
  any post-checkpoint Channel transport, notification log, or rendered
  `teamem-channel` peer-event evidence for Alice.
- Teamem Channels semantics belong here, not in `plugin-e2e-module/`. The module
  owns generic `channels` / `developmentChannels` launch mechanics and raw
  artifact capture; these tests own Teamem principals, Space rules, readiness,
  delivery matrices, notification envelope interpretation, and render-layer
  failure messages.
- L5 Teamem Channels launch the local `server:teamem-channel` source with
  `developmentChannels` /
  `--dangerously-load-development-channels server:teamem-channel`. During the
  Claude Code Channels research preview, do not also pass `channels` /
  `--channels server:teamem-channel` for this local source path; the development
  flag is the load/activation path for non-allowlisted local servers.

### Testing Requirements

- **Bundle freshness** (bundle-freshness.test.ts) must run after any change to `src/bridge/`, `src/cli/setup.ts`, or `src/channel/` — the test fails if committed bundles are stale.
- All slash command tests must verify command output (stdout parsing) matches expected format.
- Tests that invoke git hooks (`post-checkout`, `post-commit`) must set up a real git repo with HEAD state.
- CLI fallback tests ("no-source-tree" variants) verify the bridge can run in stdio fallback mode without accessing `plugin/` directory.
- SessionStart tests must ensure decisions and gotcha notices come from `teamem.session_sync`, while durable unread notifications remain in `fetchUnreadNotifications`. Gotchas must not be surfaced twice.
- Teamem rule tests must include hostile labels/names that could break HTML comments (`--`, `<`, `>`) because `TEAMEM.md` metadata is stored in a comment.
- Demo workspace tests must verify deterministic git history, safe deletion markers, and hostile caller git config isolation. The helper must not honor caller hooks, GPG signing, or `GIT_DIR`/`GIT_WORK_TREE`.
- Live smoke gates should be verified both ways: unset env produces skips in `bun test`, while the explicit live commands prove the real Claude/plugin path when credentials and auth are available.
- L5 Channels gates should be verified both ways. Normal runs skip unless the
  Channels gate and every lower live gate are set. When
  `TEAMEM_CLAUDE_PLUGIN_CHANNELS_E2E=1` is enabled, missing Claude auth or
  missing Alice/Bob/Carol credentials are hard failures after prerequisite
  checks.

### Common Patterns

- **Build verification**: `spawnSync('bun', ['build', src, '--outfile', tmpOut, '--target', 'bun', '--external', 'bun:sqlite'])` then compare temp output to committed bundle byte-by-byte.
- **Git hook setup**: `spawnSync('git', ['init'], { cwd })` then `spawnSync('bash', [...], { cwd })` to invoke hook scripts.
- **CLI invocation**: `spawnSync('bun', ['run', 'dist/bridge.js', 'call', toolName, '--repo-id', repoId, ...])` for fallback mode.
- **Output parsing**: capture `stdout`, split lines, find patterns (e.g., regex for claim info) to verify UX format.
- **Marketplace mocking**: `setupMarketplaceEnv({ space_id, jwt, ... })` to set environment variables that simulate Claude Code plugin context.
- **Credential cleanup in E2E-like tests**: If a test uses `TEAMEM_CREDENTIALS`, create a temp file and delete it. Never rely on the developer's real `~/.teamem/credentials.json`.
- **Live L3/L4 command shape**: run the runtime/headless/interactive smoke files with `TEAMEM_CLAUDE_PLUGIN_E2E=1`, `TEAMEM_CLAUDE_PLUGIN_INTERACTIVE_E2E=1`, `TEAMEM_CLAUDE_PLUGIN_STATEFUL_E2E=1`, and `CLAUDE_PLUGIN_E2E_ALLOW_UNREDACTED=1` when artifact contents are needed for diagnosis.
- **Live L5 command shape**: run `tests/plugin/teamem-multi-profile-*.test.ts` with the L3/L4 env plus `TEAMEM_CLAUDE_PLUGIN_MULTI_PROFILE_E2E=1`. A split rerun of one failed L5 file is acceptable for debugging, but before release prefer one continuous six-stream L5 run when time allows.
- **Live L5 Channels command shape**: run the focused live Channels smoke with
  all L3/L4 gates, `TEAMEM_CLAUDE_PLUGIN_MULTI_PROFILE_E2E=1`,
  `TEAMEM_CLAUDE_PLUGIN_CHANNELS_E2E=1`, profile credentials for Alice/Bob/Carol
  including Carol from `TEAMEM_CAROL_PROFILE` or `carol`, and
  `CLAUDE_PLUGIN_E2E_ALLOW_UNREDACTED=1` because channel assertions inspect
  unredacted post-message response artifacts:

```bash
TEAMEM_CLAUDE_PLUGIN_E2E=1 TEAMEM_CLAUDE_PLUGIN_INTERACTIVE_E2E=1 TEAMEM_CLAUDE_PLUGIN_STATEFUL_E2E=1 TEAMEM_CLAUDE_PLUGIN_MULTI_PROFILE_E2E=1 TEAMEM_CLAUDE_PLUGIN_CHANNELS_E2E=1 CLAUDE_PLUGIN_E2E_ALLOW_UNREDACTED=1 bun test tests/plugin/teamem-channels-direct-smoke.test.ts
```

- **L5 Channels focused verification**: run
  `bun test tests/plugin/teamem-channels-session-planner.test.ts tests/plugin/teamem-channels-evidence.test.ts`
  for helper coverage, run
  `bun test plugin-e2e-module/tests/interactive-pty.test.ts plugin-e2e-module/tests/mcp-instrumentation.test.ts`
  when generic Channel launch or MCP notification capture changes, and run
  `bun test tests/plugin/bundle-freshness.test.ts` plus `bun run build:plugin`
  when `src/channel/`, `src/bridge/`, `src/cli/setup.ts`, or committed
  `plugin/lib/` bundle inputs change.

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
