-- Migration 025: explicit decision lifecycle history + current-state columns

ALTER TABLE decisions ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE decisions ADD COLUMN latest_event_type TEXT NOT NULL DEFAULT 'decision_recorded';
ALTER TABLE decisions ADD COLUMN superseded_by_decision_id TEXT;
ALTER TABLE decisions ADD COLUMN superseded_at TEXT;
ALTER TABLE decisions ADD COLUMN body TEXT;

CREATE TABLE IF NOT EXISTS decision_history (
  source_event_id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  lifecycle_event TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  body TEXT,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  decided_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  predecessor_decision_id TEXT,
  superseded_by_decision_id TEXT,
  tombstoned_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_decision_history_space_created
  ON decision_history(space_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_decision_history_decision_version
  ON decision_history(space_id, decision_id, version DESC);
