# Teamem — Claude Code Plugin

A self-contained Claude Code plugin that adds team-level coordination,
SessionStart sync, optional channel delivery, and durable team memory for
teammates using coding agents.
The plugin ships as a single installable artifact — no source tree
dependency, no per-machine path configuration.

## What this plugin gives you

| Capability | How |
| --- | --- |
| **Self-contained install** | `plugin/lib/bridge.js` is a single-file `bun build` artifact bundled with the marketplace plugin. `teamem init` / `teamem update` install it on any machine that has Bun and Claude Code. |
| **Slash commands** | `/teamem-off`, `/teamem-status`, `/teamem-briefing`, `/teamem-decide`, `/teamem-sprint`, `/teamem-discuss`, `/teamem-space`, `/teamem-setup`, `/teamem-reset`, `/teamem-disband`, `/teamem-restore`, `/teamem-gotcha`, `/teamem-coord-pref`, `/teamem-grant`, `/teamem-deny`, `/teamem-end-dispute`, `/teamem-clear-queue`. |
| **Agent-driven claims** | Claims are managed through MCP tools and hooks, not human slash commands. Edit gates auto-claim in `on_commit` mode; agents use `teamem.claim_scope`, `teamem.list_claims`, `teamem.release_scope`, and `teamem.force_release` for natural-language claim requests. |
| **Queue-first coordination + legacy permission primitives** | `auto-skip` is the active user-facing coordination preference. Stored or legacy `auto-discuss` values are treated as queued fallbacks in the current plugin build while negotiator automation is postponed. Legacy permission-request / grant / deny primitives still exist for compatibility and alert handling. |
| **Soft-by-default destructive ops** | `wipe` masks projection rows but retains them; `unwipe` recovers. `disband` tombstones the space for 7 days; `restore` undoes within the grace window. `wipe --hard` is the compliance escape hatch. |
| **Information-sharing primitives** | `share_finding` (tag-faceted, severity-labeled, 7-day TTL — surfaced through SessionStart sync, briefing, and optional channel flows), `share_artifact` (durable references), `agent_focus_changed` (replaces synthetic `task_started`). |
| **Discussion delivery** | `/teamem-discuss` stores direct or broadcast discussion messages durably. Phase 1 Channels POC can deliver them live when enabled; otherwise they remain available through SessionStart sync, `teamem.read_thread`, `/teamem-status`, and unread notifications. |
| **Briefing-on-demand** | `/teamem-briefing` and the `teamem-briefer` Haiku agent fetch the current plan, active claims, recent decisions, active risks, recent progress, and recent findings/artifacts. |

## Space mode and Sprint mode

Teamem has two live coordination modes inside one Space. Space mode is the
default when you are not joined to a Sprint; it preserves the historical
Space-wide behavior for ordinary claims and live updates. Sprint mode starts
when you join a Sprint, which is a work-goal context boundary inside the Space.
Sprint is not a privacy boundary: Space members can explicitly list Sprints and
read Sprint history, but non-members are not live-interrupted by ordinary Sprint
events.

Use `/teamem-sprint` for Sprint lifecycle:

```text
/teamem-sprint create <name> -- <goal>
/teamem-sprint join <slug-or-id>
/teamem-sprint leave
/teamem-sprint list
/teamem-sprint history <slug-or-id> [--limit N]
/teamem-sprint archive <slug-or-id>
/teamem-sprint reopen <slug-or-id>
```

Direct messages always reach the addressed teammate regardless of Sprint
membership. For `/teamem-discuss`, `*` broadcasts to the current Sprint in
Sprint mode and to the Space in Space mode; `**` is an explicit Space-wide
escalation that reaches teammates currently working inside Sprints too.
Archived Sprint history remains available through explicit history/list
commands as non-private lifecycle history, and it is not part of normal live
updates.

The monitor follows the same boundary: Space mode is not an all-Sprints feed,
and Sprint mode includes the current Sprint, direct-to-me messages, and explicit
Space-wide `**` broadcasts.

