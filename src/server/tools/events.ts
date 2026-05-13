import type { ToolContext } from './context.js';
import type { TeamemEvent } from '../../domain/events/types.js';
import type { ToolResponse } from '../types.js';
import type { BriefingResponse } from './briefing-schema.js';

export function publishEvent(
  ctx: ToolContext,
  input: unknown
): ToolResponse<{ event_id: string }> {
  try {
    const event = ctx.validateEvent(input);
    ctx.store.append(event);
    ctx.applyProjectionUpdate(ctx.db, event);
    return { ok: true, data: { event_id: event.event_id } };
  } catch (error) {
    return ctx.toolError(
      'INVALID_EVENT',
      'Failed to validate or persist event',
      {
        reason: (error as Error).message
      }
    );
  }
}

export function getUpdates(
  ctx: ToolContext,
  input: {
    space_id: string;
    since?: string;
    actor?: string;
    principal?: string;
    limit?: number;
  }
): ToolResponse<{
  events: TeamemEvent[];
  next_cursor: string | null;
  space_meta?: {
    space_id: string;
    label: string;
    member_count: number;
    recent_joins: Array<{
      member_name: string;
      joined_at: string;
      is_creator: boolean;
    }>;
  };
}> {
  const events = ctx.store.getUpdates(
    input.space_id,
    input.since,
    input.limit ?? 100
  );
  const nextCursor =
    events.length > 0 ? (events.at(-1)?.event_id ?? null) : null;

  // Persist cursor for actor so next call can resume where it left off
  if (nextCursor && input.actor) {
    const now = new Date().toISOString();
    ctx.db
      .prepare(
        `INSERT OR REPLACE INTO cursors (actor, space_id, cursor_value, updated_at)
       VALUES (?1, ?2, ?3, ?4)`
      )
      .run(input.actor, input.space_id, nextCursor, now);
  }

  const decisionEventIds = events
    .filter((event) => ctx.isDecisionLifecycleEventType(event.event_type))
    .map((event) => event.event_id);
  const replayPrincipal = input.principal ?? input.actor;
  if (replayPrincipal && decisionEventIds.length > 0) {
    ctx.markDecisionNotificationsDelivered(
      input.space_id,
      replayPrincipal,
      decisionEventIds
    );
  }

  // Plan §2 req 12 / AC25: bridge consumers see recent joins without
  // calling get_briefing. Sourced from `members` projection (no new
  // event type — preserves P1 "server is a relay").
  let spaceMeta:
    | {
        space_id: string;
        label: string;
        member_count: number;
        recent_joins: Array<{
          member_name: string;
          joined_at: string;
          is_creator: boolean;
        }>;
      }
    | undefined;
  try {
    const spaceRow = ctx.db
      .prepare('SELECT label FROM spaces WHERE id = ?1 LIMIT 1')
      .get(input.space_id) as { label: string } | null;
    if (spaceRow) {
      const memberCountRow = ctx.db
        .prepare(
          'SELECT COUNT(*) AS c FROM members WHERE space_id = ?1 AND left_at IS NULL'
        )
        .get(input.space_id) as { c: number };
      const joinRows = ctx.db
        .prepare(
          `SELECT name, joined_at, is_creator FROM members
           WHERE space_id = ?1 AND left_at IS NULL
           ORDER BY joined_at DESC LIMIT 5`
        )
        .all(input.space_id) as Array<{
        name: string;
        joined_at: string;
        is_creator: number;
      }>;
      spaceMeta = {
        space_id: input.space_id,
        label: spaceRow.label,
        member_count: memberCountRow.c,
        recent_joins: joinRows.map((r) => ({
          member_name: r.name,
          joined_at: r.joined_at,
          is_creator: r.is_creator === 1
        }))
      };
    }
  } catch {
    // spaces/members tables may not exist in legacy fixtures (pre-migration 003)
  }

  return {
    ok: true,
    data: spaceMeta
      ? { events, next_cursor: nextCursor, space_meta: spaceMeta }
      : { events, next_cursor: nextCursor }
  };
}

export function getContractState(
  ctx: ToolContext,
  input: {
    space_id: string;
  }
): ToolResponse<{ contracts: unknown[] }> {
  const rows = ctx.db
    .query(
      'SELECT contract_key, state_json, updated_at FROM contracts WHERE space_id = ?1 AND tombstoned_at IS NULL'
    )
    .all(input.space_id) as Array<{
    contract_key: string;
    state_json: string;
    updated_at: string;
  }>;
  return {
    ok: true,
    data: {
      contracts: rows.map((r) => ({
        contract_key: r.contract_key,
        state: JSON.parse(r.state_json),
        updated_at: r.updated_at
      }))
    }
  };
}

export function getBriefing(
  ctx: ToolContext,
  input: {
    space_id: string;
    principal?: string;
    token_budget?: number;
  }
): ToolResponse<BriefingResponse> {
  return {
    ok: true,
    data: ctx.buildBriefing(ctx.db, {
      space_id: input.space_id,
      principal: input.principal ?? '',
      token_budget: input.token_budget
    })
  };
}

export function whoami(
  ctx: ToolContext,
  input: { space_id: string; principal: string }
): ToolResponse<{
  principal: string;
  space_id: string;
  label: string;
}> {
  let label = '';
  try {
    const row = ctx.db
      .prepare('SELECT label FROM spaces WHERE id = ?1 LIMIT 1')
      .get(input.space_id) as { label: string } | null;
    if (row) label = row.label;
  } catch {
    // legacy fixture without spaces table — keep label empty
  }
  return {
    ok: true,
    data: {
      principal: input.principal,
      space_id: input.space_id,
      label
    }
  };
}
