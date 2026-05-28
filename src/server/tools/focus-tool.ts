import type { ToolContext } from './context.js';
import type { TeamemEvent } from '../../domain/events/types.js';
import type { ToolResponse } from '../types.js';

export function agentFocusChanged(
  ctx: ToolContext,
  input: {
    space_id: string;
    principal: string;
    actor: string;
    delegation: string;
    scope?: TeamemEvent['scope'];
    intent?: unknown;
    bypass_dedup?: unknown;
  }
): ToolResponse<{
  focus_id: string;
  event_id: string;
  scope_hash: string;
  deduped: boolean;
}> {
  const paths = ctx.canonicalScopePaths(input.scope?.paths);
  const scopeHash = ctx.computeScopeHash(paths);
  const intent = typeof input.intent === 'string' ? input.intent : '';
  const bypass = input.bypass_dedup === true;
  const focusId = ctx.ulid();
  const event: TeamemEvent = {
    schema_version: '1.0',
    event_id: ctx.newEventId(),
    idempotency_key: `idem-focus-${focusId}`,
    space_id: input.space_id,
    timestamp: new Date().toISOString(),
    principal: input.principal,
    actor: input.actor,
    delegation: input.delegation,
    event_type: 'agent_focus_changed',
    ...ctx.routingMetadataForPrincipal(ctx.db, input, {
      delivery: 'broadcast'
    }),
    scope: { paths },
    payload: {
      focus_id: focusId,
      scope_hash: scopeHash,
      intent,
      bypass_dedup: bypass
    }
  };

  try {
    return ctx.db
      .transaction(() => {
        ctx.store.appendInTx(event);
        ctx.applyProjectionUpdate(ctx.db, event);
        // Detect whether the projection actually inserted us. The
        // dedup branch returns early without writing; we tell the
        // caller via `deduped` so callers (gate-claim, tests) can
        // surface that information without re-querying.
        const row = ctx.db
          .prepare('SELECT focus_id FROM focus WHERE focus_id = ?1 LIMIT 1')
          .get(focusId) as { focus_id: string } | null;
        return {
          ok: true,
          data: {
            focus_id: focusId,
            event_id: event.event_id,
            scope_hash: scopeHash,
            deduped: row === null
          }
        } as ToolResponse<{
          focus_id: string;
          event_id: string;
          scope_hash: string;
          deduped: boolean;
        }>;
      })
      .immediate();
  } catch (err) {
    const e = err as { message?: string };
    if (e?.message?.includes('no such table: focus')) {
      return ctx.toolError(
        'focus_unavailable',
        'focus table missing — run migration 018'
      );
    }
    throw err;
  }
}
