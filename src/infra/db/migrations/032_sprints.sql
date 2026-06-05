CREATE TABLE IF NOT EXISTS sprints (
  sprint_id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  slug TEXT NOT NULL,
  display_name TEXT NOT NULL,
  goal TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  archived_at TEXT,
  archived_by TEXT,
  source_event_id TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sprints_space_slug
  ON sprints(space_id, slug);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sprints_space_display_name
  ON sprints(space_id, display_name);

CREATE INDEX IF NOT EXISTS idx_sprints_space_status
  ON sprints(space_id, status, created_at);

CREATE TABLE IF NOT EXISTS sprint_memberships (
  space_id TEXT NOT NULL REFERENCES spaces(id),
  principal TEXT NOT NULL,
  sprint_id TEXT REFERENCES sprints(sprint_id),
  joined_at TEXT,
  updated_at TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  PRIMARY KEY (space_id, principal)
);

CREATE INDEX IF NOT EXISTS idx_sprint_memberships_sprint
  ON sprint_memberships(space_id, sprint_id);
