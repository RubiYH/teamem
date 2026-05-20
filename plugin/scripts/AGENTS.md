<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-09 | Updated: 2026-05-10 -->

# scripts

## Purpose

Bash runtime utilities and lifecycle hooks. Contains shared helper functions (`_common.sh`) and three Claude lifecycle hook implementations (`session-start.sh`, `gate-claim.sh`, `release-claims.sh`) that manage session sync, pre-edit claim gating, and Stop-hook telemetry.

## Key Files

| File | Description |
|------|-------------|
| `_common.sh` | Shared bash utilities: plugin root resolution, session directory logic, repo ID canonicalization, bridge bundle path, logging |
| `session-start.sh` | SessionStart hook: emits a startup/resume stdout instruction for the main agent to fetch the briefing, then runs session_sync if Teamem is active; refreshes TEAMEM.md Space Rules, replays decisions, surfaces gotcha notices, and fetches durable unread notifications |
| `gate-claim.sh` | PreToolUse hook: gates Edit/Write/MultiEdit on claimed scope; claims/refreshes paths before file edits |
| `release-claims.sh` | Stop hook: telemetry only; claims survive turn/session end and release via explicit command, force-release, TTL, or git evidence |

## For AI Agents

### Working In This Directory

- **_common.sh invariants**: This file MUST NOT be modified without understanding downstream impacts. Key functions:
  - `teamem_resolve_session_dir`: Derives `${SESSION_DIR}` from `${CLAUDE_SESSION_ID}` and resolved Teamem plugin data, not blindly from `${CLAUDE_PLUGIN_DATA}`
  - `_teamem_resolve_data_dir`: Treats `${CLAUDE_PLUGIN_DATA}` as advisory. Claude Code can expose another plugin's data dir (for example `codex-openai-codex`) to Teamem slash-command shells. Installed-cache mode derives `~/.claude/plugins/data/<plugin>-<marketplace>` from `${CLAUDE_PLUGIN_ROOT}`. Source-checkout mode derives `~/.claude/plugins/data/teamem-<marketplace>` when the parent checkout has `.claude-plugin/marketplace.json`, otherwise `~/.claude/plugins/data/teamem-inline`. Preserve the `${PLUGIN_ROOT}` fallback: absolute invocations like `plugin/bin/teamem-flag status` may not have `${CLAUDE_PLUGIN_ROOT}` set.
  - `teamem_is_active`: Checks if `${SESSION_DIR}/active` flag exists
  - `canonicalizeRepoId`: Computes source-of-truth repo ID from git remote; MUST stay byte-equivalent with `src/domain/claim-identity-core.ts`
  - `teamem_bridge_js`: Returns path to `lib/bridge.js`
- **gate-claim.sh complexity**: The most intricate script. It:
  1. Parses stdin JSON (hook payload with tool name, file path, command, etc.)
  2. Resolves the repo and branch context
  3. Calls `claim_scope` to gate the edit
  4. Handles conflicts (queueing active conflicts; legacy auto-discuss rows degrade to the same queue path)
  5. Updates claim cache for fast refresh
  6. Exits 0/1 to allow/deny the edit
  (See root AGENTS.md §96 for `claims.path` projection truncation gotcha)

### Common Patterns

- **Claim cache**: gate-claim.sh writes a local cache for diagnostics/backward compatibility, but edit gating always revalidates with the server. Do not add an `allow_cached` fast path: a post-commit release or peer force-release can make a local cache entry stale and allow edits over another teammate's newer claim.
- **Conflict handling**: When a PreToolUse claim returns 409 `scope_conflict`, the script:
  - Auto-skip: Queues the request and tells the user to retry when the incumbent releases.
  - Auto-discuss: Currently degrades to the same queue path because watcher/negotiator runtime is postponed in this plugin build.
  - Legacy ask-claimant values from old DB rows or stale conflict payloads normalize to auto-skip. Do not add a direct `request_edit_permission` branch back to this hook; permission requests are preserved as internal compatibility primitives, not an active coordination mode.
- **Stop-hook release gotcha**: `release-claims.sh` is intentionally a no-op for claim release. Claims survive turn/session end; do not reintroduce session-end release. `on_commit` claims release from the git `post-commit` hook, TTL claims expire via server logic, and manual claims require explicit release or force-release.
- **Logging**: All three hooks log to `${HOME}/.cache/teamem/hook-YYYYMMDD.log` with timestamp and status. Errors also log to `hook-errors.log`.
- **Activation/debugging gotcha**: If `/teamem-status` says active but `session_dir` points at another plugin such as `~/.claude/plugins/data/codex-openai-codex`, auto-claim may appear enabled while hooks skip or read the wrong state. The expected local marketplace path is `~/.claude/plugins/data/teamem-teamem-local/...`; `teamem-inline` is only the fallback for source plugins with no parent marketplace manifest.
- **Legacy permission-request debugging gotcha**: Permission requests no longer run from `gate-claim.sh`, but the primitive can still be exercised by tests or future internal flows. If a grant succeeds in SQLite while the requester sees an empty action, suspect the bridge/server response path rather than Channels or notification routing. A real bug here was the server `/tools/:name` route not awaiting async tool handlers, so the HTTP response was `{}` while SQLite side effects were correct.
- **SessionStart stdout contract**: `session-start.sh` does not perform the full briefing read itself. On startup/resume it emits exactly one stdout instruction telling the main agent to call `mcp__teamem__get_briefing`; when `_teamem_resolve_space` finds a session-pinned or configured space, that prompt payload must preserve it. Decision, gotcha, and unread-notification payloads stay on stderr.
- **SessionStart de-dupe**: Gotcha notices are delivered through `teamem.session_sync`, not `fetch_unread_notifications`. Do not re-add gotchas to `fetch_unread_notifications`; doing so duplicates notices on every resume and breaks the intended split where decisions replay with full text and gotchas replay as lightweight notices.
- **TEAMEM.md managed block**: `space-rules-file.js` owns the managed block and metadata comment. Escape metadata for HTML comments (`--`, `<`, `>`) and preserve user text outside the block. SessionStart should refresh from the server snapshot, never trust arbitrary local `TEAMEM.md` edits as applied until `/teamem-rule update` publishes them.

## Dependencies

### Internal

- `../lib/bridge.js` (MCP bridge; invoked by all three hooks)
- `../bin/teamem-call` (bash wrapper around bridge.js; NOT used directly by hooks; they invoke bridge.js directly)
- `src/domain/claim-identity-core.ts` (canonical repo_id computation; bash equivalent in _common.sh MUST stay in lockstep)
- `src/domain/git-evidence.ts` (SHA validation)

### External

- `git` command (for repo detection, branch name, SHA extraction)
- `bun` CLI (runs bridge.js)
- `jq` (not currently used; JSON parsing via bun -e instead)
- Base64 (for payload encoding in gate-claim.sh)

<!-- MANUAL: -->
