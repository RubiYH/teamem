import type { ToolContext } from './context.js';
import type { TeamemEvent } from '../../domain/events/types.js';
import type { ToolResponse } from '../types.js';

export function queuePendingEdit(
  ctx: ToolContext,
  input: {
    space_id: string;
    principal: string;
    actor: string;
    delegation: string;
    blocking_claim_id: unknown;
    paths: unknown;
    intent?: unknown;
  }
): ToolResponse<{
  pending_id: string;
  event_id: string;
  expires_at: string;
}> {
  const blockingClaimId =
    typeof input.blocking_claim_id === 'string' ? input.blocking_claim_id : '';
  if (!blockingClaimId) {
    return ctx.toolError(
      'blocking_claim_id_required',
      'blocking_claim_id must be a non-empty string'
    );
  }
  const paths = Array.isArray(input.paths)
    ? input.paths.filter((p): p is string => typeof p === 'string')
    : [];
  if (paths.length === 0) {
    return ctx.toolError(
      'paths_required',
      'paths must be a non-empty array of strings'
    );
  }
  const intent = typeof input.intent === 'string' ? input.intent : '';

  const now = new Date();
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
  const pendingId = ctx.ulid();

  const event: TeamemEvent = {
    schema_version: '1.0',
    event_id: ctx.newEventId(),
    idempotency_key: `idem-pending-${pendingId}`,
    space_id: input.space_id,
    timestamp: now.toISOString(),
    principal: input.principal,
    actor: input.actor,
    delegation: input.delegation,
    event_type: 'conflict_queued',
    scope: { paths },
    payload: {
      pending_id: pendingId,
      blocking_claim_id: blockingClaimId,
      intent,
      expires_at: expiresAt
    }
  };

  try {
    return ctx.db
      .transaction(() => {
        ctx.store.appendInTx(event);
        ctx.applyProjectionUpdate(ctx.db, event);
        return {
          ok: true,
          data: {
            pending_id: pendingId,
            event_id: event.event_id,
            expires_at: expiresAt
          }
        } as ToolResponse<{
          pending_id: string;
          event_id: string;
          expires_at: string;
        }>;
      })
      .immediate();
  } catch (err) {
    const e = err as { message?: string };
    if (e?.message?.includes('no such table: pending_edits')) {
      return ctx.toolError(
        'pending_edits_unavailable',
        'pending_edits table missing; run migration 006'
      );
    }
    throw err;
  }
}

export function clearQueue(
  ctx: ToolContext,
  input: {
    space_id: string;
    principal: string;
  }
): ToolResponse<{ cleared: number }> {
  try {
    const result = ctx.db
      .prepare(
        `DELETE FROM pending_edits
          WHERE space_id = ?1
            AND blocked_principal = ?2
            AND resolved_at IS NULL
            AND tombstoned_at IS NULL`
      )
      .run(input.space_id, input.principal);
    return { ok: true, data: { cleared: Number(result.changes ?? 0) } };
  } catch (err) {
    const e = err as { message?: string };
    if (e?.message?.includes('no such table: pending_edits')) {
      return { ok: true, data: { cleared: 0 } };
    }
    throw err;
  }
}
