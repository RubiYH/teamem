# Teamem — Domain Glossary

> Living document. Captures domain terms and their canonical meanings as they
> are resolved during design discussions. Do not include implementation
> details; only domain concepts that a non-engineer would care about.

## Glossary

### Bootstrapper CLI

The npm-installed `teamem` command that prepares a teammate's machine for Teamem by installing/configuring local integrations while leaving the Teamem plugin/runtime as the authoritative product artifact. On `teamem init`, it repairs or installs missing Teamem-owned sources/artifacts first by adding/updating the GitHub-hosted Claude Code marketplace `teamem-alpha` and installing `teamem@teamem-alpha`, then presents the normal create/join setup flow; it defaults to the latest stable plugin available from that marketplace with explicit version/channel overrides, lets the teammate choose the plugin install scope, diagnoses third-party prerequisite gaps without installing them, and does not separately author MCP configuration when the plugin manifest already supplies the Teamem MCP servers.
_Avoid_: npm runtime package, standalone replacement for the Claude Code plugin

`teamem init` asks before installing git hooks in the current repository, defaulting to yes when a git repository is detected because commit hooks are the normal claim-release boundary.

The alpha marketplace uses explicit plugin versions: every shipped plugin change must bump `plugin/.claude-plugin/plugin.json` so Claude Code can detect updates.

`teamem cc` is a compatibility error only. It does not launch Claude Code or check for updates. Existing users should move to the opt-in `teamem claude install` shim or invoke the real Claude Code executable directly when they want to bypass Teamem.

### Teamem-aware Claude launcher

An opt-in local launch path that lets a teammate start Claude Code from their normal `claude` habit while choosing at launch time whether this session should load Teamem.
_Avoid_: hijack, silent wrapper, forced Claude replacement

It must never silently replace pure Claude Code. The teammate explicitly installs the integration, and each interactive launch preserves a clear pure-Claude option.

The launcher has its own lifecycle because it changes future shell behavior: teammates can install, inspect, or uninstall it directly with `teamem claude install`, `teamem claude status`, and `teamem claude uninstall`.

For migration, `teamem cc` is a compatibility error that does not launch Claude Code. It points users to `teamem claude install` and the opt-in `claude` shim.

Launcher install creates Teamem-owned shim files and prints exact PATH instructions by default; it does not edit user-owned shell startup files.

Launcher state is machine-local Teamem state, not repository-local scope memory.

The runtime implements the actual `claude` shim prompt policy, pure-vs-Teamem launch selection, readiness checks, plugin-owned activation intent, default Space behavior, uninstall cleanup, and final user-facing docs.

Interactive launches prompt on every launch, defaulting to Teamem, rather than remembering a permanent Teamem-or-pure choice.

Non-interactive launches default to pure Claude Code unless the caller explicitly opts into Teamem, so scripts and editor integrations are not changed by surprise.

The launcher intercepts `claude` through a reversible Teamem-owned PATH shim, not by modifying or replacing the real Claude Code executable.

The shim records the real Claude Code executable when installed, uses that saved path for launch, and reports when the saved executable later disappears.

A Teamem launch loads the Teamem plugin channel and passes launch intent to the plugin; a pure launch calls Claude Code unchanged.

Launcher-driven activation is a launch intent handed to the plugin, not direct session-file mutation by the outer shim; the plugin SessionStart hook owns translating that intent into normal active-session state.

If Teamem is not installed or set up well enough to activate, readiness blocks before opening Claude Code and shows the teammate the next repair command. "Set up well enough" means satisfying the same prerequisites `teamem init` requires plus the runtime requirements needed for the plugin to activate against a real Space.

The readiness path diagnoses but does not repair setup; repair stays in explicit `teamem init` and related lifecycle commands.

Space selection stays quiet at launch: the launcher uses the configured default Space unless the teammate provides an explicit Space override.

Readiness checks and activation policy belong in the bootstrapper package and plugin-owned activation path, with the installed shim kept as a thin entrypoint into tested code.

Launcher changes are verified through the bootstrapper package gates plus focused tests for install/status/uninstall, prompt policy and non-interactive behavior, readiness blocking, activation, `teamem cc` migration, uninstall cleanup, and final docs.

### Coordination preference

A per-teammate choice declared during onboarding (and editable later). Recorded on the `members` row. Consulted by the conflict resolver when two principals collide on a scope claim.

Three values:

| Value | Meaning |
| - | - |
| `auto-skip` | When I am the latter (the conflicted one), halt this task and have Teamem queue it for later. When the incumbent's claim is released, Teamem reminds me. |
| `ask-claimant` | When I am the latter, send the incumbent a request-to-edit. They accept or deny. On accept, the incumbent releases the relevant scope and I claim. On deny, I fall through to `auto-skip` (queue and remind). |
| `auto-discuss` | When I am the latter, my Teamem background agent opens a dispute thread with the incumbent's background agent and they coordinate task ordering. **Only available if both parties have opted in.** |

### Conflict resolution rule (incumbent-wins)

When the latter and incumbent have different coordination preferences, the **incumbent's** preference wins. Rationale: they hold an in-flight claim; their work is the one being interrupted, so the policy is theirs to set.

Specific cases:

