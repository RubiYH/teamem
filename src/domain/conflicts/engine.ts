import { DEFAULT_CONFLICT_WEIGHTS } from './config.js';
import type {
  ConflictResult,
  ConflictSignal,
  ConflictWeights,
  PolicyMode
} from './types.js';

export function evaluateConflict(
  signal: ConflictSignal,
  weights: ConflictWeights = DEFAULT_CONFLICT_WEIGHTS
): ConflictResult {
  const reasons: string[] = [];
  let score = 0;

  if (signal.overlapCount > 0) {
    score += Math.min(100, signal.overlapCount * weights.overlap);
    reasons.push('scope_overlap_detected');
  }
  if (signal.hasContractDrift) {
    score += weights.contractDrift;
    reasons.push('contract_drift_detected');
  }
  if (signal.staleBaseCommit) {
    score += weights.staleBase;
    reasons.push('stale_base_commit');
  }
  if (signal.unresolvedBlocker) {
    score += weights.blocker;
    reasons.push('unresolved_blocker');
  }
  if (signal.ownershipMismatch) {
    score += weights.ownershipMismatch;
    reasons.push('ownership_mismatch');
  }

  const riskScore = Math.max(0, Math.min(100, score));
  const policyMode: PolicyMode =
    riskScore >= 70 ? 'hard_gate' : riskScore >= 40 ? 'soft_gate' : 'advisory';

  const requiredActions =
    policyMode === 'hard_gate'
      ? ['resolve_conflict_before_proceeding']
      : policyMode === 'soft_gate'
        ? ['acknowledge_conflict']
        : [];

  return {
    policy_mode: policyMode,
    risk_score: riskScore,
    reasons: reasons.length > 0 ? reasons : ['no_conflict_signals'],
    required_actions: requiredActions
  };
}
