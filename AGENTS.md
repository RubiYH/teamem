<!-- Generated: 2026-05-01 | Updated: 2026-05-13 -->

# teamem

## Purpose

Teamem is an MCP-based team memory and coordination server for human developers and their Claude Code agents. It helps teammates share the team's current plan, claimed scopes, architectural decisions, active risks, and recent progress before agents make changes in the same repository.

**Architecture (v5, 2026-05-01):** Shared HTTPS server (Bun + Hono + SQLite) + per-teammate local stdio MCP bridge (`src/bridge/`). The bridge translates registered `teamem.*` tool calls into authenticated HTTPS POSTs to the server. Public docs live under `docs/`; internal plans and ADRs live under `.docs/`.

**Primary read tool:** `teamem.get_briefing` — returns a five-dimension briefing (`current_plan`, `active_claims`, `recent_decisions`, `active_risks`, `recent_progress`). Use it at session start/resume, after explicit human requests, or when the agent needs a fresh whole-team context refresh. Do not call the full briefing before every edit; edit-time coordination is handled by claim and conflict tools.

See `.docs/integrations/agent-prompt-snippet.md` for the internal system-prompt snippet to paste into your `AGENTS.md` or `CLAUDE.md`.

## Key Files

| File                  | Description                                                                        |
| --------------------- | ---------------------------------------------------------------------------------- |
| `package.json`        | Bun scripts (`build`, `build:plugin`, `bridge`, `channel`, `server`, `setup`, `teamem`, `test`, `lint`, `typecheck`) |
| `tsconfig.json`       | TS strict, ES2022, NodeNext, `src` → `dist`                                        |
| `eslint.config.js`    | Flat config, `@typescript-eslint`, project-aware parser                            |
| `Dockerfile`          | Multi-stage alpine build: `oven/bun:1.2.14-alpine`; `CMD ["bun","run","dist/server.js"]` |
| `docker-compose.yml`  | Exposes `$PORT`, reads `.env`, named volume for SQLite data                        |
| `.env.example`        | Template for `TEAMEM_*` env vars                                                   |
| `.gitignore`          | Excludes `node_modules`, `.env`, `dist`, `.omc/`, `.omx/`, `.scratch/`, generated data |

## Subdirectories

| Directory  | Purpose                                                                |
| ---------- | ---------------------------------------------------------------------- |
| `src/`           | Runtime source code — see `src/AGENTS.md`                                                          |
| `plugin/`        | Claude Code marketplace plugin distribution — see `plugin/AGENTS.md`                               |
| `packages/`      | Publishable npm-side tooling, currently the `teamem` bootstrapper CLI — see `packages/bootstrapper-cli/AGENTS.md` |
| `tests/`         | Unit, integration, scenario, e2e, perf, plugin, migration, security suites — see `tests/AGENTS.md`  |
| `docs/`          | Curated public-facing docs for GitHub/npm users                                                     |
| `.docs/`         | Internal architecture notes, ADRs, plans, operations notes, and subplans                            |
| `hooks/`         | Local hook experiments and Claude hook references                                                   |
| `data/`          | Local SQLite/runtime data; do not commit generated databases unless explicitly requested             |
| `.github/`       | CI workflows (read-restricted in this environment)                                                  |
| `.omc/`, `.omx/` | local planning/session state (gitignored)                                                           |

## For AI Agents

### Working In This Directory

- The runtime targets **Bun** (the SQLite client imports `bun:sqlite`). Tests, builds, and the Docker entrypoint all assume Bun. Plain Node will fail at the `bun:sqlite` import.
- `package.json` lists Bun scripts (`build`, `build:bridge`, `build:channel`, `build:plugin`, `bridge`, `channel`, `server`, `setup`, `reset`, `teamem`, `test`, `lint`, `format`, `format:check`, `typecheck`) — invoke with `bun run <script>`.
- ESM throughout: imports MUST use the `.js` extension on local relative paths even when the source is `.ts` (NodeNext resolution).
- Code style is enforced by Prettier; run `bun run format` before committing.

