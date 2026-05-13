BEGIN;

CREATE TABLE IF NOT EXISTS space_rules_snapshots (
  space_id TEXT PRIMARY KEY REFERENCES spaces(id),
  rules_markdown TEXT NOT NULL,
  rules_version INTEGER NOT NULL DEFAULT 1,
  is_disabled INTEGER NOT NULL DEFAULT 0,
  source_event_id TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_by_member_id TEXT REFERENCES members(id)
);

CREATE INDEX IF NOT EXISTS idx_space_rules_snapshots_updated_at
  ON space_rules_snapshots(updated_at);

COMMIT;
