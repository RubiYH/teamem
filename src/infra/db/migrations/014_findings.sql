-- Migration 014: findings projection (slice #13).
--
-- A "finding" is a tag-faceted, severity-labeled situational discovery an
-- agent surfaces while working — e.g. "TOCTOU race in auth.ts:47", "this
-- migration must run before the index", "the briefing serializer drops
-- nulls". Findings are *not* policy decisions (those go through
-- `record_decision`) and they are *not* direct messages (those go through
-- `post_message`). They expire 7 days after creation; the briefing renders
-- only non-tombstoned, non-expired findings.
--
-- Delivery/classification behavior is handled outside this projection. The
-- current plugin surfaces findings through briefings, SessionStart sync,
-- targeted gotcha notices, and optional Channels.

CREATE TABLE IF NOT EXISTS findings (
  finding_id        TEXT PRIMARY KEY,
  space_id          TEXT NOT NULL,
  principal         TEXT NOT NULL,
  summary           TEXT NOT NULL,
  body              TEXT,
  tags_json         TEXT NOT NULL DEFAULT '[]',
  severity          TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'urgent')),
  refs_json         TEXT,
  created_at        TEXT NOT NULL,
  expires_at        TEXT NOT NULL,
  source_event_id   TEXT NOT NULL,
  tombstoned_at     TEXT
);

-- Briefing hot path: SELECT … WHERE space_id = ? AND expires_at > now AND
-- tombstoned_at IS NULL ORDER BY severity, created_at.
CREATE INDEX IF NOT EXISTS idx_findings_active
  ON findings(space_id, expires_at, tombstoned_at);

-- Per-principal queries (e.g. "what did alice find recently") — small but
-- cheap to maintain.
CREATE INDEX IF NOT EXISTS idx_findings_space_principal
  ON findings(space_id, principal, created_at);