### Testing Requirements

- `bun test` runs unit + integration + scenario + perf suites together.
- Add new tests under the matching `tests/{unit,integration,scenario,perf}/` subtree.
- Database-backed tests use `:memory:` SQLite and apply `src/infra/db/migrations/001_init.sql` (and optionally `002_decisions_kind_and_indexes.sql`) per test.
- Perf benches live in `tests/perf/` and assert p50 latency budgets — see `tests/perf/*.bench.ts`.

### Commit Checklist

- Before committing, run `git status --short`, inspect staged and unstaged diffs, and review recent commit style. Stage only files that belong to the requested change; leave unrelated user or generated changes alone.
- Verify with the smallest meaningful gate for the touched surface before commit. Use targeted tests for narrow changes, then `bun run typecheck`, `bun run lint`, `bun run build:plugin`, or the full `bun test` gate when the touched code requires it.
- If a CLI/operator-facing change triggers a document-refresh warning, refresh the relevant docs or explicitly record why no refresh is needed.
- Commit messages must use the Lore protocol and a conventional subject line such as `fix(cli): make uninstall finish cleanup`: an intent line first, then relevant trailers such as `Constraint:`, `Rejected:`, `Confidence:`, `Scope-risk:`, `Directive:`, `Tested:`, and `Not-tested:`. Include known verification gaps explicitly.
- Every agent-authored commit must include `Co-authored-by: OmX <omx@oh-my-codex.dev>`.
- Use inline `git commit -m ...` message arguments so local hooks can inspect the message before commit execution. Do not use `--no-verify`, do not push unless explicitly requested, and do not amend an existing commit unless the user asks for an amend.

### Common Patterns

- **Event sourcing**: state changes go through `validateEvent` → `SqliteEventStore.append` → `applyProjectionUpdate`.
- **Tool factory**: `createTeamemTools({ db, store })` returns the tool object; `createToolRegistry(tools)` maps to MCP tool names.
- **Briefing**: `buildBriefing(db, { repo_id, principal, token_budget? })` returns the five-dimension `BriefingResponse`. This is the primary read path — prefer it over `getUpdates` for agent context injection.
- **Bridge**: `src/bridge/index.ts` is the stdio MCP entry point. It also supports `bun run dist/bridge.js call <tool> [--space X] --json '{...}'` CLI fallback mode (see `.docs/integrations/cli-fallback.md`).
- **Hook adapters**: `createClaudeHookAdapter(tools)` closes over a `DeferredQueue` for retry-on-failure semantics.
- **Conflict policy**: `evaluateConflict(signal, weights)` is pure and deterministic — env-driven weight overrides flow through `loadConflictWeights()`.

## Dependencies

### External

- `typescript` ^5.9 — strict mode, NodeNext modules
- `bun:test` — test runner; all test files use `from 'bun:test'`
- `eslint` ^9 + `@typescript-eslint/*` ^8 — flat config
- `prettier` ^3.8
- `bun:sqlite` (runtime, via Bun) — embedded SQLite driver
- `hono` ^4.6 — HTTP server framework
- `@modelcontextprotocol/sdk` ^1.0.4 — MCP stdio server (bridge)
- `ulidx` ^2.3 — ULID generation for event/claim IDs
- `zod` ^3.23 — input validation in bridge tool bindings

### Internal Architecture (top-level)

- `src/domain/` (events + conflicts, pure logic, no I/O)
- `src/infra/` (SQLite store + projections, side-effecting)
- `src/server/` (MCP tool surface that ties domain + infra together)
- `src/hooks/` (Claude lifecycle wrappers around tools)

<!-- MANUAL: Custom project notes can be added below -->

---

## npm bootstrapper CLI (2026-05-13)

`packages/bootstrapper-cli` is the publishable npm package named `@rubiyh05/teamem`. Its purpose is to make `npm install -g @rubiyh05/teamem` usable as a bootstrapper for Claude Code marketplace onboarding, not to replace the plugin runtime. The installed binary command remains `teamem`.

