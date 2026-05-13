import type { ConflictWeights } from './types.js';

export const DEFAULT_CONFLICT_WEIGHTS: ConflictWeights = {
  overlap: 30,
  contractDrift: 25,
  staleBase: 20,
  blocker: 20,
  ownershipMismatch: 15
};

export function loadConflictWeights(
  env: NodeJS.ProcessEnv = process.env,
  defaults: ConflictWeights = DEFAULT_CONFLICT_WEIGHTS
): ConflictWeights {
  const toNumber = (key: string, fallback: number): number => {
    const raw = env[key];
    if (!raw) return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  return {
    overlap: toNumber('TEAMEM_WEIGHT_OVERLAP', defaults.overlap),
    contractDrift: toNumber(
      'TEAMEM_WEIGHT_CONTRACT_DRIFT',
      defaults.contractDrift
    ),
    staleBase: toNumber('TEAMEM_WEIGHT_STALE_BASE', defaults.staleBase),
    blocker: toNumber('TEAMEM_WEIGHT_BLOCKER', defaults.blocker),
    ownershipMismatch: toNumber(
      'TEAMEM_WEIGHT_OWNERSHIP_MISMATCH',
      defaults.ownershipMismatch
    )
  };
}
