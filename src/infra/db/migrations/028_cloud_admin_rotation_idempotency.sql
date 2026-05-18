-- Migration 028: idempotency records for Teamem Cloud admin room-code rotation.

CREATE TABLE IF NOT EXISTS cloud_admin_room_code_rotations (
  idempotency_key TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  control_plane_space_id TEXT NOT NULL,
  room_code TEXT NOT NULL,
  request_json TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS cloud_admin_room_code_rotations_space_idx
  ON cloud_admin_room_code_rotations(space_id, control_plane_space_id);