### Contracts new agents MUST respect

1. **Plugin owns MCP JSON** — `teamem init` does not write Claude MCP JSON. Installing the Claude Code plugin is the MCP installation surface; keep MCP server declarations in the plugin manifest/files.

2. **Bootstrapper diagnoses prerequisites** — prerequisites such as Claude Code, Bun, Git, and repo context are checked and reported, but the npm CLI should not become a full prerequisite installer. The intended exception is Teamem source/plugin availability: `teamem init` may add/update the Teamem marketplace and install the Teamem plugin before delegating to setup.

3. **Marketplace identifiers are pinned** — marketplace source is `https://github.com/RubiYH/teamem`, marketplace name/channel is `teamem-alpha`, and plugin install/update target is `teamem@teamem-alpha`. Do not drift back to `teamem-poc` in bootstrapper defaults.

4. **Claude plugin listing has a central parser** — use `claude plugin list --json` through the bootstrapper parser. Avoid ad hoc text parsing and avoid scoped list probes that Claude Code does not support.

5. **Development channel launch is intentional** — `teamem cc` launches Claude Code with `--dangerously-load-development-channels plugin:teamem@teamem-alpha`. The flag name is scary but required for Teamem's marketplace development channel flow. Do not swap this to `--plugin-dir` unless you re-verify channel behavior, MCP visibility, and marketplace data paths end to end.

6. **Scope memory is explicit** — remember the selected plugin scope in `.teamem/bootstrapper.json` and prefer it for `teamem update` / `teamem cc`, while still allowing `--scope project|user|local` overrides.

7. **Git hooks are installed after setup** — `teamem init` first ensures marketplace/plugin availability, then runs the same create/join setup surface as `src/cli/setup.ts`, then optionally installs Teamem git hooks into the current repo. The hook prompt must work from an npm-installed binary.

8. **Uninstall is a first-class cleanup path** — `teamem uninstall` should remove Teamem-managed Claude plugin state, marketplace registration, git hooks, bootstrapper scope memory, local run/cache state, and credentials unless `--keep-credentials` is set. Cleanup should continue after non-fatal Claude plugin command failures so local state is still removed.

### Gotchas grounded in the bootstrapper session

- **npm bin runtime must be Bun**: the published `teamem` bin intentionally uses `#!/usr/bin/env bun`. Interactive prompts rely on Bun's `globalThis.prompt`; a Node-launched binary can fail in raw stdin paths with `EAGAIN` on macOS.

- **Do not replace every `node:*` import with Bun APIs**: the good deal was replacing fragile raw prompt reads and pinning the bin runtime to Bun. Keep `node:path`, most `node:fs`, and synchronous child-process plumbing unless there is a concrete failure or simplification. This package is a Bun-hosted TypeScript CLI, not a "no Node stdlib" codebase.

- **Interactive prompt wrapper is the seam**: use `runtime-prompt.ts` for scope selection, `teamem cc` update prompts, and git hook prompts. Tests should inject prompt functions instead of stubbing stdin.

- **Real smoke requires PATH discipline**: npm global-prefix smoke installs may put `teamem` under a temp prefix. When testing from scratch, either export that prefix's `bin` onto `PATH` or invoke the absolute installed binary; otherwise `zsh: command not found: teamem` is just a PATH miss.

- **Installed hook evidence is local repo state**: after `teamem init`, verify `.git/hooks/post-commit` and `.git/hooks/post-checkout` have `# teamem-managed-hook` and are executable. A first commit should not block even if Teamem release telemetry is unavailable.

### Standard bootstrapper gates

Run these before declaring bootstrapper changes complete:

```bash
cd packages/bootstrapper-cli
bun test ./tests
bun run typecheck
bun run build
```

For package/runtime changes, also run a packed install smoke with a temporary npm prefix and verify `teamem init --dry-run`, `teamem update --dry-run`, and `teamem cc --dry-run`.

