ALTER TABLE claims ADD COLUMN repo_id TEXT NOT NULL DEFAULT '';
ALTER TABLE claims ADD COLUMN branch TEXT NOT NULL DEFAULT '';
ALTER TABLE claims ADD COLUMN head_sha_at_acquire TEXT;
ALTER TABLE claims ADD COLUMN last_edit_at TEXT;
ALTER TABLE claims ADD COLUMN paused_at TEXT;
ALTER TABLE claims ADD COLUMN paused_reason TEXT;
ALTER TABLE claims ADD COLUMN auto_release_mode TEXT NOT NULL DEFAULT 'on_commit';
ALTER TABLE claims ADD COLUMN path TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_claims_scope ON claims(space_id, repo_id, branch, path);