## Install

### Recommended: npm bootstrapper onboarding

Install the bootstrapper CLI:

```bash
curl -fsSL https://bun.sh/install | bash
```

```bash
npm install -g @rubiyh05/teamem
```

Then run:

```bash
teamem init
```

The bootstrapper diagnoses prerequisites, refreshes or adds the GitHub-hosted
marketplace `teamem-alpha`, installs `teamem@teamem-alpha` at the selected
scope, runs the installed setup bundle, and prompts about git hooks. To force
hook installation in a repo without the prompt, run `teamem init
--install-git-hooks`. Interactive setup also offers the opt-in Teamem Claude
statusline. To install it without prompting, run `teamem init
--install-claude-statusline`; to enable it later, run `teamem claude statusline
install`.

Use `teamem update` later to refresh the marketplace and installed plugin. Use
`teamem claude install` to install the Teamem-owned `claude` shim. Once the shim
directory is first on PATH, interactive `claude` prompts on every launch. The
installer prints the PATH line to add, but does not edit shell startup files by
default:

```bash
export PATH="$HOME/.teamem/bin:$PATH"
```

Use `claude --teamem` or `claude --pure` for explicit launch choices;
non-interactive `claude` defaults pure. A Teamem launch blocks before opening
Claude Code when setup, credentials, plugin install, or runtime Space readiness
is missing, and prints the repair command to run next.

The statusline lifecycle is:

```bash
teamem claude statusline install
teamem claude statusline status
teamem claude statusline uninstall
```

Teamem refuses to overwrite non-Teamem statuslines. Backup/restore behavior and
`--force` are deferred to a later installation/backups design.

`teamem cc` is kept only as a compatibility error for older workflows. It no
longer launches Claude Code; it points users toward the launcher migration.

The npm package is **not** the Teamem runtime and is **not** the MCP config
owner. It is only a bootstrapper CLI around Claude Code marketplace commands.
The plugin manifest remains the MCP authority, and Teamem server Docker Compose
setup is intentionally out of scope for `teamem init`.

### Manual source-tree loading

The plugin ships as a self-contained marketplace artifact for persistent
installs through `teamem init` and `teamem update`. For source-checkout
development, load the checkout for the current Claude Code session:

```bash
claude --plugin-dir /absolute/path/to/teamem/plugin
```

When testing the Teamem-aware launcher shim against source, combine the launch
intent with the local plugin directory:

```bash
claude --teamem --plugin-dir /absolute/path/to/teamem/plugin
```

For GitHub-hosted marketplace installs, the channel/install/update identity is
`teamem@teamem-alpha`. Shipped plugin changes are release-gated by
`plugin/.claude-plugin/plugin.json`: bump that plugin version intentionally, and
keep the root `.claude-plugin/marketplace.json` entry mirrored to the same
version. This explicit plugin version bump is what lets `claude plugin marketplace update`
and `teamem update` detect and pull new Teamem plugin releases.

When prompted, set:

- `default_space` — pin this plugin to one space when you belong to many.

There is **no `teamem_root` setting** anymore. The plugin no longer shells
out to a source tree.

## First-time setup

### npm/bootstrapper users

`teamem init` is the first-time setup path. It installs or updates the plugin,
runs the create/join flow, prompts to install git hooks in the current repo, and
offers the Teamem Claude statusline in interactive setup. After it completes:

1. Run `teamem claude install` to install the Teamem-owned `claude` shim.
2. Add the printed PATH line, then launch Claude Code normally with `claude`.
3. Choose Teamem at the launch prompt, or run `claude --teamem` when you want the explicit Teamem path.

If you decline the statusline offer, enable it later with `teamem claude
statusline install`. Non-interactive `teamem init` installs the statusline only
when `--install-claude-statusline` is provided.

The launcher passes a one-shot Teamem launch intent into Claude Code. The
plugin's SessionStart hook consumes that intent, writes the normal active
session state, and then runs the same startup sync used by manually activated
sessions.

