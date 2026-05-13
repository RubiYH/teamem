-- Migration 017: disputes projection (slice #12, Mode 6.C — auto-discuss).
--
-- A dispute is a bounded structured negotiation between two `auto-discuss`-
-- opted-in teammates' background negotiator agents, opened automatically on
-- a scope conflict. Each dispute owns a discussion thread (`thread_id`); the
-- moves themselves ride on `discussion_posted` events with structured
-- payloads ({move_type, payload}). This table indexes the thread + state
-- machine cursor.
--
-- Lifecycle:
--   - INSERTED by `teamem.open_dispute` after the latter's gate-claim
--     resolves to `auto-discuss`. Same transaction also writes a
--     `dispute_opened` event AND a `discussion_posted` event with payload
--     `{ move_type: 'open', ... }` so the watcher's existing thread
--     classifier surfaces it.
--   - status='open' → status='resolved' (explicit `accept`) OR
--     status='terminated' (turns/wallclock/pref_changed/user_override).
--   - Tombstoning (`tombstoned_at`) follows the soft-wipe pattern (slice #7).
--
-- Per-space configuration:
--   `dispute_terminations_json` on `spaces` is a JSON array listing which of
--   the 5 termination conditions are enabled. At least one MUST remain
--   enabled (server validates on update). Defaults are baked into the SQL
--   default value for new spaces; existing rows are backfilled.

BEGIN;

CREATE TABLE IF NOT EXISTS disputes (
  thread_id                TEXT PRIMARY KEY,
  space_id                 TEXT NOT NULL REFERENCES spaces(id),
  opened_by                TEXT NOT NULL,        -- latter (the requester)
  target_principal         TEXT NOT NULL,        -- incumbent
  blocking_claim_id        TEXT NOT NULL,
  paths_json               TEXT NOT NULL,        -- requested paths (JSON array)
  intent                   TEXT,
  status                   TEXT NOT NULL CHECK (status IN ('open','resolved','terminated')),
  opened_at                TEXT NOT NULL,
  resolved_at              TEXT,
  termination_reason       TEXT,                 -- 'explicit'|'user_override'|'turns'|'wallclock'|'pref_changed'|null
  termination_outcome      TEXT,                 -- 'accept'|'deny'|'skip'|null
  source_event_id          TEXT NOT NULL,
  tombstoned_at            TEXT
);

CREATE INDEX IF NOT EXISTS idx_disputes_space_status
  ON disputes(space_id, status);
CREATE INDEX IF NOT EXISTS idx_disputes_target_principal
  ON disputes(space_id, target_principal, status);

-- Per-space dispute-termination config. `dispute_terminations_json` is a
-- JSON array containing zero or more of the 5 condition ids. NULL means
-- "use defaults" (all 5 enabled). The server-side validator forbids the
-- empty array (must have at least one enabled).
ALTER TABLE spaces ADD COLUMN dispute_terminations_json TEXT;

COMMIT;
