import { describe, it, expect } from 'bun:test';
import { evaluateRelease } from '../../../src/domain/git-evidence.js';
import type { ClaimSnapshot } from '../../../src/domain/git-evidence.js';

// codex-review task #4: SHAs must be 40 lowercase hex chars.
const SHA_ACQUIRE = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SHA_OBSERVED = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const BASE_CLAIM: ClaimSnapshot = {
  head_sha_at_acquire: SHA_ACQUIRE,
  branch: 'main',
  path: 'src/Form.tsx',
  auto_release_mode: 'on_commit'
};

describe('evaluateRelease', () => {
  it('HEAD advanced + clean + branch match → release', () => {
    const result = evaluateRelease(BASE_CLAIM, SHA_OBSERVED, false, 'main');
    expect(result.decision).toBe('release');
  });

  it('HEAD same as acquire → still_held head_unchanged', () => {
    const result = evaluateRelease(BASE_CLAIM, SHA_ACQUIRE, false, 'main');
    expect(result.decision).toBe('still_held');
    if (result.decision === 'still_held') {
      expect(result.reason).toBe('head_unchanged');
    }
  });

  it('porcelain dirty → still_held working_tree_dirty', () => {
    const result = evaluateRelease(BASE_CLAIM, SHA_OBSERVED, true, 'main');
    expect(result.decision).toBe('still_held');
    if (result.decision === 'still_held') {
      expect(result.reason).toBe('working_tree_dirty');
    }
  });

  it('branch mismatch → branch_mismatch', () => {
    const result = evaluateRelease(
      BASE_CLAIM,
      SHA_OBSERVED,
      false,
      'feature/other'
    );
    expect(result.decision).toBe('branch_mismatch');
  });

  it('manual_only claim → still_held manual_only regardless of git evidence', () => {
    const claim: ClaimSnapshot = {
      ...BASE_CLAIM,
      auto_release_mode: 'manual_only'
    };
    const result = evaluateRelease(claim, SHA_OBSERVED, false, 'main');
    expect(result.decision).toBe('still_held');
    if (result.decision === 'still_held') {
      expect(result.reason).toBe('manual_only');
    }
  });

  it('null head_sha_at_acquire with new HEAD → release', () => {
    const claim: ClaimSnapshot = { ...BASE_CLAIM, head_sha_at_acquire: null };
    const result = evaluateRelease(claim, SHA_OBSERVED, false, 'main');
    expect(result.decision).toBe('release');
  });

  it('HEAD advanced but dirty → still_held working_tree_dirty', () => {
    const result = evaluateRelease(BASE_CLAIM, SHA_OBSERVED, true, 'main');
    expect(result.decision).toBe('still_held');
    if (result.decision === 'still_held') {
      expect(result.reason).toBe('working_tree_dirty');
    }
  });

  it('delete status (D) bypasses porcelain check → release even when dirty', () => {
    const result = evaluateRelease(BASE_CLAIM, SHA_OBSERVED, true, 'main', 'D');
    expect(result.decision).toBe('release');
  });

  it('rename status (R) bypasses porcelain check → release even when dirty', () => {
    const result = evaluateRelease(BASE_CLAIM, SHA_OBSERVED, true, 'main', 'R');
    expect(result.decision).toBe('release');
  });

  it('delete status (D) still respects branch mismatch', () => {
    const result = evaluateRelease(
      BASE_CLAIM,
      SHA_OBSERVED,
      false,
      'feature/other',
      'D'
    );
    expect(result.decision).toBe('branch_mismatch');
  });

  it('delete status (D) still respects head_unchanged', () => {
    const result = evaluateRelease(BASE_CLAIM, SHA_ACQUIRE, false, 'main', 'D');
    expect(result.decision).toBe('still_held');
    if (result.decision === 'still_held') {
      expect(result.reason).toBe('head_unchanged');
    }
  });

  it('modify status (M) with dirty porcelain → still_held (standard path)', () => {
    const result = evaluateRelease(BASE_CLAIM, SHA_OBSERVED, true, 'main', 'M');
    expect(result.decision).toBe('still_held');
    if (result.decision === 'still_held') {
      expect(result.reason).toBe('working_tree_dirty');
    }
  });
});

/**
 * codex-review task #4: SHA syntactic-validity guard.
 * Each garbage observed-SHA input must return still_held with
 * reason='invalid_sha'. The post-commit hook should never surface
 * malformed evidence, but the trust model (ADR-0008) requires us to
 * validate shape before acting on it.
 */
describe('evaluateRelease — observedHeadSha syntactic guard', () => {
  const VALID_SHA = '0123456789abcdef0123456789abcdef01234567';

  it('rejects empty string → still_held invalid_sha', () => {
    const result = evaluateRelease(BASE_CLAIM, '', false, 'main');
    expect(result.decision).toBe('still_held');
    if (result.decision === 'still_held') {
      expect(result.reason).toBe('invalid_sha');
    }
  });

  it('rejects 39-char hex → still_held invalid_sha', () => {
    const result = evaluateRelease(
      BASE_CLAIM,
      VALID_SHA.slice(0, 39),
      false,
      'main'
    );
    expect(result.decision).toBe('still_held');
    if (result.decision === 'still_held') {
      expect(result.reason).toBe('invalid_sha');
    }
  });

  it('rejects 41-char hex → still_held invalid_sha', () => {
    const result = evaluateRelease(BASE_CLAIM, VALID_SHA + 'a', false, 'main');
    expect(result.decision).toBe('still_held');
    if (result.decision === 'still_held') {
      expect(result.reason).toBe('invalid_sha');
    }
  });

  it('rejects uppercase hex → still_held invalid_sha', () => {
    const result = evaluateRelease(
      BASE_CLAIM,
      VALID_SHA.toUpperCase(),
      false,
      'main'
    );
    expect(result.decision).toBe('still_held');
    if (result.decision === 'still_held') {
      expect(result.reason).toBe('invalid_sha');
    }
  });

  it('rejects non-hex chars (g-z) → still_held invalid_sha', () => {
    const garbage = 'g'.repeat(40);
    const result = evaluateRelease(BASE_CLAIM, garbage, false, 'main');
    expect(result.decision).toBe('still_held');
    if (result.decision === 'still_held') {
      expect(result.reason).toBe('invalid_sha');
    }
  });

  it('rejects whitespace-padded SHA → still_held invalid_sha', () => {
    const result = evaluateRelease(BASE_CLAIM, ` ${VALID_SHA} `, false, 'main');
    expect(result.decision).toBe('still_held');
    if (result.decision === 'still_held') {
      expect(result.reason).toBe('invalid_sha');
    }
  });

  it('accepts a valid 40-char lowercase hex SHA → release', () => {
    const result = evaluateRelease(BASE_CLAIM, VALID_SHA, false, 'main');
    expect(result.decision).toBe('release');
  });
});