- Both `auto-skip` → mode `auto-skip`.
- Latter `ask-claimant`, incumbent `auto-skip` → mode `auto-skip`.
- Latter `auto-skip`, incumbent `ask-claimant` → mode `ask-claimant` (incumbent will be asked, but the latter prefers queuing — the *latter's* downstream behavior on a deny still queues, so this is consistent).
- Either party not opted in to `auto-discuss` → mode `auto-discuss` is unavailable; resolver falls through to `ask-claimant` if either party prefers it, else `auto-skip`.

### Incumbent

The principal who currently holds an active scope claim that overlaps the latter's intended edit.

### Latter

The principal whose claim attempt was rejected because of an existing claim. Always the second-in-time party to a conflict.

### Space

An isolated team trust and membership boundary. Identified by a ULID `space_id`. Created by a team lead. Joined by teammates via room code. Members of different spaces are completely isolated.

When no Sprint is active, Space mode preserves the historical behavior: members coordinate against the Space-wide event and claim picture. When a Sprint is active, Sprint membership narrows the live monitoring and claim-conflict context for that work goal; Space remains the broader trust boundary, not the live interruption boundary.

### Sprint

A work-goal context boundary inside a Space. A Sprint groups a subset of Space members around one goal, such as "plugin release". Sprint is not a privacy boundary in v1: Space members can explicitly inspect Sprint metadata/history, but non-members do not receive live Sprint monitor events by default.

Rules resolved for v1:

- A Sprint belongs to exactly one Space.
- Sprint names are unique within their Space, including archived Sprints. A Sprint display name is trimmed, must be non-empty after trim, and is capped at 80 characters for v1. A Sprint has a human display name and a canonical dashed slug: the slug normalizes from the display name to lowercase `a-z0-9-`, collapses repeated dashes, trims leading/trailing dashes, and is rejected if empty after normalization. The trimmed display name is preserved for rendering. Display name and slug are immutable in v1; rename is deferred.
- Command surfaces display and prefer slugs, but accept either slug or Sprint id for targeting. IDs are a fallback for ambiguity and debugging, not the normal user-facing handle.
- Sprint goal is required at creation. The goal is trimmed, must be non-empty after trim, and is capped at 500 characters for v1. Goal/description can become mutable later, but the first experimental slice only sets it at creation time.
- Creating a Sprint whose slug already exists is rejected, not treated as an idempotent join. If the existing Sprint is active, the error should tell the member to join it instead. If the existing Sprint is archived, the error should tell the member to reopen it instead.
- Sprint lifecycle changes are event-sourced first-class Teamem events: `sprint_created`, `sprint_joined`, `sprint_left`, `sprint_archived`, and `sprint_reopened`. Archive claim cleanup emits normal claim release/force-release events per claim rather than hiding cleanup inside one aggregate event.
- Top-level `sprint_id` means the routing/context scope of an event, not merely that the author happened to be in a Sprint. Sprint lifecycle events carry the affected Sprint as their `sprint_id`. Space-mode and explicit Space-wide events carry `sprint_id: null`, even if the author is currently in a Sprint.
- Legacy events without `sprint_id` are treated as Space-mode (`sprint_id: null`). There is no backfill into Sprints.
- Events that need explicit delivery semantics carry top-level routing intent separately from `sprint_id`, such as `delivery_scope: direct | sprint | space`. `delivery_scope` is event metadata, not payload data. `sprint_id` identifies context; `delivery_scope` identifies how the event should be routed.
- New events persist explicit `delivery_scope`. Inference is a read-compatibility rule for legacy events only, not a writer shortcut.
- Direct delivery uses top-level recipient metadata such as `recipient_principals: string[]`. Event payloads may still contain business-specific recipient details, but delivery consumers must not parse payload shapes to decide routing.
- New events with `delivery_scope: "direct"` must include non-empty top-level `recipient_principals`. A direct event without recipients is malformed. Legacy payload-only direct events may infer recipients during read compatibility, but new writes must fail validation without top-level recipients.
- New events with `delivery_scope: "direct"` may carry `sprint_id` as context, but direct routing is controlled only by `recipient_principals`. Direct delivery interrupts the recipient regardless of their current Sprint.
- New events with `delivery_scope: "sprint"` or `"space"` must not include `recipient_principals`. Sprint and Space delivery fanout is derived from current membership at delivery/read time, not frozen into explicit recipient metadata. Direct events are the exception: their explicit `recipient_principals` are the recipient snapshot.
- New events with `delivery_scope: "sprint"` must include a non-null `sprint_id`. Sprint-scoped delivery without a Sprint id is malformed. Explicit Space-wide escalation from inside a Sprint uses `delivery_scope: "space"` with `sprint_id: null`.
- New events with `delivery_scope: "space"` must carry `sprint_id: null`. If a Space-wide event is about a specific Sprint, that relationship belongs in event-specific payload metadata such as `affected_sprint_id`; it must not overload routing context.
- Legacy events without `delivery_scope` are inferred for compatibility: direct-recipient metadata implies `direct`, non-null `sprint_id` implies `sprint`, and otherwise the event is treated as `space`.
- Any Space member can create, join, leave, archive, and reopen a Sprint in v1. Archiving does not require the actor to be a Sprint member; the guardrails are the zero-member archive precondition, explicit claim cleanup events, and durable audit history.
- Creating a Sprint automatically joins the creator and moves them out of any current Sprint in that Space.
- A member can belong to at most one active Sprint per Space.
- Joining a Sprint leaves the member's current Sprint in that Space and makes the joined Sprint their current work context.
- Joining the Sprint the member is already in is idempotent: return a clear no-op message such as `already in <sprint>` and do not emit a duplicate lifecycle event.
- Commands that change current Sprint proceed atomically but must report both sides of the switch when they move the actor out of an existing Sprint. For example: `left <old-sprint>, joined <new-sprint>`. This applies to `create`, `join`, and `reopen`.
- Joining a Sprint makes prior Sprint history visible in non-live surfaces such as status, briefing, and history because Sprint is not a privacy boundary. Live Sprint interruption applies only to Sprint events delivered while the member is currently in that Sprint.
- Leaving a Sprint returns the member to Space mode.
- `leave` output must report the new mode explicitly, for example `left <sprint>; now in Space mode`, because Space mode is still an active coordination mode.
- `leave` is idempotent in Space mode and returns a clear no-op message such as `already in Space mode` instead of failing.
- After leaving a Sprint, ordinary status and briefing no longer include that Sprint's context. The exceptions are explicit history/recovery commands and the member's own leftover claims, which remain visible so the member can clean them up.
- Archived Sprints can be reopened with the same identity, name, membership history, and event history. Reopen automatically joins the actor and moves them out of any current Sprint, matching create. Reopen does not automatically rejoin prior members or restore claims that were released or force-released during archive.
- Reopen can be performed by any Space member in v1. Because reopen auto-joins the actor and emits durable lifecycle history, the action is explicit and auditable.
- Reopening an already active Sprint is a no-op only when the actor is already in that Sprint. If the Sprint is active and the actor is not in it, `reopen` should tell the actor to use `join` instead.
- Archived Sprints cannot be joined directly. A member must explicitly reopen the Sprint first, creating an auditable lifecycle transition back to active coordination.
- Archived Sprint history remains visible through explicit history/audit commands. Archive ends active coordination and live routing for that Sprint; it does not erase the Sprint record.
- `/teamem-sprint list` shows both active and archived Sprints by default, with clear state labels. Archived Sprints are not hidden behind a separate flag because Sprint names remain reserved and archived Sprints can be reopened. List is compact inventory, not a lifecycle log: it should show fields such as slug, display name, active/archived state, goal, current members, and last activity. Full lifecycle history belongs in explicit history/audit commands. V1 list is not capped or paginated; pagination is deferred until Spaces accumulate enough Sprints to need it.
- A Sprint can be archived only after every member has left it. During archive, Teamem may force-release any remaining active claims tied to that Sprint as an explicit archive side effect, with normal audit-visible release events. Archive force-release sends direct cleanup notifications to affected claim owners, even if they already left the Sprint, but does not broadcast broad live cleanup notifications to current Space or Sprint members. Broader live announcement still requires explicit `**`.
- Archiving an already archived Sprint is idempotent: return a clear no-op message such as `already archived <sprint>` and do not emit another archive event.
- Sprint archive is non-interrupting by default. It emits durable/status-visible history, but live Space-wide closure announcements require an explicit `**` broadcast.
- Sprint lifecycle events such as create, join, leave, archive, and reopen are durable/status-visible by default, not live-interrupting for other members. The acting member sees command output immediately; broader live announcement requires explicit `*` or `**` broadcast.
- Current Sprint is server-authoritative membership state. Plugin-local session files may cache it for display or fast status, but they are not the source of truth.
- Current Sprint is principal-level within a Space, not per Claude session. If one session joins a Sprint, the member's other sessions in that Space observe the same current Sprint on their next server read.
- Sprint membership lives in a separate projection table, not only on `members.current_sprint_id`, so Teamem can preserve membership history and rebuild state from events. A convenience field on `members` may exist if useful, but event replay plus the Sprint membership projection is canonical and must be able to rebuild it. A partial uniqueness rule enforces at most one active Sprint membership per `(space_id, principal)`.

### Sprint mode

The Teamem operating mode for a member currently joined to a Sprint. Live monitoring and notifications are Sprint-wide by default: peer-to-peer events inside the Sprint and Sprint-wide events are urgent and interruptible for Sprint members, while Space members outside the Sprint are not interrupted.

Direct peer-to-peer messages are the exception: an explicit direct message to a member is always live-interrupting for that member, regardless of the sender's Sprint or the recipient's current Sprint. Direct-message rendering should include sender context as metadata, such as `Direct from Alice (plugin-release)` or `Direct from Alice (Space mode)`, but that context does not affect routing. Sprint prevents unrelated team-wide noise; it does not suppress intentional direct contact. Automatic claim, conflict, permission, and overlap-awareness events do not get this bypass.

`get_updates` follows the member's current mode. In Space mode it returns Space-mode events plus explicit direct-to-me messages and explicit Space-wide events; it does not act as an all-Sprints feed. In Sprint mode it returns current-Sprint events, explicit direct-to-me messages regardless of Sprint, and explicit Space-wide events; it excludes other Sprint events, archived Sprint history, and ordinary Space-mode events.

Ordinary Space-mode events do not live-interrupt members currently in Sprints. Only explicit `**` Space-wide events and direct-to-me messages cross into Sprint live context.

Briefing follows the same context boundary. In Sprint mode, briefing is Sprint-first: current Sprint header, goal, members, active claims, decisions, gotchas, blockers, and progress; direct-to-me messages regardless of Sprint; explicit `**` Space-wide announcements; low-priority cross-Sprint overlap awareness; and a separate outside-current-context section for the member's own leftover claims. It does not include ordinary events from other Sprints, archived Sprint summaries, or ordinary Space-mode noise. Archived Sprint context appears only through explicit history/audit commands or when directly relevant to the member's leftover claims.

Status stays compact and operational. In Sprint mode it shows Teamem activation, monitor health, Space label/id, mode `Sprint`, Sprint display name and slug, Sprint members, the member's active claims in the current context, the member's active claims outside the current context, recent notifications in the current routing set, and a cross-Sprint overlap count rather than full detail. `/teamem-status` does not list archived Sprints; archived inventory belongs in `/teamem-sprint list` and explicit history/audit commands.

Claims made in Sprint mode are coordinated against the current Sprint's claim picture. Overlapping work in a different Sprint is not a Teamem conflict in v1; the repository's normal git and merge workflow owns that later integration risk.

Claims are context-stable after creation. A claim created in Space mode remains a Space-mode claim, and a claim created in Sprint mode remains tied to that Sprint. Joining or leaving a Sprint does not silently release, pause, or migrate existing claims; it only affects the context stamped on new claims. Status surfaces should make claims outside the member's current context visible as leftovers.

Claim projection rows carry nullable `sprint_id`. `NULL` means Space-mode claim; non-null means Sprint-mode claim. Conflict lookup filters by context: Space mode compares only Space-mode claims, and Sprint mode compares only claims with the same `sprint_id`.

Claim listing defaults to the current context. In Sprint mode it lists current-Sprint claims by default, with explicit options for Space-wide recovery views and for the member's own outside-current-context leftovers. In Space mode it preserves the current Space behavior.

Force-release by path or search defaults to the current context. Force-release by exact `claim_id` can cross context because the id is unambiguous, but the response must display the claim's context before release.

Git-driven release uses claim context, not the member's current Sprint. A post-commit release finds the matching active claim by ownership/repo/branch/path and emits the release event with that claim's original `sprint_id`.

When one commit releases claims from multiple contexts, release notifications route per released claim context and may be live within that context. Same-context pending edits receive unblock notifications; current Sprint members see live releases for claims in their Sprint; Space-mode members see live releases for Space-mode claims; other contexts are not live-interrupted. If a member has left a Sprint but still owns leftover claims there, cleanup notifications about their own released/unblocked leftover claims may reach them as direct-to-owner signals; ordinary Sprint-wide release noise does not keep interrupting them. Those cleanup signals use `delivery_scope: "direct"` with top-level `recipient_principals` and the old Sprint's `sprint_id` as context metadata.

Automatic coordination machinery is context-scoped. Claims, conflicts, pending edits, conflict resolution, and unblock notifications all share one coordination context: Space mode or one Sprint. Only explicit communication, such as direct messages or `**` broadcasts, crosses context live.

Pending edit rows carry nullable `sprint_id`. Enqueue context matches the failed claim context, and resolve-on-release only matches pending edits in the same context: both `NULL` for Space mode, or the same Sprint id.

Blockers follow the current context by default. A blocker raised in Sprint mode is Sprint-scoped; a blocker raised in Space mode is Space-mode. Cross-context escalation requires explicit direct communication or `**` Space-wide broadcast.

Joining or leaving a Sprint should warn, but not block, when the member has active claims outside the new context. Leaving a Sprint also succeeds when the member still has active claims tied to that Sprint; those claims become out-of-current-context leftovers until normal release or Sprint archive force-release. The response should state that the claims remain active and should be released when done. Archive is the exception: after all members have left, archive may force-release remaining claims tied to the archived Sprint.

Cross-Sprint overlapping work may appear as low-priority awareness in status or briefing surfaces. It must not block, interrupt live, or route through the coordination handshake by default.

Decisions and gotchas created in Sprint mode are Sprint-scoped by default. Publishing a Space-wide decision or gotcha from Sprint mode is a scope escalation and should require an explicit surface, not an accidental default.

Space Rules remain Space-scoped in v1. Sprint decisions may express Sprint-specific working agreements, but they do not override Space Rules.

`**` is the general marker for Space-wide escalation from Sprint mode across broadcast-capable surfaces. For discussion broadcasts, `*` means the current Sprint and `**` means the whole Space. In Sprint mode, `*` reaches only current Sprint members live; Space-mode members and members in other Sprints do not receive it live. Recipient rendering for Sprint-wide broadcasts should show Sprint context, for example `Sprint plugin-release: Alice says ...`. Recipient rendering for Space-wide broadcasts should show the escalation, for example `Space-wide from Alice: ...`, and may include sender context such as `Space-wide from Alice (plugin-release): ...`. The sender-facing output for Sprint-mode `*` must label the scope, for example `sent to Sprint <slug>`, and hint `use ** for Space-wide`. Sender-facing output for `**` must also label the scope, for example `sent Space-wide`. In Space mode, `*` remains accepted as Space-wide for backward compatibility, and `**` also resolves to Space-wide broadcast. `**` is live-interrupting for all Space members by design when used on a live notification surface, including members currently working inside Sprints.

The first experimental Sprint implementation should stay thin: membership, event stamping, monitor routing, Sprint-local claim conflicts, and status visibility. Roles, privacy, multi-Sprint membership, rich history UI, and cross-Sprint merge planning are deferred.

V1 Sprint command surface:

- `/teamem-sprint create "<display name>" -- <goal>`
- `/teamem-sprint join <slug-or-id>`
- `/teamem-sprint leave`
- `/teamem-sprint list`
- `/teamem-sprint history <slug-or-id>`
- `/teamem-sprint archive <slug-or-id>`
- `/teamem-sprint reopen <slug-or-id>`

Create accepts a human display name and derives the canonical slug, e.g. `"Plugin Release"` becomes `plugin-release`. Commands after creation should prefer the slug so users do not need quoted display names, while still accepting Sprint ids for ambiguity/debugging.

`/teamem-sprint history <slug-or-id>` is read-only, explicit, and non-live. It exposes Sprint lifecycle/audit history without adding archived or non-current Sprint history to ordinary update, status, or briefing streams. V1 history is lifecycle-focused by default; broad coordination-event history is deferred so the command does not become a noisy Sprint feed. Archive force-release cleanup entries are included as lifecycle-adjacent audit effects tied to archive, without including the full claim event stream. History output is capped by default, for example latest 50 lifecycle entries, with an explicit `--limit` bounded by a sane maximum.

There is no separate `/teamem-sprint use` or `/teamem-sprint off` in v1 because current Sprint is membership state. MCP tools mirror the command verbs: `teamem.create_sprint`, `teamem.join_sprint`, `teamem.leave_sprint`, `teamem.list_sprints`, `teamem.get_sprint_history`, `teamem.archive_sprint`, `teamem.reopen_sprint`, and `teamem.get_current_sprint`.

### Space mode

The Teamem operating mode for a member not currently joined to a Sprint. Space mode preserves the historical Space-wide behavior for monitoring and claim coordination so existing Spaces remain compatible without requiring Sprints.

### Member

A principal within a space. Has a `member_name` (the public-facing handle teammates see), a coordination preference, and a join state (`active`, `left`, `kicked`).

### Team lead (creator)

The member who created the space. Has additional permissions: kick, disband, rotate-room-code, wipe-history. Identified by `members.is_creator = 1`.

### Coordination handshake (hybrid protocol)

The protocol Teamem runs at the moment of a scope conflict, after `gate-claim.sh` would have denied the edit. Shape depends on the resolved coordination preference:

In Sprint mode, "scope conflict" means a claim collision within the same Sprint. Cross-Sprint overlaps are not blocking conflicts in v1, because different Sprints pursue different goals and should not serialize each other's work by default. In Space mode, the historical Space-wide conflict behavior remains.

| Mode | Protocol | Latency profile |
| - | - | - |
| `auto-skip` | **Async, active plugin mode.** PreToolUse denies immediately with an advisory hookSpecificOutput telling the latter to skip and proceed with other work. A `conflict_queued` event is recorded. Resolution is recoverable through `/teamem-status`, briefings, SessionStart sync/unread queues where applicable, and optional Channels. | Returns in tens of milliseconds. |
| `ask-claimant` | **Legacy/internal compatibility.** The server still has permission request/grant/deny primitives, but the active plugin gate no longer routes normal conflicts through this mode. | Not user-selectable. |
| `auto-discuss` | **Roadmap/legacy compatibility.** Backend dispute primitives remain for direct tool compatibility and manual cleanup, but watcher/negotiator subagents are postponed. Stale `auto-discuss` rows degrade to the queued `auto-skip` path in the plugin gate. | Not an active plugin runtime. |

**Legacy sync window rationale (60s):** for direct/internal permission-request use, the requester should not be held indefinitely while waiting for an incumbent response. Sixty seconds was the original balance: enough time for a real grant, short enough that the latter's Claude Code session does not look permanently stuck. The active plugin conflict path is queue-first instead.

**Server-side long-poll:** the wait lives on the server (single HTTP call held open up to 60s), not in the latter's shell. This guarantees timeout precision and avoids the shell-sleep antipattern.

**Mode 6.B sync gamble:** if the incumbent is AFK or their tool call doesn't surface the request fast enough, the 60s cap elapses and we fall through to `auto-skip`. The latter is never indefinitely blocked.

### Pending edit (skip queue)

A server-side record produced when a latter hits a conflict and falls through to `auto-skip`. Lives in a projection table `pending_edits` keyed on `(space_id, blocked_principal)`.

**Schema (domain):**

| Field | Meaning |
| - | - |
| `space_id` | Space scope. |
| `blocked_principal` | The latter — who is waiting. |
| `blocking_claim_id` | The incumbent's claim that triggered the queue entry. |
| `paths` | The paths the latter wanted to edit. |
| `intent` | Short free-text describing the latter's planned change (gate-claim's `intent` field). |
| `created_at` | When the queue entry was made. |
| `expires_at` | TTL: 24 hours after `created_at`. Stale entries are GC'd. |
| `resolved_at` | NULL until the entry is resolved (incumbent released or entry was cancelled). |

