import type { ToolContext } from './context.js';
import type { SessionSyncResponse } from './context.js';
import type { TeamemEvent } from '../../domain/events/types.js';
import type { ToolResponse } from '../types.js';
import type { SpaceRulesSnapshotResponse } from './space-rules.js';

export function exportSpaceRulesSnapshot(
  ctx: ToolContext,
  input: {
    space_id: string;
    principal: string;
  }
): ToolResponse<SpaceRulesSnapshotResponse> {
  try {
    const spaceRow = ctx.db
      .prepare('SELECT label FROM spaces WHERE id = ?1 LIMIT 1')
      .get(input.space_id) as { label: string } | null;
    if (!spaceRow) {
      return ctx.toolError('space_not_found', 'space does not exist');
    }

    const current = ctx.readCurrentSpaceRulesState(ctx.db, input.space_id);

    return {
      ok: true,
      data: ctx.buildSpaceRulesSnapshot({
        renderedRulesBody: current.body,
        hasServerRules: current.hasServerRules,
        spaceId: input.space_id,
        spaceLabel: spaceRow.label,
        rulesVersion: current.version,
        sourceEventId: current.sourceEventId,
        snapshotUpdatedAt: current.updatedAt,
        snapshotUpdatedBy: current.updatedBy
      })
    };
  } catch (err) {
    const e = err as { message?: string };
    if (
      e?.message?.includes('no such table: space_rules_snapshots') ||
      e?.message?.includes('no such column: srs.is_disabled') ||
      e?.message?.includes('no such table: spaces')
    ) {
      return ctx.toolError(
        'space_rules_unavailable',
        'space rules snapshot storage is unavailable'
      );
    }
    throw err;
  }
}

export function sessionSync(
  ctx: ToolContext,
  input: {
    space_id: string;
    principal: string;
  }
): ToolResponse<SessionSyncResponse> {
  try {
    const spaceRow = ctx.db
      .prepare('SELECT label FROM spaces WHERE id = ?1 LIMIT 1')
      .get(input.space_id) as { label: string } | null;
    if (!spaceRow) {
      return ctx.toolError('space_not_found', 'space does not exist');
    }

    const current = ctx.readCurrentSpaceRulesState(ctx.db, input.space_id);
    const decisions = ctx.drainDecisionReplayNotifications(
      input.space_id,
      input.principal
    );
    if (!decisions.ok) {
      return decisions;
    }
    const gotchaNotices = ctx.listGotchaNotices(
      input.space_id,
      input.principal
    );

    return {
      ok: true,
      data: {
        space_rules_snapshot: ctx.buildSpaceRulesSnapshot({
          renderedRulesBody: current.body,
          hasServerRules: current.hasServerRules,
          spaceId: input.space_id,
          spaceLabel: spaceRow.label,
          rulesVersion: current.version,
          sourceEventId: current.sourceEventId,
          snapshotUpdatedAt: current.updatedAt,
          snapshotUpdatedBy: current.updatedBy
        }),
        decisions: decisions.data.decisions,
        decision_replays: decisions.data.decisions,
        gotcha_notices: gotchaNotices
      }
    };
  } catch (err) {
    const e = err as { message?: string };
    if (
      e?.message?.includes('no such table: space_rules_snapshots') ||
      e?.message?.includes('no such column: srs.is_disabled') ||
      e?.message?.includes('no such table: spaces')
    ) {
      return ctx.toolError(
        'space_rules_unavailable',
        'space rules snapshot storage is unavailable'
      );
    }
    throw err;
  }
}

