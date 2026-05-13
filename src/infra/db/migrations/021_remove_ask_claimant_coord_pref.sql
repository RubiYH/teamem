-- Migration 021: remove ask-claimant as an active coordination preference.
--
-- The permission request tables/tools remain as legacy/internal primitives,
-- but member-level conflict routing now exposes only auto-skip and
-- auto-discuss. Existing ask-claimant rows are conservative-compatible with
-- auto-skip.

BEGIN;

UPDATE members
   SET coord_pref = 'auto-skip'
 WHERE coord_pref = 'ask-claimant';

COMMIT;
