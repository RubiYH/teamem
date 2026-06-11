BEGIN;

-- Issue #10 — Mode 6.A auto-skip queue (CONTEXT.md "Pending edit (skip queue)").
--
-- A pending_edits row is created when a latter hits a foreign-claim conflict
-- and the resolved coord-pref is `auto-skip`. The server-side `releaseScope`
-- and lease-expiry sweeps scan this table and emit `conflict_resolved` peer
-- events to every blocked latter whose paths overlap the released scope.
--
-- Lifecycle:
--   - Inserted by `teamem.queue_pending_edit` after the latter's gate-claim
--     resolves to auto-skip. Same transaction also appends a
--     `conflict_pending` event to the event log.
--   - resolved_at set by the resolve-on-release scan in `releaseScope` (when
--     blocking_claim_id matches OR paths overlap the released scope) or by
--     the lease-expiry projection sweep.
--   - Deleted by GC sweep when expires_at < now AND resolved_at IS NULL.
--   - Deleted by the latter's own /teamem:clear-queue (own rows only).
--
-- Visibility: every member of the space sees pending_edits via getBriefing
-- so incumbents see who is queued behind their claims and other teammates
-- see the work-ordering picture (CONTEXT.md "Queue visibility").
--
-- Tombstoning (`tombstoned_at`) follows the soft-wipe pattern (slice #7
-- migration 013); future projection tables MUST include it. We add it
-- alongside the rest of the schema so the soft-wipe scan picks us up.

CREATE TABLE IF NOT EXISTS pending_edits (
  pending_id        TEXT PRIMARY KEY,
  space_id          TEXT NOT NULL REFERENCES spaces(id),
  blocked_principal TEXT NOT NULL,
  blocking_claim_id TEXT NOT NULL,
  paths_json        TEXT NOT NULL,           -- JSON-encoded array of path patterns
  intent            TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at        TEXT NOT NULL,           -- created_at + 24h, set by tool
  resolved_at       TEXT,
  source_event_id   TEXT NOT NULL,
  tombstoned_at     TEXT
);

-- Hot-path: resolve-on-release scans by (space_id, blocking_claim_id) for
-- direct match and by (space_id, blocked_principal) for the "overlap any
-- path" branch. Index covers both.
CREATE INDEX IF NOT EXISTS idx_pending_edits_space_blocking
  ON pending_edits(space_id, blocking_claim_id)
  WHERE resolved_at IS NULL AND tombstoned_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_pending_edits_space_principal
  ON pending_edits(space_id, blocked_principal)
  WHERE resolved_at IS NULL AND tombstoned_at IS NULL;

-- GC sweep — find rows whose expires_at has passed and are still unresolved.
CREATE INDEX IF NOT EXISTS idx_pending_edits_gc
  ON pending_edits(expires_at)
  WHERE resolved_at IS NULL AND tombstoned_at IS NULL;

COMMIT;