For uninstall/reset changes, also verify `teamem uninstall --dry-run` and hook removal/restoration behavior with `core.hooksPath`.

---

## Space Memory v1 scopes (2026-05-10)

The Space Memory PRD splits team knowledge into bounded runtime scopes. Keep the surfaces distinct:

1. **Space Rules** — the only Space Memory content replicated into local `TEAMEM.md`. `TEAMEM.md` is a gitignored generated cache, not authority. Server state lives in SQLite; local state lives under `.teamem/` and is also gitignored.
2. **Gotchas** — persistent learnings built on the findings/gotcha substrate. Gotcha realtime delivery should be short notice + fetch-by-id, not full replay into `TEAMEM.md`.
3. **Decisions** — durable direction changes with amendment/supersession semantics. Decisions may be broadcast/replayed to agents, but do not belong in `TEAMEM.md`.
4. **Discuss** — persisted conversation/coordination threads. Direct-thread visibility and reply authority are policy/security boundaries, not local-file behavior.

### Space Rules contracts

- Current snapshot export tool: `teamem.export_space_rules_snapshot`.
- `/teamem-rule init` creates or refreshes `TEAMEM.md` from the active Space Rules snapshot.
- Managed markers are exact: `<!-- BEGIN TEAMEM SPACE RULES -->` and `<!-- END TEAMEM SPACE RULES -->`.
- Managed-block metadata must include `space_id`, `rules_version`, `rules_hash`, `generated_at`, and source event/snapshot fields.
- `rules_hash` is derived only from the canonical rendered rules body, excluding volatile metadata such as `generated_at`.
- Refresh code must replace only the managed block and preserve bytes outside it. Do not trim, format, or rewrite user-owned `TEAMEM.md` content outside the block.
- Metadata embedded in `TEAMEM.md` must be HTML-comment safe. Escape comment-breaking characters before writing metadata; do not embed raw user-controlled labels/names inside comments.
- Hard-wipe and disband-GC must delete `space_rules_snapshots`; soft-wipe should leave Space Rules durable.

### Implementation scope guardrails

- Issue 01 is snapshot export + `/teamem-rule init` only. Publishing (`/teamem-rule update`), SessionStart drift sync, Gotchas, Decisions, and Discuss authorization are separate follow-up scopes.
- Bridge `responseSchema` remains documentation-only; when snapshot fields change, update `src/bridge/tool-bindings.ts`, rebuilt `plugin/lib/{bridge,channel}.js`, and bridge/server contract tests together.
- The plugin command source of truth is `plugin/commands/teamem-rule.md`; the runtime script is `plugin/scripts/teamem-rule-init.sh`; the starter is `plugin/templates/TEAMEM.starter.md`.

---

## Claim-lifecycle v2 (2026-05-05)

PRD #27 + slices #28–#37 redesigned claim lifecycle around git evidence. ADR-0008 is the design contract; the **"Amendment 2026-05-05"** at the bottom records the §150 revert (on_commit `expires_at` reverted from "safety-net TTL" back to NULL). Operator-facing migration in `CHANGELOG.md`.

### Invariants new agents MUST respect

1. **Atomicity invariant** — every `event-emit + projection-update` pair MUST live inside the same `db.transaction(...).immediate()` block. Bare `.transaction()` is deferred and re-opens TOCTOU; `.immediate()` acquires SQLite RESERVED lock at txn start. The PRD calls this out explicitly. Tools using this pattern: `claimScope`, `releaseScope`, `releaseScopeViaGit`, `pauseClaimsForBranch`, `resumeClaimsForBranch`, `forceRelease`, `fetchUnreadNotifications`.

2. **PRD §150 — `expires_at` semantics** — NULL for `on_commit` and `manual_only`; only `ttl` mode sets it. `lease_seconds` is a `ttl`-only field — server rejects it on other modes with `INVALID_PAYLOAD`. The pre-amendment "safety-net TTL" pattern is forbidden; reverting to it would silently break paused-claim-survives-branch-switch UX.

