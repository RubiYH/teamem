import { describe, expect, it } from 'bun:test';
import { evaluateConflict } from '../../../src/domain/conflicts/engine.js';

describe('evaluateConflict', () => {
  it('returns advisory for no signals', () => {
    const result = evaluateConflict({
      overlapCount: 0,
      hasContractDrift: false,
      staleBaseCommit: false,
      unresolvedBlocker: false,
      ownershipMismatch: false
    });
    expect(result.policy_mode).toBe('advisory');
    expect(result.risk_score).toBe(0);
  });

  it('returns soft gate for medium score', () => {
    const result = evaluateConflict({
      overlapCount: 1,
      hasContractDrift: true,
      staleBaseCommit: false,
      unresolvedBlocker: false,
      ownershipMismatch: false
    });
    expect(result.policy_mode).toBe('soft_gate');
    expect(result.required_actions).toContain('acknowledge_conflict');
  });

  it('returns hard gate for high score', () => {
    const result = evaluateConflict({
      overlapCount: 2,
      hasContractDrift: true,
      staleBaseCommit: true,
      unresolvedBlocker: false,
      ownershipMismatch: false
    });
    expect(result.policy_mode).toBe('hard_gate');
    expect(result.required_actions).toContain(
      'resolve_conflict_before_proceeding'
    );
  });
});