**Lifecycle events:**

- Enqueue: latter's gate-claim hook on `auto-skip` calls `teamem.queue_pending_edit(blocking_claim_id, paths, intent)`. Server appends a `conflict_queued` event and inserts into `pending_edits`.
- Resolve-on-release: when `release_scope` fires for `claim_X`, server scans `pending_edits` for rows whose `blocking_claim_id = claim_X` OR whose `paths` overlap the released scope. For each match, server emits `conflict_resolved` peer-event directed at `blocked_principal` with `payload: { pending_id, blocked_principal, blocking_claim_id, previously_blocked_paths, now_free: true }` and sets `resolved_at`. The event's top-level `principal` field is the **releaser** (e.g. alice — the one who fired the trigger); `payload.blocked_principal` is the **routing target** (e.g. bob). Auditors reading raw events should treat `payload.blocked_principal` as the recipient, not `principal`.
- Resolve-on-expiry: when lease expires server-side, same projection logic fires.
- Cancel: latter calls `/teamem-clear-queue` to remove their own entry; cleared rows produce no peer event.
- GC: a periodic sweep removes rows where `expires_at < now AND resolved_at IS NULL`.

**No auto-retry of the original Edit.** When a queued conflict resolves, Teamem records the event and makes the queue state visible through status/briefing surfaces, SessionStart sync/unread delivery where applicable, and optional Channels. The main agent decides whether and when to retry. Teamem does **not** synthesize a replay of the original Edit tool call.

