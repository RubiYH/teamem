import type { ToolContext } from './context.js';
import type { MoveType, Side, TerminationCondition } from './context.js';
import type { TeamemEvent } from '../../domain/events/types.js';
import type { ToolResponse } from '../types.js';

export function openDispute(
  ctx: ToolContext,
  input: {
    space_id: string;
    principal: string;
    actor: string;
    delegation: string;
    blocking_claim_id: unknown;
    paths: unknown;
    intent?: unknown;
    target_principal?: unknown;
  }
): ToolResponse<{ thread_id: string; event_id: string }> {
  const blockingClaimId =
    typeof input.blocking_claim_id === 'string' ? input.blocking_claim_id : '';
  if (!blockingClaimId) {
    return ctx.toolError(
      'blocking_claim_id_required',
      'blocking_claim_id must be a string'
    );
  }
  const paths = Array.isArray(input.paths)
    ? input.paths.filter((p): p is string => typeof p === 'string')
    : [];
  if (paths.length === 0) {
    return ctx.toolError(
      'paths_required',
      'paths must be a non-empty string array'
    );
  }

  try {
    return ctx.db
      .transaction(() => {
        const claim = ctx.db
          .prepare(
            `SELECT principal FROM claims
              WHERE claim_id = ?1 AND space_id = ?2 AND tombstoned_at IS NULL`
          )
          .get(blockingClaimId, input.space_id) as {
          principal: string;
        } | null;
        if (!claim) {
          return ctx.toolError(
            'claim_not_found',
            `claim ${blockingClaimId} not found`
          );
        }
        if (claim.principal === input.principal) {
          return ctx.toolError(
            'cannot_dispute_own_claim',
            'caller already holds this claim'
          );
        }
        const target = claim.principal;
        const explicitTarget =
          typeof input.target_principal === 'string'
            ? input.target_principal
            : null;
        if (explicitTarget && explicitTarget !== target) {
          return ctx.toolError(
            'target_principal_mismatch',
            `claim is held by ${target}, not ${explicitTarget}`
          );
        }

        const threadId = ctx.ulid();
        const timestamp = new Date().toISOString();
        const intent = typeof input.intent === 'string' ? input.intent : '';

        const openedEvt: TeamemEvent = {
          schema_version: '1.0',
          event_id: ctx.newEventId(),
          idempotency_key: `idem-disputeopen-${threadId}`,
          space_id: input.space_id,
          timestamp,
          principal: input.principal,
          actor: input.actor,
          delegation: input.delegation,
          event_type: 'dispute_opened',
          ...ctx.routingMetadataForPrincipal(ctx.db, input, {
            delivery: 'direct',
            recipient_principals: [target]
          }),
          scope: { paths },
          payload: {
            thread_id: threadId,
            blocking_claim_id: blockingClaimId,
            // Codex F22 — both `opened_by` and `target_principal`
            // must be in the payload so the auto-negotiator can
            // derive its `side` without re-querying the server. The
            // event envelope's top-level `principal` IS opened_by,
            // but the agent reads from `payload`; explicit fields
            // here make the contract self-describing.
            opened_by: input.principal,
            target_principal: target,
            intent
          }
        };
        ctx.store.appendInTx(openedEvt);

        // Insert disputes row.
        ctx.db
          .prepare(
            `INSERT INTO disputes (
            thread_id, space_id, opened_by, target_principal,
            blocking_claim_id, paths_json, intent, status,
            opened_at, source_event_id
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'open', ?8, ?9)`
          )
          .run(
            threadId,
            input.space_id,
            input.principal,
            target,
            blockingClaimId,
            JSON.stringify(paths),
            intent || null,
            timestamp,
            openedEvt.event_id
          );

        // Seed the thread with a discussion_posted event so the
        // watcher's existing thread classifier picks it up. The
        // payload doubles as the dispute's opening turn marker —
        // no actual move yet (the negotiator will post the first
        // proposal in a follow-up call).
        const seedMessageId = ctx.ulid();
        const seedIdem = `idem-disputeopen-msg-${threadId}`;
        const seedEvt: TeamemEvent = {
          schema_version: '1.0',
          event_id: ctx.newEventId(),
          idempotency_key: seedIdem,
          space_id: input.space_id,
          timestamp,
          principal: input.principal,
          actor: input.actor,
          delegation: input.delegation,
          event_type: 'discussion_posted',
          ...ctx.routingMetadataForPrincipal(ctx.db, input, {
            delivery: 'direct',
            recipient_principals: [target]
          }),
          scope: { paths },
          payload: {
            message_id: seedMessageId,
            thread_id: threadId,
            recipient_principal: target,
            body: `Dispute opened: ${intent || 'auto-discuss conflict'}`,
            in_reply_to: null,
            dispute_marker: true,
            // Codex F22 — match the move-event payload shape so the
            // monitor's classifier (`payload.dispute_move != null`)
            // does NOT pick up the seed (no `dispute_move`), but
            // any consumer that does pick it up has the side
            // metadata available without re-querying.
            opened_by: input.principal,
            target_principal: target
          }
        };
        ctx.store.appendInTx(seedEvt);
        ctx.applyProjectionUpdate(ctx.db, seedEvt);

        return {
          ok: true,
          data: { thread_id: threadId, event_id: openedEvt.event_id }
        };
      })
      .immediate() as ToolResponse<{ thread_id: string; event_id: string }>;
  } catch (err) {
    const e = err as { message?: string };
    if (e?.message?.includes('no such table: disputes')) {
      return ctx.toolError(
        'disputes_unavailable',
        'disputes table missing — run migration 017'
      );
    }
    throw err;
  }
}

