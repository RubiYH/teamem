/**
 * Coordination preference resolver (issue #9, ADR-0001).
 *
 * See CONTEXT.md §"Coordination preference" and §"Conflict resolution rule
 * (incumbent-wins)" for the canonical specification.
 *
 * Two rules determine the effective mode for a scope conflict:
 *
 *  1. `auto-discuss` requires BOTH parties to opt in. If only one prefers it,
 *     it is unavailable and the resolver falls back to `auto-skip`.
 *
 *  2. All non-mutual combinations resolve to `auto-skip`. The former
 *     `ask-claimant` mode is normalized as legacy data only; it is not a
 *     selectable or routable coordination mode.
 */

export const COORD_PREFS = ['auto-skip', 'auto-discuss'] as const;
export type CoordPref = (typeof COORD_PREFS)[number];

export const LEGACY_COORD_PREFS = ['ask-claimant'] as const;
export type LegacyCoordPref = (typeof LEGACY_COORD_PREFS)[number];

export function isCoordPref(value: unknown): value is CoordPref {
  return (
    typeof value === 'string' &&
    (COORD_PREFS as readonly string[]).includes(value)
  );
}

export function isLegacyCoordPref(value: unknown): value is LegacyCoordPref {
  return (
    typeof value === 'string' &&
    (LEGACY_COORD_PREFS as readonly string[]).includes(value)
  );
}

/**
 * Normalize persisted legacy values before exposing them in API responses or
 * feeding them into conflict routing. `ask-claimant` was removed as a public
 * mode; existing rows behave as `auto-skip` until migrated.
 */
export function normalizeCoordPref(value: unknown): CoordPref {
  return isCoordPref(value) ? value : 'auto-skip';
}

/**
 * Resolve the effective coordination mode for a scope conflict.
 *
 * @param latter_pref     Preference of the principal whose claim was rejected.
 * @param incumbent_pref  Preference of the principal holding the active claim.
 * @returns The mode the conflict protocol should use.
 */
export function resolveCoordMode(
  latter_pref: CoordPref,
  incumbent_pref: CoordPref
): CoordPref {
  if (latter_pref === 'auto-discuss' && incumbent_pref === 'auto-discuss') {
    return 'auto-discuss';
  }

  return 'auto-skip';
}