export function updateSpaceRules(
  ctx: ToolContext,
  input: {
    space_id: string;
    principal: string;
    actor: string;
    delegation: string;
    rules_markdown: string;
    base_version: number;
    base_hash: string;
  }
): ToolResponse<SpaceRulesSnapshotResponse> {
  if (typeof input.rules_markdown !== 'string') {
    return ctx.toolError(
      'invalid_rules_markdown',
      'rules_markdown must be a string'
    );
  }
  if (
    typeof input.base_version !== 'number' ||
    !Number.isInteger(input.base_version) ||
    input.base_version < 0
  ) {
    return ctx.toolError(
      'invalid_base_version',
      'base_version must be a non-negative integer'
    );
  }
  if (typeof input.base_hash !== 'string' || input.base_hash.length === 0) {
    return ctx.toolError('invalid_base_hash', 'base_hash must be a string');
  }

  try {
    const spaceRow = ctx.db
      .prepare('SELECT label FROM spaces WHERE id = ?1 LIMIT 1')
      .get(input.space_id) as { label: string } | null;
    if (!spaceRow) {
      return ctx.toolError('space_not_found', 'space does not exist');
    }

    const memberRow = ctx.db
      .prepare(
        `SELECT id, is_creator
           FROM members
          WHERE space_id = ?1
            AND name = ?2
            AND left_at IS NULL
          LIMIT 1`
      )
      .get(input.space_id, input.principal) as {
      id: string;
      is_creator: number;
    } | null;
    if (!memberRow) {
      return ctx.toolError('member_not_found', 'no active member row');
    }
    if (memberRow.is_creator !== 1) {
      return ctx.toolError(
        'not_creator',
        'only the creator can update Space Rules'
      );
    }

    return ctx.db
      .transaction(() => {
        const current = ctx.readCurrentSpaceRulesState(ctx.db, input.space_id);
        if (
          current.version !== input.base_version ||
          current.hash !== input.base_hash
        ) {
          return ctx.toolError(
            'space_rules_conflict',
            'stale Space Rules draft; refresh before publishing',
            {
              current_version: current.version,
              current_hash: current.hash,
              current_source_event_id: current.sourceEventId,
              has_server_rules: current.hasServerRules
            }
          );
        }

        const nextBody = ctx.canonicalRulesBody(input.rules_markdown);
        const nextHash = ctx.stableRulesHash(nextBody);
        if (!current.hasServerRules && nextBody.length === 0) {
          return ctx.toolError(
            'empty_rules_draft',
            'rules draft is empty; nothing to publish'
          );
        }

        const nextHasServerRules = nextBody.length > 0;
        if (
          current.hasServerRules === nextHasServerRules &&
          current.body === nextBody
        ) {
          return {
            ok: true,
            data: ctx.buildSpaceRulesSnapshot({
              renderedRulesBody: current.body,
              hasServerRules: current.hasServerRules,
              spaceId: input.space_id,
              spaceLabel: spaceRow.label,
              rulesVersion: current.version,
              sourceEventId: current.sourceEventId,
              snapshotUpdatedAt: current.updatedAt,
              snapshotUpdatedBy: current.updatedBy
            })
          };
        }

        const eventType = !current.hasServerRules
          ? 'space_rule_added'
          : nextHasServerRules
            ? 'space_rule_amended'
            : 'space_rule_disabled';
        const timestamp = new Date().toISOString();
        const event: TeamemEvent = {
          schema_version: '1.0',
          event_id: ctx.newEventId(),
          idempotency_key: ctx.newIdempotencyKey(),
          space_id: input.space_id,
          timestamp,
          principal: input.principal,
          actor: input.actor,
          delegation: input.delegation,
          event_type: eventType,
          scope: {},
          payload: {
            rules_markdown: nextBody,
            rules_version: current.version + 1,
            rules_hash: nextHash
          }
        };

        ctx.store.appendInTx(event);
        ctx.applyProjectionUpdate(ctx.db, event);

        return {
          ok: true,
          data: ctx.buildSpaceRulesSnapshot({
            renderedRulesBody: nextBody,
            hasServerRules: nextHasServerRules,
            spaceId: input.space_id,
            spaceLabel: spaceRow.label,
            rulesVersion: current.version + 1,
            sourceEventId: event.event_id,
            snapshotUpdatedAt: timestamp,
            snapshotUpdatedBy: input.principal
          })
        };
      })
      .immediate() as ToolResponse<SpaceRulesSnapshotResponse>;
  } catch (err) {
    const e = err as { message?: string };
    if (
      e?.message?.includes('no such table: space_rules_snapshots') ||
      e?.message?.includes('no such column: srs.is_disabled') ||
      e?.message?.includes('no such table: spaces') ||
      e?.message?.includes('no such table: members')
    ) {
      return ctx.toolError(
        'space_rules_unavailable',
        'space rules snapshot storage is unavailable'
      );
    }
    throw err;
  }
}
