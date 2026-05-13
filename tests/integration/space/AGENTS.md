<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-09 | Updated: 2026-05-10 -->

# space

## Purpose

Tests for space governance: creation, disband (soft + hard), restore within grace window, kick, and wipe operations. Verifies space lifecycle boundaries, grace-period semantics, and garbage collection behavior. Tests both the HTTP routes and underlying DB mutations.

## Key Files

| File | Description |
|------|-------------|
| `disband-grace.test.ts` | Full soft-disband + restore + GC lifecycle — JWT rejects 410, grace window, hard cascade after expiry |
| `disband-gc-orphan-check.test.ts` | GC orphan detection — claims/members without space row are not re-attached post-restore |
| `disband-gc-restore-race.test.ts` | Race condition: restore during GC vs GC hard-cascade |
| `wipe-all-projections.test.ts` | Wipe clears all projection rows (soft mode) or deletes irreversibly (hard mode) |
| `wipe-disband-composition.test.ts` | Wipe + disband together — both operations compose correctly |
| `wipe-hard.test.ts` | Hard wipe requires label_confirmation and deletes irreversibly |
| `wipe-soft.test.ts` | Soft wipe (default) creates tombstones; can be reversed with unwipe |
| `wipe-hard-idempotency.test.ts` | Hard wipe idempotency — second call on deleted space fails with correct error |
| `kick-takes-effect.test.ts` | Kick member removes member row; their JWT is rejected on next API call |

## For AI Agents

### Working In This Directory

- Import `setupAuthApp()` from `../auth/helpers.js` to boot HTTP server + SQLite.
- Call `POST /spaces`, `POST /spaces/disband`, `POST /spaces/restore` via helper `post(app, path, body, token)`.
- Assert `res.status` codes: 201 (created), 200 (ok), 410 (disbanded), 409 (already), 400 (invalid).
- Read projection tables directly from `db` to verify tombstone state and hard-cascade cleanup.
- Use `gcDisbandedSpaces(db)` to simulate the periodic GC sweep.

### Testing Requirements

- **Soft disband**: `disbanded_at` + `disbanded_grace_until` set; JWT rejects with 410; projections survive.
- **Restore within grace**: Flips `disbanded_at = NULL`; JWT works again; all data intact.
- **Grace expiry + GC**: After GC runs past grace window, restore fails with `expired`; hard cascade deletes rows.
- **Orphan safety**: If a claim has no space (orphaned), GC does not re-attach it during restore.
- **Wipe vs disband**: Wipe clears projections (soft) or deletes events (hard); disband gates JWTs. Both can be active.
- **Hard wipe**: Requires `label_confirmation` matching space label exactly; irreversible.
- **Kick**: Removes member row; next API call from that principal returns 401.
- **Projection inventory drift**: Every new space-scoped projection table must be added to both soft-wipe tombstoning and hard-wipe/disband-GC cascade coverage. Recent misses included `discussion_threads`, `decision_history`, `finding_acknowledgements`, and `unread_notifications`; keep `wipe-all-projections.test.ts` and `disband-gc-orphan-check.test.ts` in lockstep with schema migrations.

### Common Patterns

- Helper `bootstrap(app, member_name, label)` creates space and returns `{ space_id, jwt, label }`.
- Helper `seedClaim(db, space_id, claim_id)` inserts a claim for testing cascade + orphan scenarios.
- Helper `seedMembers(db, space_id, count)` creates extra members to test kick behavior.
- Verify state transitions: create → disband (410) → restore (200) → disband again → GC → restore (expired).

## Dependencies

### Internal

- `src/server/spaces.ts` (disband, restore, kick, wipe routes)
- `src/server/spaces.js` (gcDisbandedSpaces GC handler)
- `src/infra/db/` (projection tables)
- `../auth/helpers.ts` (setupAuthApp)

### External

- `bun:test`
- `hono` (test app)

<!-- MANUAL: -->
