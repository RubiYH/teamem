/**
 * Dispute state machine (slice #12, Mode 6.C — auto-discuss).
 *
 * A dispute is a bounded structured negotiation between two
 * `auto-discuss`-opted-in teammates. Every move is a discussion message
 * with a structured payload; the server validates each post against this
 * pure state machine. The 7-move vocabulary + 5 termination conditions
 * are documented in CONTEXT.md "Dispute (Mode 6.C mechanics)" and
 * ADR-0002.
 *
 * Pure: zero I/O, zero clock reads, zero db. The route layer assembles
 * the full state from db rows + dispute config and asks this module:
 * "is move X legal?" / "should we terminate?" / "what's the outcome?".
 */

export const MOVE_TYPES = [
  'propose_release_full',
  'propose_release_subset',
  'propose_release_after_task',
  'propose_swap',
  'accept',
  'reject',
  'concede_skip'
] as const;
export type MoveType = (typeof MOVE_TYPES)[number];

export const TERMINATION_CONDITIONS = [
  'user_override',
  'explicit',
  'turns',
  'wallclock',
  'pref_changed'
] as const;
export type TerminationCondition = (typeof TERMINATION_CONDITIONS)[number];

export type Side = 'opener' | 'target';

export type Move = {
  move_type: MoveType;
  side: Side;
  payload: Record<string, unknown>;
  /**
   * Stable id for this move so `accept`/`reject` can target a specific
   * proposal. The server uses the source `event_id` of the
   * `discussion_posted` event.
   */
  move_id: string;
};

export type DisputeState = {
  /** Open proposals, keyed by move_id. Closed when accepted or rejected. */
  open_proposals: Move[];
  /** Total moves posted. Used for the round-trip cap. */
  turn_count: number;
  /** Side that posted the most recent move. Used to enforce alternating turns. */
  last_side: Side | null;
  /** ISO timestamp when the dispute was opened — used for wallclock check. */
  opened_at: string;
  /** Status. `open` until terminated by any condition. */
  status: 'open' | 'resolved' | 'terminated';
};

export type DisputeConfig = {
  /** Conditions enabled for this space. Must contain at least one. */
  terminations_enabled: ReadonlySet<TerminationCondition>;
  /** Round-trip cap (default 4). */
  max_turns: number;
  /** Wall-clock cap in seconds (default 300). */
  max_seconds: number;
};

export const DEFAULT_DISPUTE_CONFIG: DisputeConfig = {
  terminations_enabled: new Set([
    'user_override',
    'explicit',
    'turns',
    'wallclock',
    'pref_changed'
  ] as const),
  max_turns: 4,
  max_seconds: 300
};

export type LegalityCheck =
  | { ok: true }
  | { ok: false; code: 'invalid_move'; reason: string };

/**
 * Validate that a candidate move is legal in the given state.
 *
 * Rules:
 *   - The dispute must still be `open`.
 *   - Cannot post twice from the same side in a row (alternating turns).
 *   - `accept` / `reject` must target an existing open proposal AND must
 *     come from the counterparty (you cannot accept your own proposal).
 *   - `propose_release_full` is only legal as the opener's first move.
 *   - `propose_release_after_task` is only legal from the target (incumbent).
 *   - `concede_skip` is only legal from the opener (the latter who
 *     unilaterally backs out and falls through to auto-skip).
 *   - The 4 propose_* moves require a payload; the validator enforces the
 *     minimum schema for each (paths arrays non-empty, etc.).
 */
export function validateMove(
  state: DisputeState,
  move: {
    move_type: MoveType;
    side: Side;
    payload: Record<string, unknown>;
    target_proposal_id?: string;
  }
): LegalityCheck {
  if (state.status !== 'open') {
    return {
      ok: false,
      code: 'invalid_move',
      reason: `dispute_${state.status}`
    };
  }
  // Alternating turns. The opening move's `last_side` is null so any side
  // can post first; thereafter sides must alternate.
  if (state.last_side !== null && state.last_side === move.side) {
    return { ok: false, code: 'invalid_move', reason: 'same_side_twice' };
  }

  switch (move.move_type) {
    case 'propose_release_full':
      if (move.side !== 'opener') {
        return {
          ok: false,
          code: 'invalid_move',
          reason: 'propose_release_full_opener_only'
        };
      }
      if (state.turn_count !== 0) {
        return {
          ok: false,
          code: 'invalid_move',
          reason: 'propose_release_full_opening_only'
        };
      }
      return { ok: true };

    case 'propose_release_subset': {
      const paths = move.payload.paths;
      if (
        !Array.isArray(paths) ||
        paths.length === 0 ||
        !paths.every((p) => typeof p === 'string')
      ) {
        return { ok: false, code: 'invalid_move', reason: 'paths_required' };
      }
      return { ok: true };
    }

    case 'propose_release_after_task': {
      if (move.side !== 'target') {
        return {
          ok: false,
          code: 'invalid_move',
          reason: 'after_task_target_only'
        };
      }
      const wait = move.payload.wait_seconds;
      if (typeof wait !== 'number' || !Number.isFinite(wait) || wait < 0) {
        return {
          ok: false,
          code: 'invalid_move',
          reason: 'wait_seconds_required'
        };
      }
      return { ok: true };
    }

    case 'propose_swap': {
      const i_release = move.payload.i_release;
      const you_release = move.payload.you_release;
      if (
        !Array.isArray(i_release) ||
        !i_release.every((p) => typeof p === 'string') ||
        !Array.isArray(you_release) ||
        !you_release.every((p) => typeof p === 'string')
      ) {
        return {
          ok: false,
          code: 'invalid_move',
          reason: 'swap_arrays_required'
        };
      }
      return { ok: true };
    }

    case 'accept':
    case 'reject': {
      if (!move.target_proposal_id) {
        return {
          ok: false,
          code: 'invalid_move',
          reason: 'target_proposal_id_required'
        };
      }
      const target = state.open_proposals.find(
        (p) => p.move_id === move.target_proposal_id
      );
      if (!target) {
        return {
          ok: false,
          code: 'invalid_move',
          reason: 'proposal_not_found'
        };
      }
      if (target.side === move.side) {
        return {
          ok: false,
          code: 'invalid_move',
          reason: 'cannot_act_on_own_proposal'
        };
      }
      if (move.move_type === 'reject') {
        const reason = move.payload.reason;
        if (
          reason !== 'busy' &&
          reason !== 'too_costly' &&
          reason !== 'wrong_paths'
        ) {
          return {
            ok: false,
            code: 'invalid_move',
            reason: 'reject_reason_required'
          };
        }
      }
      return { ok: true };
    }

    case 'concede_skip':
      if (move.side !== 'opener') {
        return {
          ok: false,
          code: 'invalid_move',
          reason: 'concede_skip_opener_only'
        };
      }
      return { ok: true };
  }
}

