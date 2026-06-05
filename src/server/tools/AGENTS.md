<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-01 | Updated: 2026-06-02 -->

# tools

## Purpose

Implementation of the server-side `teamem.*` tool handlers. `createTeamemTools({ db, store })` returns a single object containing every tool handler; the registry in `../tool-registry.ts` then maps MCP-namespaced names to these methods.

## Key Files

| File              | Description                                                                                                    |
| ----------------- | -------------------------------------------------------------------------------------------------------------- |
| `index.ts`        | `createTeamemTools` factory + `TeamemTools` type. Wires event, briefing, claim, decision, discussion, finding, artifact, permission, dispute, space, and focus handlers |
| `briefing.ts`     | `buildBriefing(db, input)` — five-dimension briefing (current_plan, active_claims, recent_decisions, active_risks, recent_progress) with AC17 token-budget truncation |
| `briefing-schema.ts` | `BriefingResponseSchema` Zod schema + `BriefingResponse` type |

## For AI Agents

### Working In This Directory

- Every handler returns `ToolResponse<T>` — the `{ ok: true, data }` / `{ ok: false, error }` discriminated union from `../types.ts`. Never throw out of a handler; wrap with `toolError(...)`.
- `publishEvent` is the only handler that runs `validateEvent`. Helpers like `claimScope` construct events internally and trust their own input shape — schema validation only runs on the public `publishEvent` boundary.
- `claimScope` and lifecycle peers use ULID-backed helpers from `src/domain/ids.ts` for event IDs, claim IDs, and idempotency keys. Do not reintroduce `Date.now()` IDs.
- Conflict checks for edit gating are part of the claim lifecycle path. Keep overlap and path logic in sync with `src/domain/conflicts/` and the claim lifecycle tests.
- Decision handlers must keep event emission and projection updates in the same transaction when they mutate projections.

### Testing Requirements

- Add a happy-path test in `tests/integration/tools/teamem-tools.test.ts`.
- Add an edge-case test (invalid input, idempotent replay, empty state) in `tests/integration/tools/teamem-tools-edge-cases.test.ts`.
- Conflict-signal enrichment lives in `tests/integration/tools/conflict-signals.test.ts`.

### Common Patterns

- The factory uses an object literal of arrow methods so `this` is never relied on.
- Each handler gathers DB rows with `db.query(...).all/get(...)` then maps to typed shapes inside the response.

## Dependencies

### Internal

- `../../domain/events/{validate,types}.ts`
- `../../domain/conflicts/{engine,config}.ts`
- `../../infra/db/sqlite-event-store.ts`
- `../../infra/projections/apply-event.ts`
- `../errors.ts`, `../types.ts`

### External

- `bun:sqlite` (type-only `Database`)

<!-- MANUAL: -->

## Update 2026-05-05 — claim-lifecycle v2

Tool surface includes the claim lifecycle additions (PRD #27, slices #28–#37):

- `claimScope` (branch-aware payload + repo_id canonicalization + auto_release_mode + idempotency-recovery)
- `releaseScope`
- `releaseScopeViaGit` (post-commit hook entrypoint — uses `EXISTS(json_each(scope_json.paths))` for multi-path lookup)
- `pauseClaimsForBranch`, `resumeClaimsForBranch` (post-checkout hook entrypoints — bulk UPDATE under `.immediate()` lock)
- `forceRelease` (escape hatch — guard inside the same txn as the emit)
- `listClaims`
- `fetchUnreadNotifications` (SELECT + UPDATE wrapped in `.immediate()` for exactly-once delivery)

### Atomicity invariant (PRD-mandated)

Every tool that emits an event MUST do so inside `db.transaction((args) => { ... }).immediate()(...)`. Bare `db.transaction()` is deferred (lock acquired on first write) — re-opens TOCTOU. `.immediate()` acquires SQLite RESERVED at txn start. The `event-emit + projection-update` pair must live in the same block; if you UPDATE a projection inline, the matching event-type handler must also exist in `src/infra/projections/apply-event.ts` so a rebuild reproduces the same state.

### ULID is in use

`newEventId`, `newClaimId`, and `newIdempotencyKey` from `src/domain/ids.ts` use ULID. Use those helpers, not raw `Date.now()`.

### Idempotency recovery — projection visibility is required

PRD §150: `expires_at` is NULL for `on_commit` and `manual_only`. The previous recovery guard `if (storedClaimId && storedExpiresAt)` was a stand-in for "is this a TTL claim?" but silently broke fresh-after-release re-claim once `expires_at` became nullable. Always consult the projection's `released_at` for terminality, not the stored event's `expires_at` truthiness.

Recovery must also verify the stored claim is still visible in the `claims`
projection. If an idempotency row and original event exist but the projection row
is missing, returning the stored `claim_id` creates invisible ownership that
`listClaims` cannot show. Treat the prior claim as stale and salt the
idempotency key so `claimScope` can create a fresh visible claim.

### Path lookup via `scope_json`, not `claims.path`

`claims.path` only stores `paths[0]`. Multi-path claims have additional paths only in `scope_json`. Any path-based WHERE filter MUST use `EXISTS (SELECT 1 FROM json_each(json_extract(scope_json, '$.paths')) je WHERE je.value = ?)`. See `releaseScopeViaGit` for the canonical pattern.

### Space Memory privacy and token budget rules

Rules, decisions, and gotchas are intentionally different surfaces. Rules sync into `TEAMEM.md`; decisions can replay with full text because they are team direction; gotchas stay lightweight by default. Briefing `recent_findings` must omit full gotcha bodies and must hide direct gotchas from non-recipients. `getFinding` must take the authenticated principal into account and return `finding_not_found` for a direct gotcha requested by a non-recipient.

Space Memory scopes stay distinct:

- **Space Rules** are the only Space Memory content replicated into local `TEAMEM.md`. Server state lives in SQLite; local `.teamem/` and `TEAMEM.md` are generated caches.
- **Gotchas** are persistent findings and should deliver short notices plus fetch-by-id, not full replay into `TEAMEM.md`.
- **Decisions** are durable direction changes with amendment/supersession semantics. They may be broadcast or replayed, but do not belong in `TEAMEM.md`.
- **Discuss** is persisted coordination conversation. Direct-thread visibility and reply authority are policy/security boundaries.

`teamem.export_space_rules_snapshot` is the snapshot export contract. Hard-wipe and disband-GC must delete `space_rules_snapshots`; soft-wipe should leave Space Rules durable.

### Gotcha acknowledgement version checks

`acknowledgeFinding` acknowledges a concrete finding version. If a caller asks to acknowledge a version greater than the current finding version, return `invalid_version`; do not silently acknowledge the latest version. This prevents agents from marking unseen future revisions as read.

### Relevance uses active focus as well as claims

Gotcha relevance for SessionStart notices should consider both active claims and recent focus paths (`focus.scope_paths_json`). Agents often have no current claim when a session starts, but their focus still describes what warnings are relevant.
