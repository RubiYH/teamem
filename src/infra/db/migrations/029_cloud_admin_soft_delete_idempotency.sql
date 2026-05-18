-- Migration 029: idempotency records for Teamem Cloud admin soft-delete.

CREATE TABLE IF NOT EXISTS cloud_admin_space_soft_deletions (
  idempotency_key TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  control_plane_space_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (
    reason IN ('owner_requested', 'quota_reclaim', 'operator_action')
  ),
  request_json TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS cloud_admin_space_soft_deletions_space_idx
  ON cloud_admin_space_soft_deletions(space_id, control_plane_space_id);