3. **Canonical identity sources of truth** — `repo_id` canonicalization lives in `src/domain/claim-identity-core.ts:canonicalizeRepoId`. The bash equivalents in `plugin/scripts/gate-claim.sh`, `plugin/git-hooks/post-commit`, `plugin/git-hooks/post-checkout` MUST stay byte-equivalent (each carries a `MUST stay in lockstep with src/domain/claim-identity-core.ts` comment). Drift produces different `repo_id` between server and client → cross-machine claim invisibility.

4. **SHA validation** — `src/domain/git-evidence.ts:evaluateRelease` rejects non-`/^[0-9a-f]{40}$/` SHAs with `still_held` + `invalid_sha`. Don't accept arbitrary strings.

5. **Projection rebuild parity** — every event type with inline UPDATE in tools MUST also have a handler in `src/infra/projections/apply-event.ts`. `rebuildProjections` replays through there; missing handler = silent state corruption after a rebuild. Currently covered: `scope_claimed`, `scope_released`, `scope_released_via_git`, `claim_paused`, `claim_resumed`, `claim_force_released`, `claim_expired`.

6. **Bridge response schema is documentation-only** — `responseSchema` in `src/bridge/tool-bindings.ts` is NOT runtime-validated (only `inputSchema.parse()` runs). Drift here is invisible to the test suite. Treat it as a contract for downstream SDKs and keep it accurate. When tool input/output shapes change, update the schema by hand.

### Gotchas grounded in real bugs we hit

- **Truthiness checks on a once-always-truthy field**: `if (storedClaimId && storedExpiresAt)` worked while every claim had a TTL; the §150 revert made `expires_at` nullable for the dominant claim type and silently broke the fresh-after-release re-claim path. Lesson: when removing an "always-non-null" invariant, audit every truthiness check on that field across the codebase. Replace truthiness with structural lookups (e.g. `released_at IS NOT NULL`).

- **`claims.path` projection truncation**: `claims.path` stores `paths[0]` only (one row per claim, scope is in `scope_json`). Any WHERE clause filtering on `path = ?` will silently miss multi-path claims for `paths[1+]`. Use `EXISTS (SELECT 1 FROM json_each(json_extract(scope_json, '$.paths')) je WHERE je.value = ?)` for path-based lookups.

- **Cache eviction with NULL `expires_at`**: empty/NULL `expires_at` must sort to `Infinity` (no scheduled expiry = keep longest), not `0` (`Date.parse("") = NaN || 0` evicts on_commit FIRST). See `plugin/scripts/gate-claim.sh` cache reader (~line 242) and writer (~line 428).

- **Claude Code plugin cache integrity check**: NEVER edit `~/.claude/plugins/cache/...` directly — Claude Code rejects the plugin silently with no error. Always: bump version in `plugin/.claude-plugin/plugin.json` → wipe cache (`rm -rf ~/.claude/plugins/cache/<plugin>`) → reinstall.

- **Plugin manifest is fail-closed at file level**: one bad entry (e.g. unknown `channels` field, non-schema `userConfig` keys, malformed hook entry) silently disables ALL hooks for the plugin. When a hook stops firing, bisect by stripping `plugin/hooks/hooks.json` to a single hook + minimal manifest fields.

