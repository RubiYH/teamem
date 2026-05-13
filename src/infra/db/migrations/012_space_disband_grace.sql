-- Migration 012: soft-disband grace window.
--
-- Replaces the hard-cascade disband path (which deleted from 9 projection
-- tables instantly) with a soft-tombstone model. The team lead still calls
-- `disband`, but the data is retained for a 7-day grace window; a periodic
-- GC sweep performs the hard cascade only after the grace expires. The
-- creator can `restoreSpace` within the grace window to undo the disband.
--
-- JWT rejection is immediate regardless of grace state — the existing
-- auth middleware filter `s.disbanded_at IS NULL` already enforces that.
--
-- Race discipline: both `restoreSpace` and the GC sweep wrap their work in
-- `BEGIN IMMEDIATE TRANSACTION` so a restore and a GC sweep cannot both
-- "win" against the same row (Pre-mortem F4 mitigation).

BEGIN;

ALTER TABLE spaces ADD COLUMN disbanded_grace_until TEXT;

-- GC sweep predicate: rows where the grace window has elapsed and the
-- space is still tombstoned. The partial index keeps the hot path cheap.
CREATE INDEX IF NOT EXISTS idx_spaces_disband_grace
  ON spaces(disbanded_grace_until)
  WHERE disbanded_at IS NOT NULL AND disbanded_grace_until IS NOT NULL;

COMMIT;