### Source-checkout developers

If you are developing the plugin from this repository instead of using the npm
bootstrapper:

1. Run `/teamem-setup` in Claude Code. The `teamem-onboarding` skill walks you through creating or joining a space. Your member name is pre-filled from `git config --global user.name`, falling back to `$USER`. Generic shared-host values (`root`, `ubuntu`, `admin`, etc.) force a manual entry.
2. Install git hooks from the checkout when you need source-tree hook testing:
   ```bash
   bun run teamem install-git-hooks
   ```
   This installs `post-commit` and `post-checkout` hooks into Git's configured hooks directory. Run this in every clone. If you use a hook manager (husky, lefthook), add entries that call `${CLAUDE_PLUGIN_ROOT}/git-hooks/post-commit` and `${CLAUDE_PLUGIN_ROOT}/git-hooks/post-checkout`.
3. If you are launching directly from the source checkout, pass
   `claude --teamem --plugin-dir /absolute/path/to/teamem/plugin` so the
   launcher intent activates the session. The deprecated `/teamem-on` activation
   command is no longer shipped.

## Activation model

Teamem stays inert for pure launches. In the normal marketplace flow, the
Teamem launcher shim asks whether to start Claude Code with Teamem; choosing
Teamem, or running `claude --teamem`, passes a launch intent that the
SessionStart hook consumes. That hook writes the same active-session flag as
the retired manual command used to write, then fetches the startup sync.

The deprecated `/teamem-on` activation command is no longer shipped. Restart pure
sessions through `claude --teamem` when hooks and monitor delivery are needed.
The plugin's hooks and monitor poll only when the current session has an
`active` flag or the project has `auto-on`, unless the session has a `disabled`
override from `/teamem-off`.

```text
claude --teamem → SessionStart writes active flag → startup sync → done
/teamem-off     → write disabled override → monitor idles → MCP stays up
```

The MCP server stays connected even when "off" so ad-hoc commands like
`/teamem-briefing` still work.

## Phase 1 Channels POC

Phase 1 Channels is a parallel proof of concept, not a replacement for the
existing monitor path. When the optional `teamem-channel` runtime is enabled,
the documented manual sender is:

```text
/teamem-discuss <principal|*|**> -- <topic>
```

Delivery expectations for this POC:

- Directed discussion messages are visible only to the addressed recipient's active channel session.
- `*` discussion broadcasts are visible to non-senders in the current Sprint when the sender is in Sprint mode, and to non-senders in the Space when the sender is in Space mode.
- `**` discussion broadcasts are explicit Space-wide escalations and may live-interrupt Space members even when they are currently in Sprints.
- Normal queue-first file-claim conflicts do not send Channel alerts; they continue through the hook denial and pending-edit queue path.
- Legacy permission requests may also surface as urgent incumbent-only channel alerts carrying the exact metadata fields `req_id`, `blocking_claim_id`, `incumbent_principal`, `event_id`, `event_type`, and `principal`. The JSON content retains the full payload and scope and must surface `/teamem-grant <req_id>` and `/teamem-deny <req_id>`.
- `teamem.read_thread`, `/teamem-status`, unread notifications, and the next SessionStart sync remain the fallback path when the channel runtime is disabled, unavailable, or not yet enabled in a session.
- Local `--plugin-dir` channel sessions poll whenever `teamem-channel` starts successfully. Set `TEAMEM_CHANNEL_REQUIRE_ACTIVE=1` only when you specifically want channel polling gated by the session active flag.
- Teamem space membership is the default trust boundary. For stricter sender gating during local tests, set `TEAMEM_CHANNEL_ALLOWED_SENDERS=bob,alice`; messages from other principals are dropped before `notifications/claude/channel`.

### Run and verify the POC

1. Rebuild the plugin bundles from the repo root:
   ```bash
   bun run build:plugin
   ```
