import type { TeamemEvent } from '../../domain/events/types.js';
import type { ToolResponse } from '../types.js';
import type { ToolContext } from './context.js';

type BlockerScope = 'current' | 'space';

type BlockerMutationData = {
  blocker_id: string;
  event_id: string;
  sprint_id: string | null;
  context: 'space' | 'sprint';
  status: 'open' | 'resolved';
};

type BlockerRow = {
  blocker_id: string;
  summary: string | null;
  sprint_id: string | null;
  status: string;
};

export function raiseBlocker(
  ctx: ToolContext,
  input: {
    space_id: string;
    principal: string;
    actor: string;
    delegation: string;
    summary: unknown;
    scope?: BlockerScope;
  }
): ToolResponse<BlockerMutationData> {
  const summary = typeof input.summary === 'string' ? input.summary.trim() : '';
  if (summary.length === 0) {
    return ctx.toolError(
      'invalid_summary',
      'summary must be a non-empty string'
    );
  }
  if (summary.length > 1000) {
    return ctx.toolError(
      'invalid_summary',
      'summary must not exceed 1000 characters'
    );
  }

  const routing = blockerRoutingMetadata(ctx, input);
  if (routing instanceof Error) {
    return ctx.toolError('sprint_context_unavailable', routing.message, {
      reason: routing.message
    });
  }

  const blockerId = ctx.ulid();
  const event: TeamemEvent = {
    schema_version: '1.0',
    event_id: ctx.newEventId(),
    idempotency_key: ctx.newIdempotencyKey(),
    space_id: input.space_id,
    timestamp: new Date().toISOString(),
    principal: input.principal,
    actor: input.actor,
    delegation: input.delegation,
    event_type: 'blocker_raised',
    ...routing,
    scope: {},
    payload: {
      blocker_id: blockerId,
      summary
    }
  };

  ctx.db
    .transaction(() => {
      ctx.store.appendInTx(event);
      ctx.applyProjectionUpdate(ctx.db, event);
    })
    .immediate();

  return {
    ok: true,
    data: {
      blocker_id: blockerId,
      event_id: event.event_id,
      sprint_id: event.sprint_id ?? null,
      context: event.sprint_id == null ? 'space' : 'sprint',
      status: 'open'
    }
  };
}

export function resolveBlocker(
  ctx: ToolContext,
  input: {
    space_id: string;
    principal: string;
    actor: string;
    delegation: string;
    blocker_id: string;
    resolution?: unknown;
    scope?: BlockerScope;
  }
): ToolResponse<BlockerMutationData> {
  if (typeof input.blocker_id !== 'string' || input.blocker_id.length === 0) {
    return ctx.toolError(
      'invalid_blocker_id',
      'blocker_id must be a non-empty string'
    );
  }
  const resolution =
    typeof input.resolution === 'string' && input.resolution.trim().length > 0
      ? input.resolution.trim()
      : undefined;

  const routing = blockerRoutingMetadata(ctx, input);
  if (routing instanceof Error) {
    return ctx.toolError('sprint_context_unavailable', routing.message, {
      reason: routing.message
    });
  }

  const blocker = readOpenBlockerInContext(
    ctx,
    input.space_id,
    input.blocker_id,
    routing.sprint_id ?? null
  );
  if (!blocker) {
    return ctx.toolError(
      'blocker_not_found',
      `Open blocker ${input.blocker_id} was not found in the target context`
    );
  }

  const event: TeamemEvent = {
    schema_version: '1.0',
    event_id: ctx.newEventId(),
    idempotency_key: ctx.newIdempotencyKey(),
    space_id: input.space_id,
    timestamp: new Date().toISOString(),
    principal: input.principal,
    actor: input.actor,
    delegation: input.delegation,
    event_type: 'blocker_resolved',
    ...routing,
    scope: {},
    payload: {
      blocker_id: blocker.blocker_id,
      summary: blocker.summary ?? '',
      ...(resolution !== undefined ? { resolution } : {})
    }
  };

  ctx.db
    .transaction(() => {
      ctx.store.appendInTx(event);
      ctx.applyProjectionUpdate(ctx.db, event);
    })
    .immediate();

  return {
    ok: true,
    data: {
      blocker_id: blocker.blocker_id,
      event_id: event.event_id,
      sprint_id: event.sprint_id ?? null,
      context: event.sprint_id == null ? 'space' : 'sprint',
      status: 'resolved'
    }
  };
}

function blockerRoutingMetadata(
  ctx: ToolContext,
  input: { space_id: string; principal: string; scope?: BlockerScope }
): Pick<TeamemEvent, 'sprint_id' | 'delivery_scope'> | Error {
  try {
    return ctx.routingMetadataForPrincipal(
      ctx.db,
      input,
      input.scope === 'space'
        ? { delivery: 'space' }
        : { delivery: 'broadcast' }
    );
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

function readOpenBlockerInContext(
  ctx: ToolContext,
  spaceId: string,
  blockerId: string,
  sprintId: string | null
): BlockerRow | null {
  return ctx.db
    .prepare(
      `SELECT blocker_id, summary, sprint_id, status
         FROM blockers
        WHERE space_id = ?1
          AND blocker_id = ?2
          AND status = 'open'
          AND tombstoned_at IS NULL
          AND ${sprintId === null ? 'sprint_id IS NULL' : 'sprint_id = ?3'}
        LIMIT 1`
    )
    .get(
      ...(sprintId === null
        ? [spaceId, blockerId]
        : [spaceId, blockerId, sprintId])
    ) as BlockerRow | null;
}
