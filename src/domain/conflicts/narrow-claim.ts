/**
 * Pure path-set arithmetic for legacy/internal permission grant paths (issue #11).
 *
 * On grant, the incumbent's claim is narrowed: every claim path that
 * overlaps a requested path is *released* (handed to the latter); every
 * remaining path is *kept*. This module is pure — no I/O, no side effects,
 * uses only the existing path-overlap engine.
 *
 * Disjoint case: if no claim path overlaps any requested path, the request
 * is invalid (the caller should never have requested permission to a scope
 * the incumbent doesn't hold). The route layer surfaces this as
 * `400 no_overlap`.
 */

import { findOverlaps } from './path-match.js';

export type NarrowResult = {
  kept: string[];
  released: string[];
};

/**
 * Compute the new (kept, released) partition of `claim_paths` given
 * `requested_paths`. Both arrays are passed through `findOverlaps` so the
 * matcher's normalization and glob semantics apply uniformly.
 *
 * - `released` = subset of claim_paths that overlap any requested path.
 * - `kept` = claim_paths minus released.
 *
 * Order is preserved within each partition (insertion order of
 * claim_paths). Duplicates within claim_paths are deduplicated since
 * `findOverlaps` returns a deduplicated set.
 */
export function narrowClaimPaths(
  claim_paths: readonly string[],
  requested_paths: readonly string[]
): NarrowResult {
  if (claim_paths.length === 0 || requested_paths.length === 0) {
    return { kept: [...claim_paths], released: [] };
  }
  const claimCopy: string[] = claim_paths.slice();
  const requestedCopy: string[] = requested_paths.slice();
  const releasedSet = new Set(findOverlaps(claimCopy, requestedCopy));
  const seenKept = new Set<string>();
  const kept: string[] = [];
  for (const p of claim_paths) {
    if (releasedSet.has(p)) continue;
    if (seenKept.has(p)) continue;
    seenKept.add(p);
    kept.push(p);
  }
  return { kept, released: Array.from(releasedSet).sort() };
}

/**
 * Predicate used by the route handler before calling `narrowClaimPaths` to
 * surface `400 no_overlap` when the requester's paths don't intersect the
 * incumbent's claim at all. We keep this separate from `narrowClaimPaths`
 * so the pure function can be called in tests without an error path.
 */
export function hasOverlap(
  claim_paths: readonly string[],
  requested_paths: readonly string[]
): boolean {
  if (claim_paths.length === 0 || requested_paths.length === 0) return false;
  return findOverlaps(claim_paths.slice(), requested_paths.slice()).length > 0;
}
