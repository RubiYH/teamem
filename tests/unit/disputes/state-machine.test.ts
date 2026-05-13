/**
 * Slice #12 — dispute state machine pure-logic tests.
 *
 * Drives every legal/illegal move shape and every termination condition
 * via the in-memory state machine. No db, no clock, no I/O — the route
 * layer composes these primitives atomically.
 */
import { describe, expect, it } from 'bun:test';
import {
  validateMove,
  applyMove,
  checkTermination,
  validateTerminationsEnabled,
  initialState,
  DEFAULT_DISPUTE_CONFIG,
  type DisputeState
} from '../../../src/domain/disputes/state-machine.js';

const T0 = '2026-05-03T15:00:00.000Z';

function freshState(overrides: Partial<DisputeState> = {}): DisputeState {
  return { ...initialState(T0), ...overrides };
}

describe('validateMove — legal moves', () => {
  it('opener can post propose_release_subset as opening turn', () => {
    const r = validateMove(freshState(), {
      move_type: 'propose_release_subset',
      side: 'opener',
      payload: { paths: ['src/auth/login.ts'] }
    });
    expect(r.ok).toBe(true);
  });

  it('opener can post propose_release_full as opening turn', () => {
    const r = validateMove(freshState(), {
      move_type: 'propose_release_full',
      side: 'opener',
      payload: {}
    });
    expect(r.ok).toBe(true);
  });

  it('target can post propose_release_after_task with wait_seconds', () => {
    const r = validateMove(freshState({ turn_count: 1, last_side: 'opener' }), {
      move_type: 'propose_release_after_task',
      side: 'target',
      payload: { wait_seconds: 600 }
    });
    expect(r.ok).toBe(true);
  });

  it('either side can post propose_swap with both arrays', () => {
    const r = validateMove(freshState(), {
      move_type: 'propose_swap',
      side: 'opener',
      payload: { i_release: ['src/foo.ts'], you_release: ['src/bar.ts'] }
    });
    expect(r.ok).toBe(true);
  });

  it('counterparty can accept an open proposal', () => {
    const stateWithProposal = applyMove(freshState(), {
      move_type: 'propose_release_subset',
      side: 'opener',
      payload: { paths: ['src/auth/login.ts'] },
      move_id: 'proposal-1'
    });
    const r = validateMove(stateWithProposal, {
      move_type: 'accept',
      side: 'target',
      payload: {},
      target_proposal_id: 'proposal-1'
    });
    expect(r.ok).toBe(true);
  });

  it('counterparty can reject with a reason enum', () => {
    const stateWithProposal = applyMove(freshState(), {
      move_type: 'propose_release_subset',
      side: 'opener',
      payload: { paths: ['src/auth/login.ts'] },
      move_id: 'proposal-1'
    });
    const r = validateMove(stateWithProposal, {
      move_type: 'reject',
      side: 'target',
      payload: { reason: 'too_costly' },
      target_proposal_id: 'proposal-1'
    });
    expect(r.ok).toBe(true);
  });

  it('opener can concede_skip unilaterally', () => {
    const r = validateMove(freshState(), {
      move_type: 'concede_skip',
      side: 'opener',
      payload: {}
    });
    expect(r.ok).toBe(true);
  });
});

