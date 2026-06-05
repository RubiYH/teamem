ALTER TABLE focus ADD COLUMN sprint_id TEXT;

CREATE INDEX IF NOT EXISTS idx_focus_dedup_by_sprint
  ON focus(space_id, sprint_id, principal, scope_hash, started_at DESC)
  WHERE tombstoned_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_focus_recent_by_sprint
  ON focus(space_id, sprint_id, started_at DESC)
  WHERE tombstoned_at IS NULL;