- **Hook command must use bash interpreter**: `command: "bash \"$CLAUDE_PLUGIN_ROOT\"/scripts/X.sh"`, NOT a bare `${CLAUDE_PLUGIN_ROOT}/scripts/X.sh` (shebang exec fails silently in Claude Code's hook runtime).

- **Marketplace install vs source-tree dev**: installed git hooks live in `.git/hooks/` (or `core.hooksPath`) but the plugin lives at `~/.claude/plugins/teamem/...` for marketplace users. Hooks must be self-contained — use template substitution `__TEAMEM_PLUGIN_ROOT__` → resolved absolute plugin path at install time (see `src/cli/install-git-hooks.ts:substitutePluginRoot`). Keep the `${repo_root}/plugin` source-tree fallback for local dev.

- **`git diff-tree` flag set**: pass `-r` (recursive), `-M50%` (pinned rename threshold — relying on user's `diff.renames` config drifts cross-machine), AND `--root` when `PARENT_COUNT == 0` for first-commit support. Without `--root`, the very first commit silently no-ops with no log signal.

- **Worktrees + `core.hooksPath`**: never hardcode `.git/hooks/`. Resolve via `git config core.hooksPath` first; fallback to `git rev-parse --git-path hooks`. Worktrees have `.git` as a file (not dir) and `core.hooksPath` redirects hooks elsewhere entirely.

- **Idempotent installer pattern**: content marker on installed file (`# teamem-managed-hook` on line 2 of every installed hook) + `.teamem-backup` on first install + **abort with clear error** if backup already exists AND incumbent file is non-teamem. Re-install over a teamem-managed file → overwrite, no backup churn.

- **Bridge schema must accept nullable fields the server returns** — the `claim_scope` success schema's `expires_at` MUST be `z.string().nullable()`. SDKs that DO validate the schema will reject the server's null response otherwise. Same goes for any error code union — adding a new `ErrorCode` server-side without updating the bridge's `error.code` union is invisible drift.

- **`bun run teamem` script must exist** — quickstart, hooks.md, claude-code-plugin.md, plugin/README.md all reference it. The `teamem` script in `package.json` routes to `src/cli/teamem.ts` which dispatches subcommands. If new doc strings instruct `bun run teamem <X>`, add the subcommand to the dispatcher.

- **Slash command files must exist** — `plugin/commands/teamem-*.md` is the source of truth for slash commands. Docs that reference `/teamem-X` without a corresponding `.md` file are broken at runtime.

### Standard gates

Run all four before declaring done:

```bash
bun test                                                                # full suite (765+ tests)
bun run typecheck                                                       # tsc --noEmit
bun run lint                                                            # eslint .
bun run build:plugin                                                    # committed plugin bundles
```

`bun run build:plugin` MUST run after any change to `src/bridge/`, `src/channel/`, or `src/cli/setup.ts` — `tests/plugin/bundle-freshness.test.ts` asserts byte-equivalence between the source and the committed `plugin/lib/*.js` bundles. In sandboxed environments, full `bun test` may need loopback/network permission because server integration tests bind local ports.

### Where lifecycle changes get documented

- **PRD**: `.omc/issues/27-claim-lifecycle-git-driven.md` (authoritative contract — 50 user stories + atomicity invariant + schema spec + error class names)
- **Slices**: `.omc/issues/28-...md` through `37-...md` (per-slice acceptance criteria)
- **ADR**: `.docs/adr/0008-claim-lifecycle-git-driven.md` (accepted design — has "Amendment 2026-05-05" §150 revert section at the bottom; future amendments append a new dated section, never edit prior ones)
- **CHANGELOG**: `CHANGELOG.md` (operator-facing — any column nullability or wire-protocol change MUST surface a one-time SQL migration here)
- **Smoke walkthrough**: `tests/smoke/claim-lifecycle-v2.md` (8-story end-to-end — keep slash command arg shapes in lockstep with `plugin/commands/teamem-*.md`)

### Review process learned this session

A single review pass misses things. The progression that worked here:
1. **Review #1** (functionality + atomicity) → 10 findings, fixed in parallel
2. **Review #2** (user end-to-end experience) → 5+ findings about install/UX/marketplace
3. **Review #3** (after PRD §150 revert) → 3 findings caused by the revert itself
4. **OMC code-reviewer** (comprehensive scan vs PRD) → 5 followups
Each pass had a different lens and surfaced different bug classes. **The atomic 763-test green did NOT mean "done"** — green means the tests we have pass; multi-perspective adversarial review catches what tests don't probe. When a change has cross-cutting blast radius (lifecycle, identity, projections), budget for at least 2 review lenses before ship.
