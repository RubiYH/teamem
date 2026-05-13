/**
 * Pure deep module — no I/O, no clock, no random.
 * State machine transitions for claim lifecycle.
 */

import type { ReleaseDecision } from './git-evidence.js';

export interface ClaimRow {
  claim_id: string;
  status: string;
  auto_release_mode: string;
  paused_at?: string | null;
}

export type TransitionEvent =
  | { kind: 'release_via_git'; evidence: ReleaseDecision }
  | { kind: 'ttl_expired' }
  | { kind: 'pause'; reason: string }
  | { kind: 'resume' };

export type TransitionResult =
  | { ok: true; nextStatus: 'released' }
  | {
      ok: true;
      nextAnnotation: 'paused';
      paused_at: string;
      paused_reason: string;
    }
  | { ok: true; nextAnnotation: 'active' }
  | {
      ok: false;
      error:
        | 'already_released'
        | 'already_paused'
        | 'already_active'
        | 'still_held'
        | 'branch_mismatch'
        | 'manual_only';
      reason?: string;
    };

export function transition(
  claim: ClaimRow,
  event: TransitionEvent
): TransitionResult {
  if (event.kind === 'ttl_expired') {
    if (claim.status === 'released') {
      return { ok: false, error: 'already_released' };
    }
    if (claim.auto_release_mode !== 'ttl') {
      return {
        ok: false,
        error: 'still_held',
        reason: 'claim is not in ttl mode'
      };
    }
    return { ok: true, nextStatus: 'released' };
  }

  if (event.kind === 'release_via_git') {
    if (claim.status === 'released') {
      return { ok: false, error: 'already_released' };
    }
    const { evidence } = event;
    if (evidence.decision === 'release') {
      return { ok: true, nextStatus: 'released' };
    }
    if (evidence.decision === 'branch_mismatch') {
      return { ok: false, error: 'branch_mismatch', reason: evidence.reason };
    }
    const reason = evidence.reason;
    if (reason === 'manual_only') {
      return { ok: false, error: 'manual_only' };
    }
    return { ok: false, error: 'still_held', reason };
  }

  if (event.kind === 'pause') {
    if (claim.status === 'released') {
      return { ok: false, error: 'already_released' };
    }
    if (claim.paused_at != null) {
      return { ok: false, error: 'already_paused' };
    }
    return {
      ok: true,
      nextAnnotation: 'paused',
      paused_at: new Date().toISOString(),
      paused_reason: event.reason
    };
  }

  if (event.kind === 'resume') {
    if (claim.status === 'released') {
      return { ok: false, error: 'already_released' };
    }
    if (claim.paused_at == null) {
      return { ok: false, error: 'already_active' };
    }
    return { ok: true, nextAnnotation: 'active' };
  }

  return { ok: false, error: 'still_held' };
}
