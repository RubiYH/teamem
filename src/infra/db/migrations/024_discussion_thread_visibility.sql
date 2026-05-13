-- Migration 023: explicit discussion thread visibility metadata.
--
-- Space Memory v1 Issue 08 tightens Discuss reads around thread-level
-- visibility rules. The existing `discussions` table stores per-message
-- sender/recipient state, but direct-thread authorization needs a stable
-- thread-wide source of truth that survives reply churn and projection replay.

CREATE TABLE IF NOT EXISTS discussion_threads (
  thread_id                   TEXT PRIMARY KEY,
  space_id                    TEXT NOT NULL,
  visibility_mode             TEXT NOT NULL,
  participant_principals_json TEXT NOT NULL,
  source_message_id           TEXT NOT NULL,
  source_event_id             TEXT,
  created_at                  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_discussion_threads_space
  ON discussion_threads(space_id, visibility_mode, created_at);

-- Backfill legacy rows so existing threads keep deterministic visibility.
--
-- Compatibility rule:
--   - any thread that ever carried `recipient_principal IS NULL` is treated as
--     `broadcast`
--   - otherwise it is `direct` and its participants are the distinct sender +
--     recipient principals observed in the thread
INSERT OR IGNORE INTO discussion_threads (
  thread_id,
  space_id,
  visibility_mode,
  participant_principals_json,
  source_message_id,
  source_event_id,
  created_at
)
WITH thread_summary AS (
  SELECT
    d.space_id,
    d.thread_id,
    CASE
      WHEN SUM(CASE WHEN d.recipient_principal IS NULL THEN 1 ELSE 0 END) > 0
        THEN 'broadcast'
      ELSE 'direct'
    END AS visibility_mode
  FROM discussions d
  WHERE d.tombstoned_at IS NULL
  GROUP BY d.space_id, d.thread_id
)
SELECT
  ts.thread_id,
  ts.space_id,
  ts.visibility_mode,
  CASE
    WHEN ts.visibility_mode = 'broadcast' THEN '[]'
    ELSE COALESCE(
      (
        SELECT json_group_array(principal)
        FROM (
          SELECT DISTINCT principal
          FROM (
            SELECT d_participants.sender_principal AS principal
            FROM discussions d_participants
            WHERE d_participants.space_id = ts.space_id
              AND d_participants.thread_id = ts.thread_id
              AND d_participants.tombstoned_at IS NULL
            UNION ALL
            SELECT d_participants.recipient_principal AS principal
            FROM discussions d_participants
            WHERE d_participants.space_id = ts.space_id
              AND d_participants.thread_id = ts.thread_id
              AND d_participants.tombstoned_at IS NULL
              AND d_participants.recipient_principal IS NOT NULL
          )
          ORDER BY principal
        )
      ),
      '[]'
    )
  END AS participant_principals_json,
  (
    SELECT d_first.message_id
    FROM discussions d_first
    WHERE d_first.space_id = ts.space_id
      AND d_first.thread_id = ts.thread_id
      AND d_first.tombstoned_at IS NULL
    ORDER BY d_first.created_at ASC, d_first.message_id ASC
    LIMIT 1
  ) AS source_message_id,
  (
    SELECT d_first.source_event_id
    FROM discussions d_first
    WHERE d_first.space_id = ts.space_id
      AND d_first.thread_id = ts.thread_id
      AND d_first.tombstoned_at IS NULL
    ORDER BY d_first.created_at ASC, d_first.message_id ASC
    LIMIT 1
  ) AS source_event_id,
  (
    SELECT d_first.created_at
    FROM discussions d_first
    WHERE d_first.space_id = ts.space_id
      AND d_first.thread_id = ts.thread_id
      AND d_first.tombstoned_at IS NULL
    ORDER BY d_first.created_at ASC, d_first.message_id ASC
    LIMIT 1
  ) AS created_at
FROM thread_summary ts;