2. In the repository where you will launch Claude Code, add a real `teamem-channel` MCP server entry. Replace `/absolute/path/to/teamem` with this checkout's absolute path:
   ```json
   {
     "mcpServers": {
       "teamem-channel": {
         "command": "bun",
         "args": ["run", "/absolute/path/to/teamem/plugin/lib/channel.js"]
       }
     }
   }
   ```
   The `server:teamem-channel` development-channel flag only works when the launching repo's `.mcp.json` has this matching server name.
3. Start Claude Code with the local development plugin and channel allowlist bypass:
   ```bash
   claude \
     --plugin-dir /absolute/path/to/teamem/plugin \
     --dangerously-load-development-channels server:teamem-channel
   ```
   Custom channels are research-preview gated. If Claude prints `Channels are not currently available`, check your Claude Code version, org policy, and the troubleshooting section below.
4. Start the Teamem server:
   ```bash
   bun run server
   ```
5. Optional direct local runtime check for the channel server bundle:
   ```bash
   bun run channel
   ```
   This is the same stdio MCP runtime shipped as `plugin/lib/channel.js`. In normal usage Claude Code starts it from `plugin/.mcp.json`.
6. In Alice and Bob Claude Code sessions for the same Teamem space, use
   `claude --teamem`.
7. From Bob, send the manual smoke message:
   ```text
   /teamem-discuss alice -- Can you see this over the Teamem channel?
   ```
8. Verify:
   - Alice receives the directed Teamem `<channel ...>` event.
   - Carol and other teammates do not receive that Bob-to-Alice directed channel event.
   - `teamem.read_thread` still shows the same stored discussion message/thread.
   - `notifications.log` proves Teamem polled and attempted to emit; it does not by itself prove Claude Code accepted or rendered the channel event.
   - Debug logs may live under a local-dev slug such as `~/.claude/plugins/data/teamem-inline/channel.log`, not only `~/.claude/plugins/data/teamem/channel.log`.

Targeted verification commands:

```bash
bun test tests/unit/channel/payload.test.ts tests/unit/channel/runtime.test.ts tests/integration/channel/channel-server.test.ts
bun test tests/plugin/bundle-freshness.test.ts
bun run typecheck
bun run lint
```

### Fallback and rollback

- Fallback: if `teamem-channel` is unavailable, disabled, or not yet active for a session, use `teamem.read_thread`, `/teamem-status`, unread notifications, and the next SessionStart sync.
- Rollback: remove or disable the `teamem-channel` entry in `plugin/.mcp.json`, stop rebuilding `plugin/lib/channel.js`, reinstall the plugin, and keep the existing `teamem` bridge/monitor/hook flow unchanged.

## Claim lifecycle (agent-driven, git-released)

Claims survive session end (`Stop` is a no-op). Git commits are the release
boundary. Install git hooks once per clone. For npm/bootstrapper users:

```bash
teamem init --install-git-hooks
```

For source-checkout development:

```bash
bun run teamem install-git-hooks
```

### Three claim modes

| Mode | Set by | Released by | Use case |
|------|------|-------------|----------|
| `on_commit` | edit gate or agent MCP call | git commit | Normal edits |
| `manual_only` | agent MCP call | explicit release or force-release | Living docs, long-running specs |
| `ttl` | agent MCP call | TTL expiry or commit, whichever first | Time-boxed exploration |

Humans should use natural language for claim actions, for example:

```text
Claim README while I update the setup notes.
Release my Todo.jsx claim.
Take over Bob's stale FilterButton.jsx claim if it is safe.
Who currently holds src/components?
```

The agent should translate those requests into MCP calls (`teamem.list_claims`,
`teamem.claim_scope`, `teamem.release_scope`, `teamem.force_release`) and ask for
confirmation before risky force-release decisions.

Force-release notifies the claim holder through the unread queue on their next
active SessionStart; channel-enabled sessions may also surface it live. If a
session was launched without Teamem intent, restart with `claude --teamem` to
make the queued notice visible.

