CREATE TABLE IF NOT EXISTS unread_notifications (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  space_id    TEXT NOT NULL,
  principal   TEXT NOT NULL,
  event_id    TEXT NOT NULL,
  event_type  TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  delivered_at TEXT NULL
);

CREATE INDEX IF NOT EXISTS idx_unread_notifications_fetch
  ON unread_notifications(space_id, principal, delivered_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_unread_notifications_event_principal
  ON unread_notifications(event_id, principal);
