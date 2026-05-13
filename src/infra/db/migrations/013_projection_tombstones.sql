-- Migration 013: projection tombstones for soft-wipe (slice #7).
--
-- Soft-wipe sets `tombstoned_at = now` on every projection row in a space and
-- appends a `space_wiped` event. Briefing / read queries gain a
-- `WHERE tombstoned_at IS NULL` filter so tombstoned data is hidden but
-- recoverable. `unwipeSpace` clears tombstones whose timestamp matches the
-- most recent `space_wiped` event, restoring pre-wipe state.
--
-- `events`, `cursors`, and `members` are intentionally NOT tombstoned:
--   - events  — the event log is the source of truth; tombstoning rows there
--               would corrupt projection rebuild semantics.
--   - cursors — per-actor read offsets; not user-visible state.
--   - members — auth-layer concern (live membership / kick).
--
-- Future projection tables added by later slices (#10 pending_edits,
-- #12 disputes, #13 findings, #14 artifacts, #15 focus) MUST include
-- `tombstoned_at TIMESTAMP` at table-create time. Their slice migrations are
-- responsible — this migration only patches tables that exist today.

ALTER TABLE claims      ADD COLUMN tombstoned_at TEXT;
ALTER TABLE decisions   ADD COLUMN tombstoned_at TEXT;
ALTER TABLE blockers    ADD COLUMN tombstoned_at TEXT;
ALTER TABLE discussions ADD COLUMN tombstoned_at TEXT;
ALTER TABLE contracts   ADD COLUMN tombstoned_at TEXT;
ALTER TABLE task_state  ADD COLUMN tombstoned_at TEXT;