### Queue visibility

`pending_edits` rows are visible to every member in the same coordination context, not just the blocked principal. Space remains the trust boundary, so explicit recovery/history views may inspect across contexts, but ordinary status and briefing stay context-scoped. Specifically:

- Incumbents see who is queued behind their claim. Surfaces in the briefing's `active_claims` block as `claim_id … blocking [bob waiting on src/auth/, carol waiting on src/auth/utils.ts]`. This gives the incumbent a social signal to release sooner if they've reached a natural stopping point.
- Other teammates in the same coordination context see the queue in `/teamem-briefing` so they understand the work-ordering picture.
- Only the blocked principal can call `/teamem-clear-queue` to cancel their own entry. Other teammates cannot dequeue someone else.

### Permission request (Mode 6.B mechanics, legacy/internal)

The latter's request to the incumbent for permission to edit a colliding scope. These server primitives remain for compatibility and manual/internal flows, but `ask-claimant` is no longer a selectable user-facing plugin coordination preference.

**Lifecycle:**

1. A direct/internal caller issues `teamem.request_edit_permission(blocking_claim_id, paths)`. Server appends a `permission_request` event with `request_id` (ULID).
2. Delivery is handled by current live/catch-up surfaces: optional Channels for live sessions, stored thread/status inspection, and SessionStart/unread paths where applicable. The old watcher subagent route is postponed.
3. **Default behavior:** the incumbent's *user* answers via slash command. The agent never auto-answers in v1.
4. **Configurable v2 extension:** a per-claim or per-space `auto_decide` flag delegates the decision to the incumbent's agent. Out of scope for v1.
5. Server long-polls the latter's `request_edit_permission` for up to 60s. On any of `granted`, `denied`, or `expired`, the long-poll returns.

