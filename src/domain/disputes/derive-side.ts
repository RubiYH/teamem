/**
 * Codex F22 — derive an auto-negotiator's `side` from a dispute event
 * payload.
 *
 * The auto-negotiator agent receives a `teamem.dispute_event` notification
 * carrying either:
 *   - `event_type: "dispute_opened"`         — a fresh dispute
 *   - `event_type: "discussion_posted"` with `payload.dispute_move` set
 *                                            — a move from the counterparty
 *
 * Both event shapes carry `payload.opened_by` and
 * `payload.target_principal` (server fix in `disputePostMove` and
 * `openDispute`). The agent calls `mcp__teamem__whoami` to learn its
 * own principal, then uses `deriveDisputeSide(whoami, payload)` to
 * decide whether to act, and as which side.
 *
 * Pre-#24 the agent's prompt told it to compare `whoami` against
 * `payload.opened_by` and `payload.target_principal`, but the move
 * payload didn't carry those fields. The lookup returned `null`, the
 * "emit-nothing" guard fired on every move event, and Mode 6.C stalled
 * after the first move.
 *
 * Pre-#24 the agent's side-derivation lived only in the prompt
 * (markdown). Extracting the rule into a pure helper means the test
 * suite can prove that real production payloads (from the actual
 * `disputePostMove` emission path) yield non-null sides — the regression
 * pattern that has caught fix slices F18 and F21.
 *
 * Returns:
 *   - `"opener"`   — caller is the latter who opened the dispute
 *   - `"target"`   — caller is the incumbent the dispute targets
 *   - `null`       — caller is neither (event misrouted; agent should
 *                    emit nothing)
 */

export type DisputeSide = 'opener' | 'target';

/**
 * Minimum payload shape for side derivation. The full dispute event
 * payload carries more fields; we type only what this function reads
 * so callers get loose contract coverage.
 */
export type DisputeSidePayload = {
  opened_by?: unknown;
  target_principal?: unknown;
};

export function deriveDisputeSide(
  whoami_principal: string,
  payload: DisputeSidePayload | null | undefined
): DisputeSide | null {
  if (!payload || typeof payload !== 'object') return null;
  if (typeof whoami_principal !== 'string' || whoami_principal === '') {
    return null;
  }
  const opened_by =
    typeof payload.opened_by === 'string' ? payload.opened_by : null;
  const target_principal =
    typeof payload.target_principal === 'string'
      ? payload.target_principal
      : null;
  if (opened_by === whoami_principal) return 'opener';
  if (target_principal === whoami_principal) return 'target';
  return null;
}
