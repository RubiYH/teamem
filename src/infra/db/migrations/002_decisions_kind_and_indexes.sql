-- Migration 002: decisions.kind column, task_state table, covering index

-- Add kind column to decisions table.
-- SQLite supports ADD COLUMN with DEFAULT but NOT NULL + DEFAULT requires care.
-- We use a safe pattern: add the column as nullable first, backfill, then rely on
-- application-level enforcement (the projection always supplies kind).
ALTER TABLE decisions ADD COLUMN kind TEXT NOT NULL DEFAULT 'architectural';

-- Add decided_by column (principal who recorded the decision)
ALTER TABLE decisions ADD COLUMN decided_by TEXT NOT NULL DEFAULT '';

-- Task state projection table
CREATE TABLE IF NOT EXISTS task_state (
  task_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  principal TEXT NOT NULL,
  status TEXT NOT NULL,
  what TEXT,
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  PRIMARY KEY (task_id, repo_id)
);

-- Covering index for standing_conflicts events scan (AC16 perf budget)
CREATE INDEX IF NOT EXISTS idx_events_repo_type_ts
  ON events(repo_id, event_type, timestamp DESC);