**On grant (`/teamem-grant <req_id>`):**

Server runs one atomic transaction:
- Narrows the incumbent's claim by subtracting the requested paths from its `scope.paths`. (See "Split release" below.)
- Appends `scope_released` event for the carved-out subset only.
- Appends `scope_claimed` event for the latter on those paths.
- Fulfills the latter's long-poll with `{ ok: true, action: 'allow', claim_id, expires_at }`. The latter's PreToolUse returns 200 and the edit proceeds in the same tool call.

**On deny (`/teamem-deny <req_id>`):**

Deny is **not terminal** — it routes the latter through the standard `auto-skip` flow. Server:
- Marks the request as `denied` in the projection.
- Fulfills the long-poll with `{ ok: true, action: 'skip', reason: 'denied_by_incumbent', blocking_claim_id }`.
- Latter's PreToolUse hook treats this identically to `auto-skip`: enqueues a `pending_edit`, returns deny to the agent with the same advisory text. The latter will be notified normally when the incumbent releases.

**On timeout (no response within 60s):**

Same as deny — falls through to `auto-skip`. The request is marked `expired`. Late responses (e.g., incumbent clicks `/teamem-grant` after 60s) are rejected as already resolved and do not narrow the incumbent's claim. The latter must re-attempt the edit normally or send a new permission request.

**Idempotency:** each request carries a `request_id`. Once status is `granted`/`denied`/`expired`, subsequent response messages with the same id are recorded as historical but do not change state.

**Authorization on response:** only a member whose `principal` matches the incumbent of the cited `blocking_claim_id` may call `respond_permission_request`. Anyone else gets `403 not_incumbent`. Slash commands `/teamem-grant` and `/teamem-deny` are thin wrappers around this MCP call.

**Compatibility scope:** request payload is just `paths`. No back-and-forth negotiation in the request itself ("can you wait 10 min?"). Parties wanting that depth use direct discussion messages today; automated Mode 6.C negotiators are postponed.

### Split release

The server-side operation that carves a subset of paths out of an incumbent's active claim, leaving the remainder intact.

**Algorithm:**

1. Compute `narrowed_paths = original_claim.paths - requested_paths` using the same path-pattern overlap engine that powers `findOverlappingActiveClaims`.
2. Update the incumbent's `claims` projection row: `scope_json = JSON.stringify({ paths: narrowed_paths })`.
3. Append a `scope_released` event whose `payload.released_paths = requested_paths` (a new payload field — `scope_released` today only carries `claim_id`).
4. The incumbent's session keeps the same `claim_id`; only the claim's path set shrinks.

