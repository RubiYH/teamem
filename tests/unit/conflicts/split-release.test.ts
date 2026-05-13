/**
 * Issue #11 — `narrowClaimPaths` pure path-set arithmetic.
 *
 * Three cases per spec:
 *   1. Full subsumption — every claim path overlaps a requested path → kept
 *      empty, released = all claim paths.
 *   2. Partial overlap — some claim paths overlap → kept = remainder,
 *      released = overlapping subset.
 *   3. Disjoint — `hasOverlap` returns false (the route layer surfaces
 *      `400 no_overlap`).
 */
import { describe, expect, it } from 'bun:test';
import {
  narrowClaimPaths,
  hasOverlap
} from '../../../src/domain/conflicts/narrow-claim.js';

describe('narrowClaimPaths — full subsumption', () => {
  it('every claim path is released when all overlap requested', () => {
    const r = narrowClaimPaths(
      ['src/auth/login.ts', 'src/auth/logout.ts'],
      ['src/auth/**']
    );
    expect(r.kept).toEqual([]);
    expect(r.released.sort()).toEqual(
      ['src/auth/login.ts', 'src/auth/logout.ts'].sort()
    );
  });
});

describe('narrowClaimPaths — partial overlap', () => {
  it('keeps non-overlapping paths, releases overlapping ones', () => {
    const r = narrowClaimPaths(
      ['src/auth/login.ts', 'src/auth/logout.ts', 'src/server/index.ts'],
      ['src/auth/login.ts']
    );
    expect(r.kept).toEqual(['src/auth/logout.ts', 'src/server/index.ts']);
    expect(r.released).toEqual(['src/auth/login.ts']);
  });

  it('glob requested path narrows multiple claim paths', () => {
    const r = narrowClaimPaths(
      ['src/auth/login.ts', 'src/auth/logout.ts', 'src/server/auth.ts'],
      ['src/auth/**']
    );
    expect(r.kept).toEqual(['src/server/auth.ts']);
    expect(r.released.sort()).toEqual(
      ['src/auth/login.ts', 'src/auth/logout.ts'].sort()
    );
  });
});

describe('narrowClaimPaths — disjoint', () => {
  it('hasOverlap returns false for fully disjoint sets', () => {
    expect(hasOverlap(['src/server/index.ts'], ['docs/architecture.md'])).toBe(
      false
    );
  });

  it('narrowClaimPaths on disjoint sets keeps everything, releases nothing', () => {
    const r = narrowClaimPaths(
      ['src/server/index.ts'],
      ['docs/architecture.md']
    );
    expect(r.kept).toEqual(['src/server/index.ts']);
    expect(r.released).toEqual([]);
  });
});

describe('narrowClaimPaths — edge cases', () => {
  it('empty claim_paths returns empty kept and released', () => {
    const r = narrowClaimPaths([], ['anywhere']);
    expect(r.kept).toEqual([]);
    expect(r.released).toEqual([]);
  });

  it('empty requested_paths returns claim_paths unchanged', () => {
    const r = narrowClaimPaths(['src/a.ts', 'src/b.ts'], []);
    expect(r.kept).toEqual(['src/a.ts', 'src/b.ts']);
    expect(r.released).toEqual([]);
  });

  it('preserves insertion order in kept array', () => {
    const r = narrowClaimPaths(
      ['z.ts', 'src/auth/login.ts', 'a.ts'],
      ['src/auth/**']
    );
    expect(r.kept).toEqual(['z.ts', 'a.ts']);
  });
});
