export { evaluateConflict } from './engine.js';
export { loadConflictWeights, DEFAULT_CONFLICT_WEIGHTS } from './config.js';
export {
  pathsOverlap,
  findOverlaps,
  findOverlappingActiveClaims,
  normalizePathPattern
} from './path-match.js';
export type { ActiveClaimRow, OverlapHit } from './path-match.js';
export type {
  ConflictResult,
  ConflictSignal,
  ConflictWeights,
  PolicyMode
} from './types.js';
