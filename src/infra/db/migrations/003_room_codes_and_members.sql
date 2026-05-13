BEGIN;

-- New tables for multi-tenant spaces + room-code join flow

CREATE TABLE IF NOT EXISTS spaces (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  creator_member_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  disbanded_at TEXT
);

CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  name TEXT NOT NULL,
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  left_at TEXT,
  is_creator INTEGER NOT NULL DEFAULT 0
);

-- Partial unique index: same name allowed after kick/leave (left_at IS NOT NULL).
-- This is the same-name-after-kick contract (plan §2 functional req 2, AC6).
CREATE UNIQUE INDEX IF NOT EXISTS idx_members_space_name_active
  ON members(space_id, name) WHERE left_at IS NULL;

-- Index for revocation hot-path: verify member is still active on every request.
CREATE INDEX IF NOT EXISTS idx_members_space_id
  ON members(space_id);

CREATE TABLE IF NOT EXISTS room_codes (
  space_id TEXT PRIMARY KEY REFERENCES spaces(id),
  code TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

-- Rename repo_id → space_id across all 7 projection tables.
-- SQLite RENAME COLUMN requires SQLite >= 3.25.0 (Bun ships >= 3.42).

ALTER TABLE events RENAME COLUMN repo_id TO space_id;
ALTER TABLE claims RENAME COLUMN repo_id TO space_id;
ALTER TABLE decisions RENAME COLUMN repo_id TO space_id;
ALTER TABLE blockers RENAME COLUMN repo_id TO space_id;
ALTER TABLE contracts RENAME COLUMN repo_id TO space_id;
ALTER TABLE cursors RENAME COLUMN repo_id TO space_id;
ALTER TABLE task_state RENAME COLUMN repo_id TO space_id;

-- Drop old indexes that reference repo_id column name and recreate with space_id.
DROP INDEX IF EXISTS idx_events_repo_timestamp;
DROP INDEX IF EXISTS idx_events_repo_type_ts;

CREATE INDEX IF NOT EXISTS idx_events_space_timestamp
  ON events(space_id, timestamp);

CREATE INDEX IF NOT EXISTS idx_events_space_type_ts
  ON events(space_id, event_type, timestamp DESC);

COMMIT;
