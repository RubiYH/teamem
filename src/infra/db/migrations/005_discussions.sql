-- Migration 005: discussions table.
--
-- Backs the `discussion_posted` event type and the `teamem.post_message` /
-- `teamem.read_thread` MCP tools used by the Claude Code plugin's negotiator
-- agent. A "discussion" is a lightweight async message between teammates in
-- the same space — claim/conflict negotiation, handoff requests, broadcast
-- announcements.
--
-- thread_id groups messages into a logical conversation. recipient_principal
-- is NULL for broadcast (visible to anyone in the space) or set to a single
-- principal for a directed message. The watcher / negotiator filter on
-- recipient_principal == self OR recipient_principal IS NULL.

CREATE TABLE IF NOT EXISTS discussions (
  message_id           TEXT PRIMARY KEY,
  space_id             TEXT NOT NULL,
  thread_id            TEXT NOT NULL,
  sender_principal     TEXT NOT NULL,
  recipient_principal  TEXT,
  body                 TEXT NOT NULL,
  in_reply_to          TEXT,
  created_at           TEXT NOT NULL,
  source_event_id      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_discussions_space_thread
  ON discussions(space_id, thread_id, created_at);

CREATE INDEX IF NOT EXISTS idx_discussions_space_recipient
  ON discussions(space_id, recipient_principal, created_at);

CREATE INDEX IF NOT EXISTS idx_discussions_space_sender
  ON discussions(space_id, sender_principal, created_at);