export function disputePostMove(
  ctx: ToolContext,
  input: {
    space_id: string;
    principal: string;
    actor: string;
    delegation: string;
    thread_id: unknown;
    move_type: unknown;
    payload?: unknown;
    target_proposal_id?: unknown;
  }
): ToolResponse<{
  move_id: string;
  event_id: string;
  status: 'open' | 'resolved' | 'terminated';
  outcome?: string;
}> {
  const threadId = typeof input.thread_id === 'string' ? input.thread_id : '';
  if (!threadId)
    return ctx.toolError('thread_id_required', 'thread_id must be a string');
  const moveType = input.move_type as MoveType;
  const payload =
    input.payload && typeof input.payload === 'object'
      ? (input.payload as Record<string, unknown>)
      : {};
  const targetProposalId =
    typeof input.target_proposal_id === 'string'
      ? input.target_proposal_id
      : undefined;

  try {
    return ctx.db
      .transaction(() => {
        const dispute = ctx.loadDispute(ctx.db, input.space_id, threadId);
        if (!dispute) {
          return ctx.toolError('dispute_not_found', `thread_id=${threadId}`);
        }
        if (dispute.row.status !== 'open') {
          return ctx.toolError(
            'dispute_closed',
            `dispute already ${dispute.row.status}`
          );
        }
        // Determine which side this caller is. Anyone who is neither
        // opener nor target has no business posting; reject.
        let side: Side;
        if (input.principal === dispute.row.opened_by) side = 'opener';
        else if (input.principal === dispute.row.target_principal)
          side = 'target';
        else {
          return ctx.toolError(
            'not_dispute_party',
            'only the opener or target can post moves'
          );
        }

        // Replay the move history so the state machine has the
        // correct turn_count/last_side/open_proposals.
        const state = ctx.replayDisputeMoves(
          ctx.db,
          input.space_id,
          threadId,
          dispute.row.opened_at
        );

        // Pref-changed termination: re-resolve current pref for both
        // sides and compare to opener-target's recorded
        // auto-discuss assumption. If either now differs, we must
        // terminate first rather than apply the move.
        const config = dispute.config;
        const prefChanged = !ctx.bothStillAutoDiscuss(
          ctx.db,
          input.space_id,
          dispute.row.opened_by,
          dispute.row.target_principal
        );
        const auto = ctx.checkTermination(state, {
          config,
          now: new Date().toISOString(),
          pref_changed: prefChanged
        });
        if (auto.terminated) {
          return ctx.finalizeTermination(ctx.db, ctx.store, {
            space_id: input.space_id,
            thread_id: threadId,
            reason: auto.reason,
            outcome: 'skip',
            principal: input.principal,
            actor: input.actor,
            delegation: input.delegation
          });
        }

        const moveId = ctx.ulid();
        const legality = ctx.validateMove(state, {
          move_type: moveType,
          side,
          payload,
          target_proposal_id: targetProposalId
        });
        if (!legality.ok) {
          return ctx.toolError('invalid_move', legality.reason);
        }

        // Append the discussion_posted event with structured payload.
        const timestamp = new Date().toISOString();
        const moveEvt: TeamemEvent = {
          schema_version: '1.0',
          event_id: ctx.newEventId(),
          idempotency_key: `idem-dispmove-${moveId}`,
          space_id: input.space_id,
          timestamp,
          principal: input.principal,
          actor: input.actor,
          delegation: input.delegation,
          event_type: 'discussion_posted',
          ...ctx.routingMetadataForPrincipal(ctx.db, input, {
            delivery: 'direct',
            recipient_principals: [
              side === 'opener'
                ? dispute.row.target_principal
                : dispute.row.opened_by
            ]
          }),
          scope: {},
          payload: {
            message_id: moveId,
            thread_id: threadId,
            recipient_principal:
              side === 'opener'
                ? dispute.row.target_principal
                : dispute.row.opened_by,
            body: `[${moveType}]`,
            in_reply_to: null,
            dispute_move: {
              move_type: moveType,
              side,
              payload,
              target_proposal_id: targetProposalId ?? null
            },
            // Codex F22 — every move event must carry the dispute's
            // side metadata so the counterparty's auto-negotiator
            // can derive its `side` from the payload alone (no
            // server round-trip, no re-query). Without these the
            // agent's whoami check has nothing to compare against
            // → emit-nothing guard fires → dispute stalls after
            // the first move.
            opened_by: dispute.row.opened_by,
            target_principal: dispute.row.target_principal
          }
        };
        ctx.store.appendInTx(moveEvt);
        ctx.applyProjectionUpdate(ctx.db, moveEvt);

        const nextState = ctx.applyMove(state, {
          move_type: moveType,
          side,
          payload,
          move_id: moveId,
          target_proposal_id: targetProposalId
        });

        // Round-trip cap evaluated AFTER the move counts. If hit,
        // terminate even though the move was legal.
        if (nextState.status === 'open') {
          const post = ctx.checkTermination(nextState, {
            config,
            now: new Date().toISOString()
          });
          if (post.terminated) {
            const term = ctx.finalizeTermination(ctx.db, ctx.store, {
              space_id: input.space_id,
              thread_id: threadId,
              reason: post.reason,
              outcome: 'skip',
              principal: input.principal,
              actor: input.actor,
              delegation: input.delegation
            });
            if (!term.ok) return term;
            return {
              ok: true,
              data: {
                move_id: moveId,
                event_id: moveEvt.event_id,
                status: 'terminated' as const,
                outcome: term.data.outcome
              }
            };
          }
        }

        // Concede skip — terminated immediately by ctx.applyMove.
        if (moveType === 'concede_skip') {
          const term = ctx.finalizeTermination(ctx.db, ctx.store, {
            space_id: input.space_id,
            thread_id: threadId,
            reason: 'explicit',
            outcome: 'skip',
            principal: input.principal,
            actor: input.actor,
            delegation: input.delegation
          });
          if (!term.ok) return term;
          return {
            ok: true,
            data: {
              move_id: moveId,
              event_id: moveEvt.event_id,
              status: 'terminated' as const,
              outcome: 'skip'
            }
          };
        }

        // accept — resolve atomically based on the targeted proposal.
        if (moveType === 'accept' && targetProposalId) {
          const proposal = state.open_proposals.find(
            (p) => p.move_id === targetProposalId
          );
          if (!proposal) {
            return ctx.toolError('invalid_move', 'proposal_not_found');
          }
          const outcome = ctx.applyAcceptOutcome(ctx.db, ctx.store, {
            space_id: input.space_id,
            thread_id: threadId,
            dispute: dispute.row,
            proposal,
            acceptor: input.principal,
            actor: input.actor,
            delegation: input.delegation
          });
          if (!outcome.ok) return outcome;
          ctx.db
            .prepare(
              `UPDATE disputes SET status = 'resolved', resolved_at = ?1,
                                 termination_reason = 'explicit',
                                 termination_outcome = ?2
              WHERE thread_id = ?3`
            )
            .run(new Date().toISOString(), outcome.data.outcome, threadId);
          return {
            ok: true,
            data: {
              move_id: moveId,
              event_id: moveEvt.event_id,
              status: 'resolved' as const,
              outcome: outcome.data.outcome
            }
          };
        }

        return {
          ok: true,
          data: {
            move_id: moveId,
            event_id: moveEvt.event_id,
            status: 'open' as const
          }
        };
      })
      .immediate() as ToolResponse<{
      move_id: string;
      event_id: string;
      status: 'open' | 'resolved' | 'terminated';
      outcome?: string;
    }>;
  } catch (err) {
    const e = err as { message?: string };
    if (e?.message?.includes('no such table: disputes')) {
      return ctx.toolError(
        'disputes_unavailable',
        'disputes table missing — run migration 017'
      );
    }
    throw err;
  }
}

