import { describe, it, expect } from 'bun:test';
import {
  findOverlappingActiveClaims,
  type ActiveClaimRow
} from '../../../src/domain/conflicts/path-match.js';

describe('findOverlappingActiveClaims (pure)', () => {
  it('returns empty array for empty rows', () => {
    expect(findOverlappingActiveClaims([], ['src/a.ts'])).toEqual([]);
  });

  it('returns empty array for empty candidatePaths', () => {
    const rows: ActiveClaimRow[] = [
      {
        claim_id: 'c1',
        principal: 'alice',
        scope_paths: ['src/a.ts']
      }
    ];
    expect(findOverlappingActiveClaims(rows, [])).toEqual([]);
  });

  it('single foreign overlap returns one hit with matched paths', () => {
    const rows: ActiveClaimRow[] = [
      {
        claim_id: 'c-alice',
        principal: 'alice',
        scope_paths: ['src/auth/**'],
        expires_at: '2099-01-01T00:00:00Z'
      }
    ];
    const hits = findOverlappingActiveClaims(rows, ['src/auth/login.ts']);
    expect(hits.length).toBe(1);
    expect(hits[0]).toEqual({
      claim_id: 'c-alice',
      principal: 'alice',
      matched_target_paths: ['src/auth/login.ts'],
      expires_at: '2099-01-01T00:00:00Z'
    });
  });

  it('single self-overlap is included; caller filters', () => {
    const rows: ActiveClaimRow[] = [
      {
        claim_id: 'c-alice',
        principal: 'alice',
        scope_paths: ['src/auth/**']
      }
    ];
    const hits = findOverlappingActiveClaims(rows, ['src/auth/login.ts']);
    expect(hits.length).toBe(1);
    expect(hits[0].principal).toBe('alice');
  });

  it('mixed self+foreign returns both hits', () => {
    const rows: ActiveClaimRow[] = [
      { claim_id: 'c-alice', principal: 'alice', scope_paths: ['src/auth/**'] },
      {
        claim_id: 'c-bob',
        principal: 'bob',
        scope_paths: ['src/auth/login.ts']
      },
      {
        claim_id: 'c-charlie',
        principal: 'charlie',
        scope_paths: ['src/api/**']
      }
    ];
    const hits = findOverlappingActiveClaims(rows, ['src/auth/login.ts']);
    expect(hits.map((h) => h.principal).sort()).toEqual(['alice', 'bob']);
  });

  it('no overlap returns empty array', () => {
    const rows: ActiveClaimRow[] = [
      { claim_id: 'c-alice', principal: 'alice', scope_paths: ['src/auth/**'] }
    ];
    const hits = findOverlappingActiveClaims(rows, ['src/api/user.ts']);
    expect(hits).toEqual([]);
  });

  it('glob-vs-literal in claims data overlaps a glob candidate', () => {
    const rows: ActiveClaimRow[] = [
      {
        claim_id: 'c-alice',
        principal: 'alice',
        scope_paths: ['src/auth/login.ts']
      }
    ];
    const hits = findOverlappingActiveClaims(rows, ['src/auth/**']);
    expect(hits.length).toBe(1);
    expect(hits[0].matched_target_paths).toEqual(['src/auth/**']);
  });

  it('afterSelectHook fires synchronously before scanning', () => {
    let hookFired = false;
    const rows: ActiveClaimRow[] = [
      { claim_id: 'c1', principal: 'alice', scope_paths: ['src/x.ts'] }
    ];
    findOverlappingActiveClaims(rows, ['src/x.ts'], {
      afterSelectHook: () => {
        hookFired = true;
      }
    });
    expect(hookFired).toBe(true);
  });

  it('matched_target_paths are sorted/deduped via findOverlaps contract', () => {
    const rows: ActiveClaimRow[] = [
      {
        claim_id: 'c1',
        principal: 'alice',
        scope_paths: ['src/**']
      }
    ];
    const hits = findOverlappingActiveClaims(rows, [
      'src/z.ts',
      'src/a.ts',
      'src/z.ts'
    ]);
    expect(hits[0].matched_target_paths).toEqual(['src/a.ts', 'src/z.ts']);
  });
});