describe('validateMove — illegal moves', () => {
  it('rejects move on a terminated dispute', () => {
    const r = validateMove(freshState({ status: 'terminated' }), {
      move_type: 'propose_release_subset',
      side: 'opener',
      payload: { paths: ['x'] }
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('dispute_terminated');
  });

  it('rejects same-side-twice', () => {
    const r = validateMove(freshState({ turn_count: 1, last_side: 'opener' }), {
      move_type: 'propose_release_subset',
      side: 'opener',
      payload: { paths: ['x'] }
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('same_side_twice');
  });

  it('rejects propose_release_full from target', () => {
    const r = validateMove(freshState(), {
      move_type: 'propose_release_full',
      side: 'target',
      payload: {}
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('propose_release_full_opener_only');
  });

  it('rejects propose_release_full after opening turn', () => {
    const r = validateMove(freshState({ turn_count: 1, last_side: 'target' }), {
      move_type: 'propose_release_full',
      side: 'opener',
      payload: {}
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('propose_release_full_opening_only');
  });

  it('rejects propose_release_after_task from opener', () => {
    const r = validateMove(freshState(), {
      move_type: 'propose_release_after_task',
      side: 'opener',
      payload: { wait_seconds: 600 }
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('after_task_target_only');
  });

  it('rejects propose_release_subset with empty paths', () => {
    const r = validateMove(freshState(), {
      move_type: 'propose_release_subset',
      side: 'opener',
      payload: { paths: [] }
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('paths_required');
  });

  it('rejects propose_swap with non-array i_release', () => {
    const r = validateMove(freshState(), {
      move_type: 'propose_swap',
      side: 'opener',
      payload: { i_release: 'oops', you_release: ['x'] }
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('swap_arrays_required');
  });

  it('rejects accept on own proposal', () => {
    // Seed with target's reject so last_side flips back, then have opener
    // try to accept their OWN earlier proposal — exercises the
    // cannot_act_on_own_proposal branch (and bypasses same_side_twice).
    let s = applyMove(freshState(), {
      move_type: 'propose_release_subset',
      side: 'opener',
      payload: { paths: ['x'] },
      move_id: 'p1'
    });
    // Add a second proposal from the target so last_side is target.
    s = applyMove(s, {
      move_type: 'propose_release_subset',
      side: 'target',
      payload: { paths: ['y'] },
      move_id: 'p2'
    });
    // Now opener tries to accept their own p1 — same-side-twice doesn't fire
    // (last_side is target), but cannot_act_on_own_proposal should.
    const r = validateMove(s, {
      move_type: 'accept',
      side: 'opener',
      payload: {},
      target_proposal_id: 'p1'
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('cannot_act_on_own_proposal');
  });

  it('rejects accept with no target_proposal_id', () => {
    const r = validateMove(freshState(), {
      move_type: 'accept',
      side: 'target',
      payload: {}
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('target_proposal_id_required');
  });

  it('rejects accept on nonexistent proposal', () => {
    const r = validateMove(freshState({ turn_count: 1, last_side: 'opener' }), {
      move_type: 'accept',
      side: 'target',
      payload: {},
      target_proposal_id: 'no-such-proposal'
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('proposal_not_found');
  });

  it('rejects reject with invalid reason', () => {
    const stateWithProposal = applyMove(freshState(), {
      move_type: 'propose_release_subset',
      side: 'opener',
      payload: { paths: ['x'] },
      move_id: 'p1'
    });
    const r = validateMove(stateWithProposal, {
      move_type: 'reject',
      side: 'target',
      payload: { reason: 'whatever' },
      target_proposal_id: 'p1'
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('reject_reason_required');
  });

  it('rejects concede_skip from target', () => {
    const r = validateMove(freshState(), {
      move_type: 'concede_skip',
      side: 'target',
      payload: {}
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('concede_skip_opener_only');
  });
});

describe('applyMove — state transitions', () => {
  it('accept flips status to resolved and removes the proposal', () => {
    const s1 = applyMove(freshState(), {
      move_type: 'propose_release_subset',
      side: 'opener',
      payload: { paths: ['src/auth/login.ts'] },
      move_id: 'p1'
    });
    const s2 = applyMove(s1, {
      move_type: 'accept',
      side: 'target',
      payload: {},
      move_id: 'a1',
      target_proposal_id: 'p1'
    });
    expect(s2.status).toBe('resolved');
    expect(s2.open_proposals).toHaveLength(0);
    expect(s2.turn_count).toBe(2);
  });

  it('reject closes the proposal but keeps the dispute open', () => {
    const s1 = applyMove(freshState(), {
      move_type: 'propose_release_subset',
      side: 'opener',
      payload: { paths: ['src/auth/login.ts'] },
      move_id: 'p1'
    });
    const s2 = applyMove(s1, {
      move_type: 'reject',
      side: 'target',
      payload: { reason: 'too_costly' },
      move_id: 'r1',
      target_proposal_id: 'p1'
    });
    expect(s2.status).toBe('open');
    expect(s2.open_proposals).toHaveLength(0);
  });

  it('concede_skip terminates immediately', () => {
    const s1 = applyMove(freshState(), {
      move_type: 'concede_skip',
      side: 'opener',
      payload: {},
      move_id: 's1'
    });
    expect(s1.status).toBe('terminated');
  });
});

describe('checkTermination — 5 conditions', () => {
  it('user_override fires when outcome is provided and condition enabled', () => {
    const r = checkTermination(freshState(), {
      config: DEFAULT_DISPUTE_CONFIG,
      now: T0,
      user_override_outcome: 'accept'
    });
    expect(r.terminated).toBe(true);
    if (r.terminated) expect(r.reason).toBe('user_override');
  });

  it('explicit fires when state is already resolved', () => {
    const r = checkTermination(freshState({ status: 'resolved' }), {
      config: DEFAULT_DISPUTE_CONFIG,
      now: T0
    });
    expect(r.terminated).toBe(true);
    if (r.terminated) expect(r.reason).toBe('explicit');
  });

  it('pref_changed fires when ctx flag set', () => {
    const r = checkTermination(freshState(), {
      config: DEFAULT_DISPUTE_CONFIG,
      now: T0,
      pref_changed: true
    });
    expect(r.terminated).toBe(true);
    if (r.terminated) expect(r.reason).toBe('pref_changed');
  });

  it('turns fires when turn_count >= max_turns', () => {
    const r = checkTermination(freshState({ turn_count: 4 }), {
      config: DEFAULT_DISPUTE_CONFIG,
      now: T0
    });
    expect(r.terminated).toBe(true);
    if (r.terminated) expect(r.reason).toBe('turns');
  });

  it('wallclock fires when elapsed seconds >= max_seconds', () => {
    const later = '2026-05-03T15:06:00.000Z'; // 6 minutes after T0
    const r = checkTermination(freshState(), {
      config: DEFAULT_DISPUTE_CONFIG,
      now: later
    });
    expect(r.terminated).toBe(true);
    if (r.terminated) expect(r.reason).toBe('wallclock');
  });

  it('skips disabled conditions', () => {
    const config = {
      ...DEFAULT_DISPUTE_CONFIG,
      terminations_enabled: new Set(['turns'] as const)
    };
    // wallclock far elapsed but disabled — no termination
    const r = checkTermination(freshState({ turn_count: 1 }), {
      config,
      now: '2026-05-03T16:00:00.000Z'
    });
    expect(r.terminated).toBe(false);
  });

  it('first wins (user_override beats pref_changed)', () => {
    const r = checkTermination(freshState(), {
      config: DEFAULT_DISPUTE_CONFIG,
      now: T0,
      user_override_outcome: 'skip',
      pref_changed: true
    });
    if (r.terminated) expect(r.reason).toBe('user_override');
  });
});

describe('validateTerminationsEnabled — config validation', () => {
  it('accepts a non-empty subset of valid conditions', () => {
    expect(validateTerminationsEnabled(['turns', 'wallclock'])).toBeNull();
  });

  it('accepts the full set', () => {
    expect(
      validateTerminationsEnabled([
        'user_override',
        'explicit',
        'turns',
        'wallclock',
        'pref_changed'
      ])
    ).toBeNull();
  });

  it('rejects empty array — at least one must remain enabled', () => {
    expect(validateTerminationsEnabled([])).toMatch(/at least one/);
  });

  it('rejects unknown condition ids', () => {
    expect(validateTerminationsEnabled(['turns', 'not-a-thing'])).toMatch(
      /unknown termination condition/
    );
  });

  it('rejects non-string entries', () => {
    expect(
      validateTerminationsEnabled(['turns', 42 as unknown as string])
    ).toMatch(/unknown termination condition/);
  });
});
