ALTER TABLE claims ADD COLUMN sprint_id TEXT;
ALTER TABLE pending_edits ADD COLUMN sprint_id TEXT;
ALTER TABLE decisions ADD COLUMN sprint_id TEXT;
ALTER TABLE decision_history ADD COLUMN sprint_id TEXT;
ALTER TABLE findings ADD COLUMN sprint_id TEXT;
ALTER TABLE blockers ADD COLUMN sprint_id TEXT;

CREATE INDEX IF NOT EXISTS idx_claims_space_sprint_active
  ON claims(space_id, sprint_id, status, created_at)
  WHERE tombstoned_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_pending_edits_space_sprint_active
  ON pending_edits(space_id, sprint_id, blocking_claim_id)
  WHERE resolved_at IS NULL AND tombstoned_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_decisions_space_sprint_updated
  ON decisions(space_id, sprint_id, updated_at DESC)
  WHERE tombstoned_at IS NULL;
