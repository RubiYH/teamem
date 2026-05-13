-- Migration 016: permission_requests projection (slice #11, Mode 6.B).
--
-- Legacy/internal compatibility path. Older gate-claim flows emitted
-- `request_edit_permission`, which inserts a row here with
-- status='open'. The incumbent's `respond_permission_request` flips status
-- to `granted` or `denied` inside an IMMEDIATE transaction (Pre-mortem F5:
-- two concurrent grants — only one wins, the other gets `409`).
--
-- The 60s long-poll lives in the tool layer. It uses an in-process waker
-- as the fast path and polls this projection as the durable fallback, so a
-- grant handled by another server process can still resolve the requester.
-- On timeout the row's status is flipped to `expired` so subsequent grant
-- attempts fail with `409 already_resolved`.
--
-- Per-space concurrency cap is enforced by `requestEditPermission` reading
-- the count of `status='open'` rows for the space and rejecting with
-- `429 too_many_pending_requests` when the cap is hit (Pre-mortem F1).
--
-- Tombstone (`tombstoned_at`) follows the soft-wipe pattern (slice #7).

CREATE TABLE IF NOT EXISTS permission_requests (
  req_id              TEXT PRIMARY KEY,
  space_id            TEXT NOT NULL REFERENCES spaces(id),
  requester_principal TEXT NOT NULL,
  incumbent_principal TEXT NOT NULL,
  blocking_claim_id   TEXT NOT NULL,
  paths_json          TEXT NOT NULL,
  intent              TEXT,
  status              TEXT NOT NULL CHECK (status IN ('open', 'granted', 'denied', 'expired')),
  created_at          TEXT NOT NULL,
  resolved_at         TEXT,
  source_event_id     TEXT NOT NULL,
  tombstoned_at       TEXT
);

-- Per-space cap query (`status='open'` count) and incumbent lookup.
CREATE INDEX IF NOT EXISTS idx_permission_requests_space_status
  ON permission_requests(space_id, status)
  WHERE tombstoned_at IS NULL;

-- Incumbent's "what's pending against my claims" query.
CREATE INDEX IF NOT EXISTS idx_permission_requests_incumbent
  ON permission_requests(space_id, incumbent_principal, status)
  WHERE tombstoned_at IS NULL;