export function endDispute(
  ctx: ToolContext,
  input: {
    space_id: string;
    principal: string;
    actor: string;
    delegation: string;
    thread_id: unknown;
    action: unknown;
  }
): ToolResponse<{ status: 'terminated' | 'resolved'; outcome: string }> {
  const threadId = typeof input.thread_id === 'string' ? input.thread_id : '';
  if (!threadId)
    return ctx.toolError('thread_id_required', 'thread_id must be a string');
  const action = input.action;
  if (action !== 'accept' && action !== 'deny' && action !== 'skip') {
    return ctx.toolError('invalid_action', 'action must be accept|deny|skip');
  }

  try {
    return ctx.db
      .transaction(() => {
        const dispute = ctx.loadDispute(ctx.db, input.space_id, threadId);
        if (!dispute)
          return ctx.toolError('dispute_not_found', `thread_id=${threadId}`);
        if (dispute.row.status !== 'open') {
          return ctx.toolError(
            'dispute_closed',
            `dispute already ${dispute.row.status}`
          );
        }
        // Only opener or target may end the dispute (5.3.C).
        if (
          input.principal !== dispute.row.opened_by &&
          input.principal !== dispute.row.target_principal
        ) {
          return ctx.toolError(
            'not_dispute_party',
            'only the opener or target can end this dispute'
          );
        }

        if (action === 'accept') {
          const state = ctx.replayDisputeMoves(
            ctx.db,
            input.space_id,
            threadId,
            dispute.row.opened_at
          );
          if (state.open_proposals.length === 0) {
            return ctx.toolError(
              'no_open_proposal',
              'cannot accept — no open proposal to apply'
            );
          }
          const proposal =
            state.open_proposals[state.open_proposals.length - 1]!;
          const outcome = ctx.applyAcceptOutcome(ctx.db, ctx.store, {
            space_id: input.space_id,
            thread_id: threadId,
            dispute: dispute.row,
            proposal,
            acceptor: input.principal,
            actor: input.actor,
            delegation: input.delegation
          });
          if (!outcome.ok) return outcome;
          ctx.db
            .prepare(
              `UPDATE disputes SET status = 'resolved', resolved_at = ?1,
                                 termination_reason = 'user_override',
                                 termination_outcome = ?2
              WHERE thread_id = ?3`
            )
            .run(new Date().toISOString(), outcome.data.outcome, threadId);
          return {
            ok: true,
            data: {
              status: 'resolved' as const,
              outcome: outcome.data.outcome
            }
          };
        }

        // deny / skip — close with no outcome applied.
        const term = ctx.finalizeTermination(ctx.db, ctx.store, {
          space_id: input.space_id,
          thread_id: threadId,
          reason: 'user_override',
          outcome: action,
          principal: input.principal,
          actor: input.actor,
          delegation: input.delegation
        });
        if (!term.ok) return term;
        return {
          ok: true,
          data: {
            status: 'terminated' as const,
            outcome: term.data.outcome
          }
        };
      })
      .immediate() as ToolResponse<{
      status: 'terminated' | 'resolved';
      outcome: string;
    }>;
  } catch (err) {
    const e = err as { message?: string };
    if (e?.message?.includes('no such table: disputes')) {
      return ctx.toolError(
        'disputes_unavailable',
        'disputes table missing — run migration 017'
      );
    }
    throw err;
  }
}