**Edge case — full subsumption:** if `requested_paths` exhausts `original_claim.paths` (or covers them via glob), `narrowed_paths` is empty and the operation degrades to full release: incumbent's claim is marked `released`, latter gets a fresh claim. Same code path.

**Edge case — disjoint paths:** if `requested_paths` does not actually overlap the incumbent's claim, `request_edit_permission` should never have routed to that incumbent in the first place. This is a server bug if it happens; reject with `400 no_overlap`.

### Dispute (Mode 6.C mechanics, roadmap/legacy)

A bounded, auto-driven negotiation between two `auto-discuss`-opted-in teammates' background negotiator agents. The backend substrate remains for compatibility and future roadmap work, but the current plugin build does not auto-open disputes or launch negotiator subagents on scope conflicts.

**Current plugin behavior:** if stale stored preferences resolve to `auto-discuss`, `gate-claim.sh` queues the edit with the same conservative `auto-skip` path and explains that auto-discuss automation is postponed. Direct calls to `teamem.open_dispute` remain a legacy/manual compatibility surface only.

**Move vocabulary (structured-only — no free-form posts in auto mode):**

| Move | Payload | Who can post |
| - | - | - |
| `propose_release_full` | none | latter, in opening turn |
| `propose_release_subset` | `{ paths: [...] }` | either side |
| `propose_release_after_task` | `{ wait_seconds: <N>, note?: string }` | incumbent only |
| `propose_swap` | `{ i_release: [paths], you_release: [paths] }` | either side |
| `accept` | `{ proposal_id }` | counterparty of an open proposal |
| `reject` | `{ proposal_id, reason: enum('busy'\|'too_costly'\|'wrong_paths') }` | counterparty |
| `concede_skip` | none | latter, unilateral fallthrough to auto-skip |

Each move is appended as a `discussion_posted` event with a structured payload; the dispute thread is therefore a normal discussion thread the rest of the team can read.

**`wait_seconds` is informational only — never drives state.** The value is shown to the latter so they know roughly how long the incumbent expects to need ("alice asks you to wait ~600s while she finishes"). Server does NOT schedule auto-release based on it; resolution still requires either an explicit `release_scope` from the incumbent (which fires the `auto-skip` resolve-on-release path) or an explicit follow-up move in the dispute thread. **Rationale:** LLMs fabricate ETAs; gating state on hallucinated wall-clock numbers is unsafe. The value sets human expectation; reality is driven by actual events.

**Termination — first wins among these four conditions, all four configurable on/off per space:**

| Condition | Behavior |
| - | - |
| **User override (5.3.C)** | Either party runs `/teamem-end-dispute <thread_id> <accept\|deny\|skip>` at any moment. Server applies chosen outcome, appends `dispute_user_terminated`, closes the thread. |
| **Explicit agreement (5.3.A)** | An `accept` move is posted on an open proposal. Server applies the agreed outcome (release/split/swap/wait), appends `dispute_resolved`, closes. |
| **Round-trip cap (5.3.D, default N=4)** | After 4 total negotiator turns across both sides without an `accept`, server appends `dispute_max_turns`, falls through to `auto-skip`. |
| **Wall-clock cap (5.3.B, default 5min)** | Backstop for stalled negotiators. Server appends `dispute_timeout`, falls through to `auto-skip`. |

Each space can disable any subset of the four conditions (`team.dispute_terminations_enabled = ['user_override', 'explicit', 'turns', 'wallclock']` by default). At least one MUST remain enabled (likely `wallclock`) to prevent infinite disputes; server validates this on space config update.

**Roadmap auto-negotiator tool surface:** if the postponed `teamem-negotiator-auto` subagent returns, its only state-mutation tool should be `teamem.dispute_post_move(thread_id, move_type, payload)`. The server validates each move against the dispute state machine: cannot accept a non-existent proposal, cannot post twice in a row from the same side, cannot post after termination. Illegal moves are `409 invalid_move`. The auto-negotiator should have NO access to `claim_scope`, `release_scope`, `publish_event`, or `record_decision` — its only world is the dispute thread.

**Visibility:** dispute threads are visible in `/teamem-status` and `/teamem-briefing` for the current coordination context. Explicit history/recovery views may inspect across contexts because Space remains the trust boundary. This helps identify recurring conflict patterns without turning ordinary Sprint briefing into an all-Space feed.

### Identity model

A teammate is identified by a `(space_id, member_name)` pair. There is no global account, no cross-space identity, no SSO, no email. A single human running two laptops can join the same space twice with different names; this is an acceptable trade for keeping the model simple.

**`member_name` resolution at setup time:**

1. Suggest `git config --global user.name` if available.
2. Fall back to `$USER` / `whoami`.
3. **Sanitize generic values:** if step 2 returns one of `root|ubuntu|admin|user|nobody`, refuse the default and force the user to type a name. This prevents shared-host deployments from auto-naming everyone `ubuntu`.
4. The user can always override the suggestion with free text.
5. **Per-space uniqueness** is enforced by `members(space_id, name) WHERE left_at IS NULL` partial unique index.

**`member_name` is immutable in v1.** If a teammate needs to change their name, they leave and rejoin. Renames require a `member_renamed` event type, briefing-renderer collapsing logic, and migration of historical claims/decisions/discussions; deferred to v2.

### Server URL

The address of the team's bridge server. Each teammate inputs the server URL during setup (today's behavior, kept). 

**Open tension:** asking each teammate for the server URL is friction the team lead could eliminate by encoding the URL into the room code (rejected — see ADR placeholder below) or by publishing it in the marketplace's metadata (rejected — couples plugin distribution to server location). v1 keeps per-teammate input; v2 may revisit if onboarding friction compounds.

**v2 follow-up:** server URL configurable via space-level `space.config.server_url_advisory` (informational only) so that any teammate joining a space can see "the canonical URL is X" rather than guessing or DM'ing the team lead.

### JWT and room code lifecycle

| Token | Default TTL | Rotation |
| - | - | - |
| Room code | 30 days | Manual via `bun run space rotate-code`. Configurable per server in v2. |
| Member JWT | 30 days | Re-issued on each `bun run setup` join. No auto-refresh; expired JWT means re-join via room code. |

