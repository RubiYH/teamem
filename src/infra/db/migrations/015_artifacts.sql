-- Migration 015: artifacts projection (slice #14).
--
-- An "artifact" is a typed reference to a produced thing — a spec doc, a
-- test fixture, a long-form prose explainer, a code snippet — that one
-- teammate produces and wants the rest of the team to be able to find via
-- the briefing. Unlike findings (slice #13) artifacts are persistent: no
-- TTL, the briefing surfaces them until they are tombstoned by soft-wipe.
--
-- Watcher classifier behavior: `artifact_shared` events are IGNORED by
-- default (no auto-ALERT). Artifacts are pull-through-briefing — the
-- consumer asks "what specs/fixtures/docs has the team produced lately"
-- and the briefing's `recent_artifacts` field answers.

CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id       TEXT PRIMARY KEY,
  space_id          TEXT NOT NULL,
  principal         TEXT NOT NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('spec', 'fixture', 'doc', 'snippet')),
  uri               TEXT NOT NULL,
  title             TEXT NOT NULL,
  summary           TEXT,
  created_at        TEXT NOT NULL,
  source_event_id   TEXT NOT NULL,
  tombstoned_at     TEXT
);

-- Briefing hot path: SELECT … WHERE space_id = ? AND tombstoned_at IS NULL
-- ORDER BY created_at DESC.
CREATE INDEX IF NOT EXISTS idx_artifacts_active
  ON artifacts(space_id, created_at, tombstoned_at);