export function updateDisputeTerminations(
  ctx: ToolContext,
  input: {
    space_id: string;
    principal: string;
    enabled: unknown;
  }
): ToolResponse<{ enabled: TerminationCondition[] }> {
  if (!Array.isArray(input.enabled)) {
    return ctx.toolError(
      'enabled_must_be_array',
      'enabled must be a JSON array'
    );
  }
  const err = ctx.validateTerminationsEnabled(
    input.enabled as readonly string[]
  );
  if (err) return ctx.toolError('invalid_enabled', err);

  // Caller must be the creator (only role allowed to mutate space-level config).
  try {
    const member = ctx.db
      .prepare(
        `SELECT is_creator FROM members
          WHERE space_id = ?1 AND name = ?2 AND left_at IS NULL`
      )
      .get(input.space_id, input.principal) as {
      is_creator: number;
    } | null;
    if (!member || member.is_creator !== 1) {
      return ctx.toolError(
        'not_creator',
        'only the creator can mutate space config'
      );
    }
    ctx.db
      .prepare(`UPDATE spaces SET dispute_terminations_json = ?1 WHERE id = ?2`)
      .run(JSON.stringify(input.enabled), input.space_id);
    return {
      ok: true,
      data: { enabled: input.enabled as TerminationCondition[] }
    };
  } catch (err) {
    const e = err as { message?: string };
    if (e?.message?.includes('no such column: dispute_terminations_json')) {
      return ctx.toolError(
        'disputes_unavailable',
        'dispute config column missing — run migration 017'
      );
    }
    throw err;
  }
}