In Sprint mode, new claims conflict only with claims in the same Sprint. In
Space mode, new claims conflict with Space-mode claims. Overlapping claims in
another Sprint are non-blocking cross-Sprint awareness; git merge and review own
that later integration risk.

## Coordination prefs (the conflict story)

The active user-facing preference, editable any time via
`/teamem-coord-pref`, is:

| Mode | What happens when *you* are the latter and *they* are the incumbent |
| --- | --- |
| `auto-skip` | Halt this edit; Teamem queues it; you proceed with other work. When the incumbent releases, the queued work can be rediscovered through `/teamem-status`, unread notifications, or the next SessionStart sync. |

`auto-discuss` remains in backend contracts for compatibility and roadmap work, but the plugin no longer opens background negotiator disputes. If a stale stored preference resolves to `auto-discuss`, the gate degrades it to the same queued path as `auto-skip`.

Legacy/internal permission-request flows still exist behind the scenes for compatibility and alert handling. When they surface, the incumbent responds with `/teamem-grant <req_id>` or `/teamem-deny <req_id>`.

**Incumbent's preference wins.** The interrupted party's tolerance governs disruption.

## Information-sharing primitives

| Primitive | Tool | When to use |
| --- | --- | --- |
| Decision | `record_decision` (`/teamem-decide`) | Policy / architecture choices. Plan-kind decisions supersede prior plan decisions. Persistent. |
| Gotcha | `share_finding` (`/teamem-gotcha`) | Persistent lessons learned during work, tag-faceted. Short notices replay on SessionStart and remain available in briefings/threads; details are fetched by id. |
| Artifact | `share_artifact` | Durable references (specs, fixtures, docs, snippets). No expiration. |
| Focus | `agent_focus_changed` | Auto-emitted by the gate-claim hook when scope shifts. Deduped within 60s on `(member, scope_hash)`. |

## Soft-destructive ops

| Verb | Default | Escape hatch |
| --- | --- | --- |
| `space wipe` | Soft — tombstones projection rows; briefing returns empty for pre-wipe state | `wipe --hard` for compliance / GDPR |
| `space unwipe` | Restores from soft-wipe | (Cannot reverse hard-wipe) |
| `space disband` | Soft — 7-day grace; auth rejects with 410 immediately | `wipe --hard` before disband |
| `space restore` | Reverses disband within grace window | (Cannot recover after grace) |
| `space kick <member>` | Marks `members.left_at = now`; their next API call rejects with 401 | (None) |

## Architecture (one screen)

```text
┌─ Claude Code ────────────────────────────────────────────────────┐
│                                                                  │
│  /teamem-* commands  →  MCP tools (TOOL_BINDINGS)                │
│                            ↓                                      │
│                   ${CLAUDE_PLUGIN_ROOT}/lib/bridge.js (bundle)   │
│                            ↓                                      │
│  PreToolUse(Edit|Write)  →  scripts/gate-claim.sh   ─┐           │
│  Stop                    →  scripts/release-claims  ─┤  if active │
│  SessionStart            →  scripts/session-start   ─┤           │
│                                                      ↓           │
│                                              launch intent or    │
│                                              flag file present?  │
│                                              yes → call bundle   │
│                                              no  → exit 0        │
│                                                                  │
│  Monitor (`bin/teamem-monitor`)                                  │
│   poll teamem.get_updates  →  session logs / future delivery      │
└──────────────────────────────────────────────────────────────────┘
                                         ↕  (HTTPS / JWT)
                          ┌──────────────────────────┐
                          │  Teamem server (Bun+Hono) │
                          │   - registered tools      │
                          │   - SQLite event store    │
                          │   - Hourly disband-GC     │
                          │   - 60-min mcp session GC │
                          └──────────────────────────┘
```

## Configuration

The plugin has zero required configuration — install it, run `/teamem-setup`, install the Teamem launcher shim, then launch normal `claude` and choose Teamem. The env vars below tune behavior at the edges; all are optional.

### Hook behavior

