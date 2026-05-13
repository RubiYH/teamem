BEGIN;

-- Issue #15 — agent focus events with scope-hash dedup.
--
-- Replaces the synthesized task_started/task_progressed/task_completed events
-- (those event types stay in the enum for historical reads only). Each row
-- captures one focus shift; rapid same-scope claims within 60s collapse to
-- the most-recent row by `(space_id, principal, scope_hash)`. Mode 6.B grant
-- path bypasses the dedup so the post-narrow focus is always recorded.
--
-- `tombstoned_at` is included at create time per ADR-0001 / slice #7 contract:
-- soft-wipe owns lifecycle for projection rows. The composite index covers
-- the hot dedup probe (most-recent per `(space_id, principal, scope_hash)`
-- ordered by started_at desc).

CREATE TABLE IF NOT EXISTS focus (
  focus_id          TEXT PRIMARY KEY,
  space_id          TEXT NOT NULL REFERENCES spaces(id),
  principal         TEXT NOT NULL,
  scope_paths_json  TEXT NOT NULL,           -- JSON-encoded sorted, normalized paths
  scope_hash        TEXT NOT NULL,           -- stable hash of scope_paths_json
  intent            TEXT,
  started_at        TEXT NOT NULL DEFAULT (datetime('now')),
  source_event_id   TEXT NOT NULL,
  tombstoned_at     TEXT
);

-- Dedup probe — find the most recent row for `(space_id, principal,
-- scope_hash)`. Including `started_at` so the index covers the
-- `ORDER BY started_at DESC LIMIT 1` query without a sort.
CREATE INDEX IF NOT EXISTS idx_focus_dedup
  ON focus(space_id, principal, scope_hash, started_at DESC)
  WHERE tombstoned_at IS NULL;

-- Briefing read — recent_progress dimension wants the most recent focus
-- per principal across all scope_hashes.
CREATE INDEX IF NOT EXISTS idx_focus_recent_per_principal
  ON focus(space_id, principal, started_at DESC)
  WHERE tombstoned_at IS NULL;

COMMIT;
