import type { ToolError } from './types.js';

export function toolError(
  code: string,
  message: string,
  details?: unknown
): ToolError {
  return {
    ok: false,
    error: {
      code,
      message,
      details
    }
  };
}

export type ScopeConflictPayload = {
  code:
    | 'scope_conflict'
    | 'scope_conflict_self_widening'
    | 'claim_paused_by_peer';
  message: string;
  conflicting_claim_id: string;
  conflicting_principal: string;
  colliding_paths: string[];
  requester_coord_pref?: 'auto-skip' | 'auto-discuss';
  incumbent_coord_pref?: 'auto-skip' | 'auto-discuss';
  paused_at?: string;
  paused_reason?: string;
};

/**
 * F-NEW-2: structured 409 body returned by `claim_scope` when the
 * pre-claim TOCTOU gate detects a foreign or self-widening overlap. The
 * extra fields live on the error envelope (not on `details`) so the
 * bridge tool-binding can expose them as a typed discriminated union
 * without unwrapping nested objects.
 */
export function scopeConflictError(payload: ScopeConflictPayload): {
  ok: false;
  error: ScopeConflictPayload;
} {
  return { ok: false, error: payload };
}

/**
 * Thrown inside `db.transaction(...).immediate()` to abort the gate
 * transaction with auto-rollback. Caught at the gate boundary and
 * mapped to {@link scopeConflictError}. Lives in the server tier
 * (not the domain tier) because the payload shape is the wire contract.
 */
export class ScopeConflictError extends Error {
  readonly payload: ScopeConflictPayload;
  constructor(payload: ScopeConflictPayload) {
    super(payload.message);
    this.name = 'ScopeConflictError';
    this.payload = payload;
  }
}
