BEGIN;

-- Per-teammate coordination preference (issue #9, ADR-0001).
-- Consulted by the conflict resolver when two principals collide on a scope
-- claim. Three legal values per CONTEXT.md "Coordination preference":
--   auto-skip      — halt and queue for later (default; no opt-in needed).
--   ask-claimant   — send the incumbent a request-to-edit (Mode 6.B).
--   auto-discuss   — open a dispute thread between agents (Mode 6.C).
--
-- Default `auto-skip` means existing rows from migration 003 silently get the
-- conservative behavior. The CHECK constraint defends against bad updates;
-- the application layer also validates at the tool boundary.
ALTER TABLE members
  ADD COLUMN coord_pref TEXT NOT NULL DEFAULT 'auto-skip'
    CHECK (coord_pref IN ('auto-skip', 'ask-claimant', 'auto-discuss'));

COMMIT;