/**
 * Apply a legal move to the state machine. Caller must validate first.
 *
 * `accept` and `reject` close the targeted proposal. `accept` also flips
 * `status` to `resolved` — the route layer applies the agreed outcome
 * atomically when it sees this transition.
 */
export function applyMove(
  state: DisputeState,
  move: Move & { target_proposal_id?: string }
): DisputeState {
  const next: DisputeState = {
    ...state,
    open_proposals: state.open_proposals.slice(),
    turn_count: state.turn_count + 1,
    last_side: move.side
  };
  switch (move.move_type) {
    case 'propose_release_full':
    case 'propose_release_subset':
    case 'propose_release_after_task':
    case 'propose_swap':
      next.open_proposals.push({
        move_type: move.move_type,
        side: move.side,
        payload: move.payload,
        move_id: move.move_id
      });
      break;
    case 'accept':
      next.open_proposals = next.open_proposals.filter(
        (p) => p.move_id !== move.target_proposal_id
      );
      next.status = 'resolved';
      break;
    case 'reject':
      next.open_proposals = next.open_proposals.filter(
        (p) => p.move_id !== move.target_proposal_id
      );
      break;
    case 'concede_skip':
      next.status = 'terminated';
      break;
  }
  return next;
}

export type TerminationCheck =
  | { terminated: false }
  | { terminated: true; reason: TerminationCondition };

/**
 * Evaluate whether the dispute should terminate now. Caller passes the
 * current state plus context the state machine cannot derive itself
 * (current wall clock, whether either party flipped their coord_pref,
 * whether a user override has been issued).
 *
 * First-wins ordering matches CONTEXT.md "Termination":
 *   1. user_override
 *   2. explicit (accept already flipped status — handled here for
 *      completeness if caller hasn't applied the move yet)
 *   3. pref_changed
 *   4. turns
 *   5. wallclock
 *
 * Disabled conditions are skipped.
 */
export function checkTermination(
  state: DisputeState,
  ctx: {
    config: DisputeConfig;
    now: string;
    user_override_outcome?: 'accept' | 'deny' | 'skip';
    pref_changed?: boolean;
  }
): TerminationCheck {
  if (state.status !== 'open') {
    if (state.status === 'resolved')
      return { terminated: true, reason: 'explicit' };
    return { terminated: true, reason: 'user_override' };
  }

  const enabled = ctx.config.terminations_enabled;

  if (enabled.has('user_override') && ctx.user_override_outcome !== undefined) {
    return { terminated: true, reason: 'user_override' };
  }
  if (enabled.has('pref_changed') && ctx.pref_changed === true) {
    return { terminated: true, reason: 'pref_changed' };
  }
  if (enabled.has('turns') && state.turn_count >= ctx.config.max_turns) {
    return { terminated: true, reason: 'turns' };
  }
  if (enabled.has('wallclock')) {
    const opened = Date.parse(state.opened_at);
    const now = Date.parse(ctx.now);
    if (Number.isFinite(opened) && Number.isFinite(now)) {
      if ((now - opened) / 1000 >= ctx.config.max_seconds) {
        return { terminated: true, reason: 'wallclock' };
      }
    }
  }
  return { terminated: false };
}

/**
 * Validate a `dispute_terminations_enabled` config update. Returns null on
 * success, or an error string describing the problem.
 */
export function validateTerminationsEnabled(
  values: readonly string[]
): string | null {
  if (!Array.isArray(values)) return 'must be an array';
  const valid = new Set<string>(TERMINATION_CONDITIONS);
  for (const v of values) {
    if (typeof v !== 'string' || !valid.has(v)) {
      return `unknown termination condition: ${String(v)}`;
    }
  }
  if (values.length === 0) {
    return 'at least one termination condition must be enabled';
  }
  return null;
}

/**
 * Initial state for a freshly-opened dispute.
 */
export function initialState(opened_at: string): DisputeState {
  return {
    open_proposals: [],
    turn_count: 0,
    last_side: null,
    opened_at,
    status: 'open'
  };
}