Long-lived JWT is acceptable because:
- Membership in a space is intentionally durable (you're in alice's team for the project lifetime, not for one workday).
- Lost-credential blast radius is bounded by room-code TTL (the lost JWT cannot grant new memberships, only acts as the existing member it was issued for).
- Adding refresh tokens is significant complexity for a problem the model doesn't have.

### Architecture decisions (formal records)

The ADRs in `.docs/adr/` capture the design choices that this glossary references:

- [ADR-0001](.docs/adr/0001-per-teammate-coord-prefs-incumbent-wins.md) — Per-teammate coordination preferences with incumbent-wins resolution.
- [ADR-0002](.docs/adr/0002-mode-6c-structured-moves.md) — Mode 6.C dispute uses a structured move vocabulary.
- [ADR-0003](.docs/adr/0003-plugin-bundle-not-npm.md) — Ship the plugin runtime as a checked-in `bun build` bundle, not an npm package.
- [ADR-0004](.docs/adr/0004-disband-7d-soft-tombstone.md) — Disband is a 7-day soft tombstone with restore + GC.
- [ADR-0005](.docs/adr/0005-detect-conflicts-removed-v1.md) — Remove `teamem.detect_conflicts` from the v1 public surface.
- [ADR-0006](.docs/adr/0006-claude-only-v1.md) — v1 ships Claude Code only.
- [ADR-0007](.docs/adr/0007-two-pr-split.md) — v1 lands as two PRs (Foundation, then Coordination).
- [ADR-0008](.docs/adr/0008-claim-lifecycle-git-driven.md) — Claim lifecycle is driven by git evidence and explicit release semantics.
- [ADR-0009](.docs/adr/0009-npm-bootstrapper-github-marketplace.md) — npm ships a bootstrapper for the GitHub-hosted Claude Code marketplace, not the plugin runtime.
- [ADR-0010](.docs/adr/0010-teamem-aware-claude-launcher.md) — Replace `teamem cc` with an opt-in Teamem-aware Claude launcher.
- [ADR-0011](.docs/adr/0011-sprint-context-boundary.md) — Add Sprint as an experimental context boundary for monitoring and claim coordination.

### Open ADR candidates (capture later)

- **Server URL not encoded in room code.** We considered encoding `{srv, code}` as a base64 payload to remove a setup prompt. Rejected to keep room codes as short, copy-friendly 8-char nanoids. Trade: each teammate types the server URL during setup. Worth an ADR if/when we revisit.

### Distribution model

The plugin is **self-contained** — every file the marketplace cache needs lives under `plugin/`. There is no `userConfig.teamem_root`, no path-back-to-source, no external runtime dependency.

**Build flow:**

```bash
bun run build:plugin
# bun build src/bridge/index.ts \
#   --outfile plugin/lib/bridge.js \
#   --target bun \
#   --external bun:sqlite
```

`src/` remains the canonical home of the bridge/server runtime. `plugin/lib/bridge.js` is a checked-in build artifact produced from `src/`. CI (or a `prepublish` hook) regenerates it before any marketplace push so the artifact is always in sync with `src/`.

**`plugin/.mcp.json`:**

```json
{ "mcpServers": { "teamem": { "command": "bun", "args": ["run", "${CLAUDE_PLUGIN_ROOT}/lib/bridge.js"] } } }
```

No `${user_config.teamem_root}` substitution. No path-back-to-source. The plugin works on any machine that has Bun installed and runs the marketplace install.

**`bun:sqlite` stays external** — Bun provides it natively at runtime; bundling it would error.

**Plugin scripts absorb the hook library.** Today's `plugin/scripts/gate-claim.sh` delegates to `${TEAMEM_ROOT}/hooks/lib/gate-claim-scope.sh`. The new design absorbs that logic into `plugin/scripts/` directly, removing the path-back-to-source dependency for hooks too.

### Deprecated distribution paths (pre-v2 cleanup)

The PoC carried two redundant distribution paths that overlap the plugin. Both are deleted, no backward compatibility.

- **Standalone hook installer (`bun run hook-install`).** The plugin is now the only Claude Code integration. Manual `~/.claude/settings.json` hook wiring is no longer supported.
- **v1.5 daemon (`bun run bridged`).** The plugin spawns a fresh bridge per MCP session; ~200ms spawn is acceptable and the daemon's hot-cache benefit is dominated by server round-trip cost. The daemon was designed for the standalone hook installer flow and has no plugin-flow benefit.

Both removals are clean since v1 is pre-release; v2 is the first formal release line.

### Server hosting

The team lead runs the bridge server on a host of their choice. v1 supports two install paths; v2 will add a published Docker image (`ghcr.io/rubiyh/teamem`).

| Path | Use case | Command |
| - | - | - |
| `docker compose up -d --build` from cloned repo | Production, stable, same image every team gets | `git clone … && cd teamem && docker compose up -d --build` |
| `bun run server` from cloned repo | Hobbyist, single-node testing, no Docker | `git clone … && cd teamem && bun install && bun run server` |

Both paths start from `git clone`. v1 does not publish a pre-built image. The migration runner auto-applies pending migrations on every server start, so upgrades are `git pull && docker compose up -d --build` (or the bare-bun equivalent).

### Wipe (point #8 first half)

The team lead's verb for "lose this space's history but keep the team active." Implemented as a layered design — soft by default, hard with explicit opt-in.

**`bun run space wipe <space_id>` (default, soft):**

- Appends a `space_wiped` event with `wiped_at`, `wiped_by`, optional `reason`.
- Projection layer respects the marker: `getBriefing`, `get_updates`, `read_thread`, etc. ignore all events with `timestamp < wiped_at`.
- Raw `events` rows are **retained** for audit / forensics / accidental-wipe recovery.
- Recoverable via `bun run space unwipe <space_id>` until a hard wipe is run.
- Briefing returns empty for everything before the wipe; new events accrue normally.

**`bun run space wipe <space_id> --hard` (explicit, irreversible):**

- Hard `DELETE` from the events table for the space.
- Hard `DELETE` from all projection tables (claims, decisions, blockers, discussions, contracts, cursors, task_state, pending_edits).
- The `spaces` row and `members` rows are kept; the team is still alive, just amnesiac.
- Required for compliance ("delete user data" requests).
- No recovery.
- Server prompts for typed confirmation before executing (the space label, similar to disband today).

