-- Migration 031: mark runtime-internal Cloud members separately from users.
--
-- The Cloud bootstrap member is a runtime implementation detail. Free-plan
-- member caps count user-facing runtime identities only, so bootstrap rows
-- need an explicit marker instead of relying on their display name.

CREATE TABLE IF NOT EXISTS member_system_markers (
  member_id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  marker TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO member_system_markers (member_id, space_id, marker)
SELECT creator_member_id, id, 'cloud_bootstrap'
  FROM spaces
 WHERE cloud_provisioning_source = 'teamem-cloud';

CREATE INDEX IF NOT EXISTS idx_member_system_markers_space
  ON member_system_markers(space_id);
