import { describe, it, expect } from 'bun:test';
import { transition } from '../../../src/domain/claim-lifecycle.js';
import type { ClaimRow } from '../../../src/domain/claim-lifecycle.js';

const ACTIVE_CLAIM: ClaimRow = {
  claim_id: 'claim-1',
  status: 'active',
  auto_release_mode: 'on_commit',
  paused_at: null
};

const PAUSED_CLAIM: ClaimRow = {
  claim_id: 'claim-2',
  status: 'active',
  auto_release_mode: 'on_commit',
  paused_at: '2026-05-01T10:00:00.000Z'
};

describe('claimLifecycleStateMachine', () => {
  it('release_via_git with release evidence → nextStatus released', () => {
    const result = transition(ACTIVE_CLAIM, {
      kind: 'release_via_git',
      evidence: { decision: 'release' }
    });
    expect(result.ok).toBe(true);
    if (result.ok && 'nextStatus' in result) {
      expect(result.nextStatus).toBe('released');
    }
  });

  it('double-release → already_released error', () => {
    const released: ClaimRow = { ...ACTIVE_CLAIM, status: 'released' };
    const result = transition(released, {
      kind: 'release_via_git',
      evidence: { decision: 'release' }
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('already_released');
    }
  });

  it('still_held evidence → still_held error', () => {
    const result = transition(ACTIVE_CLAIM, {
      kind: 'release_via_git',
      evidence: { decision: 'still_held', reason: 'working_tree_dirty' }
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('still_held');
    }
  });

  it('branch_mismatch evidence → branch_mismatch error', () => {
    const result = transition(ACTIVE_CLAIM, {
      kind: 'release_via_git',
      evidence: {
        decision: 'branch_mismatch',
        reason: "claim branch 'main' != observed branch 'other'"
      }
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('branch_mismatch');
    }
  });

  it('manual_only still_held evidence → manual_only error', () => {
    const result = transition(ACTIVE_CLAIM, {
      kind: 'release_via_git',
      evidence: { decision: 'still_held', reason: 'manual_only' }
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('manual_only');
    }
  });

  // Pause/resume transitions (slice #33)

  it('pause active claim → nextAnnotation paused with paused_at and reason', () => {
    const result = transition(ACTIVE_CLAIM, {
      kind: 'pause',
      reason: 'branch_switch'
    });
    expect(result.ok).toBe(true);
    if (
      result.ok &&
      'nextAnnotation' in result &&
      result.nextAnnotation === 'paused'
    ) {
      expect(result.nextAnnotation).toBe('paused');
      expect(result.paused_reason).toBe('branch_switch');
      expect(typeof result.paused_at).toBe('string');
    }
  });

  it('pause already-paused claim → already_paused error', () => {
    const result = transition(PAUSED_CLAIM, {
      kind: 'pause',
      reason: 'branch_switch'
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('already_paused');
    }
  });

  it('resume paused claim → nextAnnotation active', () => {
    const result = transition(PAUSED_CLAIM, { kind: 'resume' });
    expect(result.ok).toBe(true);
    if (result.ok && 'nextAnnotation' in result) {
      expect(result.nextAnnotation).toBe('active');
    }
  });

  it('resume active (non-paused) claim → already_active error', () => {
    const result = transition(ACTIVE_CLAIM, { kind: 'resume' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('already_active');
    }
  });

  it('pause released claim → already_released error', () => {
    const released: ClaimRow = { ...ACTIVE_CLAIM, status: 'released' };
    const result = transition(released, {
      kind: 'pause',
      reason: 'branch_switch'
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('already_released');
    }
  });

  it('resume released claim → already_released error', () => {
    const released: ClaimRow = { ...PAUSED_CLAIM, status: 'released' };
    const result = transition(released, { kind: 'resume' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('already_released');
    }
  });
});