| Env var | Default | Effect |
| --- | --- | --- |
| `TEAMEM_HOOK_DISABLE` | unset | When `=1`, the PreToolUse hook short-circuits before any work. Use this to debug whether a problem is hook-related; faster than `/teamem-off`. |
| `TEAMEM_HOOK_QUIET` | unset | When `=1`, suppresses all `teamem: <class> — <cause>` warning lines from hook stderr. Keeps the trace log entries. |
| `TEAMEM_WARN_RATE_SECS` | `60` | Per-warn-class rate limit, in seconds, for the stderr surface. A broken bridge that fires every keystroke surfaces one line per minute, not one per edit. |
| `TEAMEM_PROJECT_ID` | unset | Override the auto-derived project key. Useful when monorepo subdirectories should be treated as separate projects, or when a fresh `git init` has no remote. The default resolution prefers `git config remote.origin.url` so multiple clones of the same repo share a key. |
| `TEAMEM_HOOK_TRANSPORT` | `shellout` | Bridge transport mode. `shellout` (default) spawns a fresh `bun run` subprocess per call; the daemon transport (`daemon`) was removed in v1 — see deletion list below. |
| `CLAUDE_PLUGIN_OPTION_DEFAULT_SPACE` | unset | Manifest default space label or `space_id`. Set via `userConfig.default_space` in your Claude Code settings; the bridge defensively ignores unsubstituted `${user_config.X}` placeholders. |

### Server behavior (when running your own teamem-server)

| Env var | Default | Effect |
| --- | --- | --- |
| `TEAMEM_IDEMPOTENCY_RECOVERY` | on (default) | When unset or anything other than `0`, claim_scope retries on the same scope after a release/expiry succeed with a fresh claim_id. Set `=0` to opt out and surface the underlying `Idempotency conflict` 500 — useful only for diagnosing a stuck idempotency_keys row. See AC-NEW in `tests/integration/server/idempotency-collision.test.ts`. |
| `TEAMEM_DB_PATH` | `./data/teamem.db` | SQLite database path. |
| `TEAMEM_JWT_SECRET` | required | HS256 signing secret for issued JWTs. |

### Tier-W warn classes (`teamem: <class> — ...`)

When the hook surfaces a stderr line, the class is your first triage signal:

| Class | Meaning | Fix |
| --- | --- | --- |
| `claim-encode-failed` | `bun -e` couldn't serialize the claim payload | `bun --version` should be ≥ 1.0; reinstall bun if older |
| `bridge-unreachable` | Bridge subprocess crashed or returned `network_error` | `curl <server_url>/health`; verify the server is running |
| `unhandled-response` | Bridge returned an unexpected shape | `tail ~/.cache/teamem/hook-errors.log`; check that JWT in `~/.teamem/credentials.json` matches a live space |

All three exit `0` and let the edit proceed (fail-open). The warn line is informational. To silence them entirely set `TEAMEM_HOOK_QUIET=1`.

## Design notes

The public design shape is:

- Teamem ships Claude Code support first.
- The plugin runtime is bundled so installed users do not need a source-tree path.
- Git is the release boundary for normal claims.
- Queue-first coordination avoids interrupting the teammate already holding a claim.
- Destructive space actions are soft by default, with explicit hard-wipe as the escape hatch.

## Operator references

Public operating notes are split across
[`docs/integrations/claude-code-plugin.md`](../docs/integrations/claude-code-plugin.md),
[`docs/troubleshooting.md`](../docs/troubleshooting.md), and
[`docs/deploy/vps.md`](../docs/deploy/vps.md). Keep this README as the detailed
plugin runbook until those pages grow fuller operational coverage.

## Removed in v1

The following were present in the PoC but are **not** in v1:

- Multi-harness integrations — v1 ships Claude Code only.
- `teamem.publish_event` and `teamem.detect_conflicts` MCP tools.
- `userConfig.teamem_root` plugin config.
- The `bridged` daemon (`bun run bridged`) and legacy source-tree hook installer (`bun run hook-install`). Use `bun run teamem install-git-hooks` for v2 git hooks.