**Why two layers:** soft wipe is the safe default for "let's start the year fresh" workflows. Hard wipe is the escape hatch for compliance / paranoia. A team lead who runs `wipe` without `--hard` retains an undo button; a team lead who needs GDPR-compliant data deletion has a clear path. No one accidentally hard-deletes by typo.

### Disband (point #8 second half)

The team lead's verb for "end this team." Soft-delete with a 7-day grace window.

**`bun run space disband <space_id>`:**

1. Sets `spaces.disbanded_at = now`.
2. Auth middleware immediately rejects all member JWTs for that space with `410 space_disbanded`. Members see "the space was disbanded; you've been removed."
3. Data is **retained** for 7 days.
4. Team lead can run `bun run space restore <space_id>` within the 7-day window — sets `disbanded_at = NULL`, JWTs work again, data intact.
5. After 7 days, a periodic GC job hard-deletes the space's data (events, all projections, members, room codes). The `spaces` row is also removed at this point. The space is gone forever.

**7-day grace rationale:** "I disbanded by mistake on Friday, want to undo Monday" is the realistic recovery window. Longer than 7d means abandoned spaces accumulate; shorter means a teammate going on vacation might miss the recovery window.

**Wipe vs disband are independent verbs.** Wipe loses history but keeps the team alive. Disband ends the team but keeps history (briefly). A team lead who wants both does both, in either order; combining them is just two commands.

### Kick (subset of disband, single-member version)

The team lead's verb for "remove one member from the active space."

**`bun run space kick <member_name>`:**

1. Sets `members.left_at = now` for the named member.
2. Auth middleware joins on `members.left_at IS NULL` (already in place at `src/server/auth.ts:62-66`) — kicked member's next API call rejects with **`401 member_left`** (the auth layer cannot distinguish kick from voluntary leave because both flip the same column; this matches the existing AC8 contract). UX layer can render "you were kicked by the team lead" using the `left_at` direction (creator-initiated vs self-initiated) when needed.
3. Bridge surfaces the typed error to the kicked teammate's CLI: *"You were removed from space `<label>` by the team lead. Run `bun run setup` to join a new space."*
4. The kicked member's claims and queue entries are released by GC sweep within the next minute.

**Auth middleware status (corrected by consensus, 2026-05-03):** `src/server/auth.ts:62-66` already JOINs on both `m.left_at IS NULL` and `s.disbanded_at IS NULL`. The kick path is **already correct** — kicked members reject on next API call without any code change. v1's deliverable here is a regression test asserting the JOIN remains intact and the kick → 403 path is exercised; **not** a code fix. The Architect found the original "buggy middleware" framing was factually wrong; the Critic verified.

**Authorization:** only members where `is_creator = 1` can call `kick`, `disband`, `wipe`, `wipe --hard`, or `restore`. Server enforces via `requireCreator` middleware that already exists.

### Information sharing primitives (vision point #7)

The set of typed tools agents use to share team-level information. v1 ships four primitives; v2 adds free-form direct messaging and per-finding subscriptions.

| Primitive | Tool | Purpose | Lifecycle |
| - | - | - | - |
| Decision | `record_decision` | Policy / architecture choices. Plan-kind decisions supersede prior plan decisions. | Persistent, supersession-aware. |
| Finding | `share_finding` | Situational discoveries during work, tag-faceted. | Auto-expire 7 days; until then surfaced in briefing. |
| Focus | `agent_focus_changed` | Agent's current working scope. Replaces synthesized `task_started`/`task_progressed`/`task_completed` from hooks. | Per-claim, deduped within 60s in projection. |
| Artifact | `share_artifact` | Reference to a produced thing (spec, fixture, doc, snippet). | Persistent; no expiration. |

**v2 extensions:**

- Free-form direct messaging (`post_message` / `read_thread`) — active through `/teamem-discuss` and normal MCP calls. Channels can deliver live directed/broadcast messages; `teamem.read_thread` remains the durable fallback.
- Per-finding subscriptions (`teamem.subscribe(tags)`) — future work. Current gotchas/findings surface through briefings, SessionStart sync, targeted notices, and optional Channels.

**`share_finding` schema:**

```ts
{
  summary: string,        // one-line, shown in briefing and short gotcha notices
  body?: string,          // optional longer detail
  tags: string[],         // free-form, e.g. ['auth', 'security', 'toctou']
  severity: 'info' | 'warning' | 'urgent',
  refs?: { paths?: string[], modules?: string[] }
}
```

Stored as a new `finding_shared` event type. Briefing renders findings in a new `recent_findings` dimension. Gotchas/findings can also emit lightweight notices through SessionStart sync and optional Channels; recipients fetch full detail by id.

**`agent_focus_changed` schema:**

```ts
{
  scope: { paths?, modules?, contracts? },
  intent: string         // short free-text from the gate-claim hook
}
```

Hook fires this whenever the latest `claim_scope` carries a scope distinct from the prior claim in the same session. Server-side projection dedupes within a 60-second window — multiple rapid claims (e.g., a tool batch) collapse to one focus event in the briefing.

**`share_artifact` schema:**

```ts
{
  kind: 'spec' | 'fixture' | 'doc' | 'snippet',
  uri: string,           // repo-relative path, http(s) URL, or `data:` for inline
  title: string,
  summary?: string
}
```

Stored as a new `artifact_shared` event type. Briefing renders in a new `recent_artifacts` dimension. No expiration — artifacts are deliberate, durable references.

### Removed surface

- **`teamem.publish_event`** — removed from the bridge tool surface in v1. Kept as a server-internal `store.append(event)` API for projection rebuild and for typed primitives themselves to call. Hook scripts no longer use it; they call typed primitives directly.
- **Synthetic `task_started` / `task_progressed` / `task_completed`** — removed. Replaced by `agent_focus_changed`. The events themselves remain in the EVENT_TYPES enum for backward read of any historical events, but no v1 code path generates them.

### Removed surface (continued)

- **`teamem.detect_conflicts`** — removed in v1. Documented in the agent-prompt snippet as a TOCTOU footgun the agent should never use as a gate; with `claim_scope` now the only legitimate path, the tool is dead weight that invites misuse. v2 may reintroduce a hardened pre-claim probe (e.g., combined detect+claim atomicity) if real workflows surface a need for batch-planning queries.
