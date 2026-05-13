export type PolicyMode = 'advisory' | 'soft_gate' | 'hard_gate';

export type ConflictSignal = {
  overlapCount: number;
  hasContractDrift: boolean;
  staleBaseCommit: boolean;
  unresolvedBlocker: boolean;
  ownershipMismatch: boolean;
};

export type ConflictWeights = {
  overlap: number;
  contractDrift: number;
  staleBase: number;
  blocker: number;
  ownershipMismatch: number;
};

export type ConflictResult = {
  policy_mode: PolicyMode;
  risk_score: number;
  reasons: string[];
  required_actions: string[];
};
