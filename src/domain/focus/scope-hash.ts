import { createHash } from 'node:crypto';
import { normalizePathPattern } from '../conflicts/path-match.js';

/**
 * Stable scope hash (issue #15).
 *
 * Inputs are normalized via `normalizePathPattern` (the same matcher the
 * conflict gate uses), de-duplicated, sorted lexicographically, and
 * SHA-256-hashed. The hash is purely a function of the canonical scope
 * path set — order-independent and idempotent across processes.
 *
 * Empty / undefined scope → the empty-array hash. Callers can rely on the
 * dedup probe to collapse "no-scope" focus events together.
 */
export function computeScopeHash(paths: readonly string[] | undefined): string {
  if (!paths || paths.length === 0) {
    return createHash('sha256').update('[]').digest('hex');
  }
  const normalized = Array.from(
    new Set(paths.map((p) => normalizePathPattern(p)))
  ).sort();
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

/**
 * Sorted+deduped+normalized scope_paths array. Returned by the focus tool
 * so the projection can persist the canonical form alongside the hash.
 */
export function canonicalScopePaths(
  paths: readonly string[] | undefined
): string[] {
  if (!paths || paths.length === 0) return [];
  return Array.from(new Set(paths.map((p) => normalizePathPattern(p)))).sort();
}
