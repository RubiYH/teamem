import type { TeamemEvent } from '../../domain/events/types.js';
import {
  type SprintContextMode,
  type SprintSummary,
  validateSprintDraft
} from '../../domain/sprints.js';
import type { ToolError, ToolResponse } from '../types.js';
import type { ToolContext } from './context.js';

type SprintRow = {
  sprint_id: string;
  slug: string;
  display_name: string;
  goal: string;
  status: 'active' | 'archived';
  created_at?: string;
  archived_at?: string | null;
  last_activity_at?: string | null;
};

type SprintLifecycleResponse = {
  sprint: SprintSummary | null;
  old_context: SprintContextMode;
  new_context: SprintContextMode;
  event_ids: string[];
  idempotent: boolean;
  message: string;
  warnings: string[];
};

type SprintInventoryItem = SprintSummary & {
  current_members: string[];
  last_activity_at: string | null;
};

type SprintHistoryItem = {
  event_id: string;
  event_type: TeamemEvent['event_type'];
  timestamp: string;
  principal: string;
  sprint_id: string;
  summary: string;
  payload: Record<string, unknown>;
};

type SprintArchiveResponse = {
  sprint: SprintSummary;
  event_ids: string[];
  idempotent: boolean;
  released_claims: Array<{
    claim_id: string;
    original_holder: string;
    event_id: string;
  }>;
  message: string;
};

const DEFAULT_HISTORY_LIMIT = 25;
const MAX_HISTORY_LIMIT = 100;

function sprintFromRow(row: SprintRow): SprintSummary {
  return {
    sprint_id: row.sprint_id,
    slug: row.slug,
    display_name: row.display_name,
    goal: row.goal,
    status: row.status
  };
}

function spaceContext(): SprintContextMode {
  return { mode: 'space', sprint: null };
}

function sprintContext(row: SprintRow | null): SprintContextMode {
  return row ? { mode: 'sprint', sprint: sprintFromRow(row) } : spaceContext();
}

function currentMembersForSprint(
  ctx: ToolContext,
  spaceId: string,
  sprintId: string | null
): string[] {
  if (!sprintId) return [];
  const row = ctx.db
    .prepare(
      `SELECT COALESCE(json_group_array(principal), '[]') AS current_members_json
         FROM sprint_memberships
        WHERE space_id = ?1 AND sprint_id = ?2
        ORDER BY principal`
    )
    .get(spaceId, sprintId) as { current_members_json: string } | null;
  return row ? ctx.parseStringArray(JSON.parse(row.current_members_json)) : [];
}

function requireActiveMember(
  ctx: ToolContext,
  input: { space_id: string; principal: string }
): ToolError | null {
  const row = ctx.db
    .prepare(
      `SELECT id FROM members
       WHERE space_id = ?1 AND name = ?2 AND left_at IS NULL
       LIMIT 1`
    )
    .get(input.space_id, input.principal) as { id: string } | null;
  return row
    ? null
    : ctx.toolError('member_not_found', 'no active member row in this space');
}

function readSprintById(
  ctx: ToolContext,
  spaceId: string,
  sprintId: string | null
): SprintRow | null {
  if (!sprintId) return null;
  return ctx.db
    .prepare(
      `SELECT sprint_id, slug, display_name, goal, status
       FROM sprints
       WHERE space_id = ?1 AND sprint_id = ?2
       LIMIT 1`
    )
    .get(spaceId, sprintId) as SprintRow | null;
}

function readCurrentSprint(
  ctx: ToolContext,
  spaceId: string,
  principal: string
): SprintRow | null {
  return ctx.db
    .prepare(
      `SELECT s.sprint_id, s.slug, s.display_name, s.goal, s.status
       FROM sprint_memberships sm
       JOIN sprints s ON s.sprint_id = sm.sprint_id
       WHERE sm.space_id = ?1
         AND sm.principal = ?2
         AND sm.sprint_id IS NOT NULL
       LIMIT 1`
    )
    .get(spaceId, principal) as SprintRow | null;
}

function findSprintByTarget(
  ctx: ToolContext,
  spaceId: string,
  target: string
): SprintRow | null {
  return ctx.db
    .prepare(
      `SELECT sprint_id, slug, display_name, goal, status
       FROM sprints
       WHERE space_id = ?1 AND (sprint_id = ?2 OR slug = ?2)
       LIMIT 1`
    )
    .get(spaceId, target) as SprintRow | null;
}

function memberCountForSprint(
  ctx: ToolContext,
  spaceId: string,
  sprintId: string
): number {
  const row = ctx.db
    .prepare(
      `SELECT COUNT(*) AS c
       FROM sprint_memberships
       WHERE space_id = ?1 AND sprint_id = ?2`
    )
    .get(spaceId, sprintId) as { c: number } | null;
  return Number(row?.c ?? 0);
}

function findDuplicateSprint(
  ctx: ToolContext,
  input: { space_id: string },
  validated: { slug: string; display_name: string }
): SprintRow | null {
  return ctx.db
    .prepare(
      `SELECT sprint_id, slug, display_name, goal, status
       FROM sprints
       WHERE space_id = ?1 AND (slug = ?2 OR display_name = ?3)
       LIMIT 1`
    )
    .get(
      input.space_id,
      validated.slug,
      validated.display_name
    ) as SprintRow | null;
}

function duplicateSprintError(
  ctx: ToolContext,
  duplicate: SprintRow
): ToolError {
  const hint = duplicate.status === 'active' ? 'join' : 'reopen';
  return ctx.toolError(
    'sprint_already_exists',
    `Sprint already exists; ${hint} ${duplicate.slug} instead.`,
    { hint, sprint: sprintFromRow(duplicate) }
  );
}

function activeClaimCountOutsideContext(
  ctx: ToolContext,
  input: { space_id: string; principal: string },
  sprintId: string | null
): number {
  const row = ctx.db
    .prepare(
      sprintId === null
        ? `SELECT COUNT(*) AS c FROM claims
            WHERE space_id = ?1
              AND principal = ?2
              AND status IN ('active', 'paused')
              AND sprint_id IS NOT NULL
              AND tombstoned_at IS NULL`
        : `SELECT COUNT(*) AS c FROM claims
            WHERE space_id = ?1
              AND principal = ?2
              AND status IN ('active', 'paused')
              AND (sprint_id IS NULL OR sprint_id != ?3)
              AND tombstoned_at IS NULL`
    )
    .get(
      ...(sprintId === null
        ? [input.space_id, input.principal]
        : [input.space_id, input.principal, sprintId])
    ) as { c: number } | null;
  return Number(row?.c ?? 0);
}

function activeClaimCountInContext(
  ctx: ToolContext,
  input: { space_id: string; principal: string },
  sprintId: string
): number {
  const row = ctx.db
    .prepare(
      `SELECT COUNT(*) AS c FROM claims
        WHERE space_id = ?1
          AND principal = ?2
          AND status IN ('active', 'paused')
          AND sprint_id = ?3
          AND tombstoned_at IS NULL`
    )
    .get(input.space_id, input.principal, sprintId) as { c: number } | null;
  return Number(row?.c ?? 0);
}

function contextWarnings(
  ctx: ToolContext,
  input: { space_id: string; principal: string },
  sprintId: string | null
): string[] {
  const outside = activeClaimCountOutsideContext(ctx, input, sprintId);
  return outside > 0
    ? [
        `${outside} active claim${outside === 1 ? '' : 's'} remain outside the new current context.`
      ]
    : [];
}

function appendSprintEventInTx(ctx: ToolContext, event: TeamemEvent): void {
  ctx.store.appendInTx(event);
  ctx.applyProjectionUpdate(ctx.db, event);
}

function buildSprintEvent(
  ctx: ToolContext,
  input: {
    space_id: string;
    principal: string;
    actor?: string;
    delegation?: string;
  },
  event_type:
    | 'sprint_created'
    | 'sprint_joined'
    | 'sprint_left'
    | 'sprint_archived'
    | 'sprint_reopened',
  payload: Record<string, unknown>
): TeamemEvent {
  const sprintId =
    typeof payload.sprint_id === 'string' && payload.sprint_id.length > 0
      ? payload.sprint_id
      : null;
  return {
    schema_version: '1.0',
    event_id: ctx.newEventId(),
    idempotency_key: ctx.newIdempotencyKey(),
    space_id: input.space_id,
    timestamp: new Date().toISOString(),
    principal: input.principal,
    actor: input.actor ?? input.principal,
    delegation: input.delegation ?? `${input.principal}->teamem`,
    event_type,
    sprint_id: sprintId,
    delivery_scope: 'direct',
    recipient_principals: [input.principal],
    scope: {},
    payload
  };
}

function buildArchiveClaimReleaseEvent(
  ctx: ToolContext,
  input: {
    space_id: string;
    principal: string;
    actor?: string;
    delegation?: string;
  },
  claim: {
    claim_id: string;
    principal: string;
    scope_json: string;
    repo_id: string;
    branch: string;
    path: string;
    sprint_id: string;
  },
  sprint: SprintRow,
  now: string
): TeamemEvent {
  let releasedPath = claim.path;
  try {
    const parsed = JSON.parse(claim.scope_json) as TeamemEvent['scope'];
    releasedPath =
      releasedPath ||
      (Array.isArray(parsed.paths) && typeof parsed.paths[0] === 'string'
        ? parsed.paths[0]
        : '');
  } catch {
    // Keep the projection-owned path if legacy scope_json is malformed.
  }

  return {
    schema_version: '1.0',
    event_id: ctx.newEventId(),
    idempotency_key: `archive-force-release-${sprint.sprint_id}-${claim.claim_id}`,
    space_id: input.space_id,
    timestamp: now,
    principal: input.principal,
    actor: input.actor ?? input.principal,
    delegation: input.delegation ?? `${input.principal}->teamem`,
    event_type: 'claim_force_released',
    sprint_id: claim.sprint_id,
    delivery_scope: 'direct',
    recipient_principals: [claim.principal],
    scope: releasedPath ? { paths: [releasedPath] } : {},
    payload: {
      claim_id: claim.claim_id,
      repo_id: claim.repo_id,
      branch: claim.branch,
      path: releasedPath,
      released_by: input.principal,
      original_holder: claim.principal,
      released_at: now,
      archive_cleanup: true,
      sprint_id: sprint.sprint_id,
      sprint_slug: sprint.slug
    }
  };
}

function insertUnreadNotificationInTx(
  ctx: ToolContext,
  input: { space_id: string },
  event: TeamemEvent
): void {
  for (const recipient of event.recipient_principals ?? []) {
    try {
      ctx.db
        .prepare(
          `INSERT OR IGNORE INTO unread_notifications
           (space_id, principal, event_id, event_type, payload_json, created_at, delivered_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL)`
        )
        .run(
          input.space_id,
          recipient,
          event.event_id,
          event.event_type,
          JSON.stringify(event.payload),
          event.timestamp
        );
    } catch (err) {
      const e = err as { message?: string };
      if (!e?.message?.includes('no such table: unread_notifications')) {
        throw err;
      }
    }
  }
}

function sprintHistorySummary(event: TeamemEvent): string {
  const slug = String((event.payload.slug as string | undefined) ?? '');
  if (event.event_type === 'sprint_created') return `created ${slug}`;
  if (event.event_type === 'sprint_joined') return `${event.principal} joined`;
  if (event.event_type === 'sprint_left') return `${event.principal} left`;
  if (event.event_type === 'sprint_archived') return `archived ${slug}`;
  if (event.event_type === 'sprint_reopened') return `reopened ${slug}`;
  if (event.event_type === 'claim_force_released') {
    return `archive cleanup force-released claim ${String(
      (event.payload.claim_id as string | undefined) ?? ''
    )}`;
  }
  return event.event_type;
}

export function createSprint(
  ctx: ToolContext,
  input: {
    space_id: string;
    principal: string;
    actor?: string;
    delegation?: string;
    display_name?: unknown;
    name?: unknown;
    goal?: unknown;
  }
): ToolResponse<SprintLifecycleResponse> {
  const memberError = requireActiveMember(ctx, input);
  if (memberError) return memberError;

  const validated = validateSprintDraft({
    display_name: input.display_name ?? input.name,
    goal: input.goal
  });
  if (!validated.ok) return ctx.toolError(validated.code, validated.message);

  const sprintId = ctx.ulid();
  let created: SprintRow | null = null;
  const txState: { oldSprint: SprintRow | null } = { oldSprint: null };
  const eventIds: string[] = [];

  try {
    const duplicateError = ctx.db
      .transaction(() => {
        const duplicate = findDuplicateSprint(ctx, input, validated);
        if (duplicate) {
          return duplicateSprintError(ctx, duplicate);
        }

        const oldSprint = readCurrentSprint(
          ctx,
          input.space_id,
          input.principal
        );
        txState.oldSprint = oldSprint;
        const createEvent = buildSprintEvent(ctx, input, 'sprint_created', {
          sprint_id: sprintId,
          slug: validated.slug,
          display_name: validated.display_name,
          goal: validated.goal
        });
        appendSprintEventInTx(ctx, createEvent);
        eventIds.push(createEvent.event_id);

        if (oldSprint) {
          const leaveEvent = buildSprintEvent(ctx, input, 'sprint_left', {
            sprint_id: oldSprint.sprint_id,
            slug: oldSprint.slug,
            reason: 'switch'
          });
          appendSprintEventInTx(ctx, leaveEvent);
          eventIds.push(leaveEvent.event_id);
        }

        const joinEvent = buildSprintEvent(ctx, input, 'sprint_joined', {
          sprint_id: sprintId,
          slug: validated.slug,
          previous_sprint_id: oldSprint?.sprint_id ?? null
        });
        appendSprintEventInTx(ctx, joinEvent);
        eventIds.push(joinEvent.event_id);

        return null;
      })
      .immediate() as ToolError | null;
    if (duplicateError) return duplicateError;
    created = readSprintById(ctx, input.space_id, sprintId);
  } catch (error) {
    return ctx.toolError('sprint_create_failed', 'failed to create sprint', {
      reason: (error as Error).message
    });
  }

  const newContext = sprintContext(created);
  return {
    ok: true,
    data: {
      sprint: created ? sprintFromRow(created) : null,
      old_context: sprintContext(txState.oldSprint),
      new_context: newContext,
      event_ids: eventIds,
      idempotent: false,
      message: txState.oldSprint
        ? `Left ${txState.oldSprint.slug}; joined ${validated.slug}.`
        : `Created and joined ${validated.slug}.`,
      warnings: contextWarnings(ctx, input, sprintId)
    }
  };
}

export function joinSprint(
  ctx: ToolContext,
  input: {
    space_id: string;
    principal: string;
    actor?: string;
    delegation?: string;
    sprint: unknown;
  }
): ToolResponse<SprintLifecycleResponse> {
  const memberError = requireActiveMember(ctx, input);
  if (memberError) return memberError;
  if (typeof input.sprint !== 'string' || input.sprint.trim().length === 0) {
    return ctx.toolError(
      'invalid_sprint_target',
      'sprint must be a non-empty slug or sprint_id'
    );
  }
  const sprintTarget = input.sprint.trim();

  const target = findSprintByTarget(ctx, input.space_id, sprintTarget);
  if (!target) {
    return ctx.toolError('sprint_not_found', 'no sprint with that slug or id');
  }
  if (target.status !== 'active') {
    return ctx.toolError(
      'sprint_archived',
      'reopen archived sprint before join',
      {
        hint: 'reopen',
        sprint: sprintFromRow(target)
      }
    );
  }

  const oldSprint = readCurrentSprint(ctx, input.space_id, input.principal);
  if (oldSprint?.sprint_id === target.sprint_id) {
    const context = sprintContext(target);
    return {
      ok: true,
      data: {
        sprint: sprintFromRow(target),
        old_context: context,
        new_context: context,
        event_ids: [],
        idempotent: true,
        message: `Already in ${target.slug}.`,
        warnings: contextWarnings(ctx, input, target.sprint_id)
      }
    };
  }

  const eventIds: string[] = [];
  try {
    ctx.db
      .transaction(() => {
        if (oldSprint) {
          const leaveEvent = buildSprintEvent(ctx, input, 'sprint_left', {
            sprint_id: oldSprint.sprint_id,
            slug: oldSprint.slug,
            reason: 'switch'
          });
          appendSprintEventInTx(ctx, leaveEvent);
          eventIds.push(leaveEvent.event_id);
        }

        const joinEvent = buildSprintEvent(ctx, input, 'sprint_joined', {
          sprint_id: target.sprint_id,
          slug: target.slug,
          previous_sprint_id: oldSprint?.sprint_id ?? null
        });
        appendSprintEventInTx(ctx, joinEvent);
        eventIds.push(joinEvent.event_id);
      })
      .immediate();
  } catch (error) {
    return ctx.toolError('sprint_join_failed', 'failed to join sprint', {
      reason: (error as Error).message
    });
  }

  return {
    ok: true,
    data: {
      sprint: sprintFromRow(target),
      old_context: sprintContext(oldSprint),
      new_context: sprintContext(target),
      event_ids: eventIds,
      idempotent: false,
      message: oldSprint
        ? `Left ${oldSprint.slug}; joined ${target.slug}.`
        : `Joined ${target.slug}.`,
      warnings: contextWarnings(ctx, input, target.sprint_id)
    }
  };
}

export function leaveSprint(
  ctx: ToolContext,
  input: {
    space_id: string;
    principal: string;
    actor?: string;
    delegation?: string;
  }
): ToolResponse<SprintLifecycleResponse> {
  const memberError = requireActiveMember(ctx, input);
  if (memberError) return memberError;
  const oldSprint = readCurrentSprint(ctx, input.space_id, input.principal);
  if (!oldSprint) {
    return {
      ok: true,
      data: {
        sprint: null,
        old_context: spaceContext(),
        new_context: spaceContext(),
        event_ids: [],
        idempotent: true,
        message: 'Already in Space mode.',
        warnings: []
      }
    };
  }

  const oldContextClaimCount = activeClaimCountInContext(
    ctx,
    input,
    oldSprint.sprint_id
  );
  const leaveEvent = buildSprintEvent(ctx, input, 'sprint_left', {
    sprint_id: oldSprint.sprint_id,
    slug: oldSprint.slug,
    reason: 'leave'
  });
  try {
    ctx.db
      .transaction(() => {
        appendSprintEventInTx(ctx, leaveEvent);
      })
      .immediate();
  } catch (error) {
    return ctx.toolError('sprint_leave_failed', 'failed to leave sprint', {
      reason: (error as Error).message
    });
  }

  return {
    ok: true,
    data: {
      sprint: null,
      old_context: sprintContext(oldSprint),
      new_context: spaceContext(),
      event_ids: [leaveEvent.event_id],
      idempotent: false,
      message:
        oldContextClaimCount > 0
          ? `Left ${oldSprint.slug}; now in Space mode. ${oldContextClaimCount} active claim${oldContextClaimCount === 1 ? '' : 's'} from ${oldSprint.slug} remain active outside the current context.`
          : `Left ${oldSprint.slug}; now in Space mode.`,
      warnings: contextWarnings(ctx, input, null)
    }
  };
}

export function getCurrentSprint(
  ctx: ToolContext,
  input: { space_id: string; principal: string }
): ToolResponse<{
  context: SprintContextMode;
  sprint: SprintSummary | null;
  current_members: string[];
}> {
  const memberError = requireActiveMember(ctx, input);
  if (memberError) return memberError;
  const current = readCurrentSprint(ctx, input.space_id, input.principal);
  return {
    ok: true,
    data: {
      context: sprintContext(current),
      sprint: current ? sprintFromRow(current) : null,
      current_members: currentMembersForSprint(
        ctx,
        input.space_id,
        current?.sprint_id ?? null
      )
    }
  };
}

export function listSprints(
  ctx: ToolContext,
  input: { space_id: string; principal: string }
): ToolResponse<{ sprints: SprintInventoryItem[] }> {
  const memberError = requireActiveMember(ctx, input);
  if (memberError) return memberError;

  const rows = ctx.db
    .prepare(
      `SELECT
         s.sprint_id,
         s.slug,
         s.display_name,
         s.goal,
         s.status,
         COALESCE(
           (
             SELECT MAX(e.timestamp)
             FROM events e
             WHERE e.space_id = s.space_id
               AND json_extract(e.payload_json, '$.sprint_id') = s.sprint_id
           ),
           s.archived_at,
           s.created_at
         ) AS last_activity_at,
         COALESCE(
           (
             SELECT json_group_array(sm.principal)
             FROM sprint_memberships sm
             WHERE sm.space_id = s.space_id
               AND sm.sprint_id = s.sprint_id
             ORDER BY sm.principal
           ),
           '[]'
         ) AS current_members_json
       FROM sprints s
       WHERE s.space_id = ?1
       ORDER BY last_activity_at DESC, s.slug ASC`
    )
    .all(input.space_id) as Array<
    SprintRow & {
      last_activity_at: string | null;
      current_members_json: string;
    }
  >;

  return {
    ok: true,
    data: {
      sprints: rows.map((row) => ({
        ...sprintFromRow(row),
        current_members: ctx.parseStringArray(
          JSON.parse(row.current_members_json)
        ),
        last_activity_at: row.last_activity_at
      }))
    }
  };
}

export function archiveSprint(
  ctx: ToolContext,
  input: {
    space_id: string;
    principal: string;
    actor?: string;
    delegation?: string;
    sprint: unknown;
  }
): ToolResponse<SprintArchiveResponse> {
  const memberError = requireActiveMember(ctx, input);
  if (memberError) return memberError;
  if (typeof input.sprint !== 'string' || input.sprint.trim().length === 0) {
    return ctx.toolError(
      'invalid_sprint_target',
      'sprint must be a non-empty slug or sprint_id'
    );
  }
  const sprintTarget = input.sprint.trim();

  const target = findSprintByTarget(ctx, input.space_id, sprintTarget);
  if (!target) {
    return ctx.toolError('sprint_not_found', 'no sprint with that slug or id');
  }
  if (target.status === 'archived') {
    return {
      ok: true,
      data: {
        sprint: sprintFromRow(target),
        event_ids: [],
        idempotent: true,
        released_claims: [],
        message: `${target.slug} is already archived.`
      }
    };
  }

  const members = memberCountForSprint(ctx, input.space_id, target.sprint_id);
  if (members > 0) {
    return ctx.toolError(
      'sprint_has_members',
      'archive requires every member to leave the Sprint first',
      { sprint: sprintFromRow(target), current_member_count: members }
    );
  }

  const eventIds: string[] = [];
  const releasedClaims: SprintArchiveResponse['released_claims'] = [];

  try {
    ctx.db
      .transaction(() => {
        const fresh = findSprintByTarget(ctx, input.space_id, sprintTarget);
        if (!fresh) throw new Error('sprint disappeared during archive');
        if (fresh.status === 'archived') return;

        const freshMemberCount = memberCountForSprint(
          ctx,
          input.space_id,
          fresh.sprint_id
        );
        if (freshMemberCount > 0) {
          throw new Error('sprint_has_members');
        }

        const now = new Date().toISOString();
        const archiveEvent = buildSprintEvent(ctx, input, 'sprint_archived', {
          sprint_id: fresh.sprint_id,
          slug: fresh.slug,
          archived_by: input.principal
        });
        archiveEvent.timestamp = now;
        appendSprintEventInTx(ctx, archiveEvent);
        insertUnreadNotificationInTx(ctx, input, archiveEvent);
        eventIds.push(archiveEvent.event_id);

        const activeClaims = ctx.db
          .prepare(
            `SELECT claim_id, principal, scope_json, repo_id, branch, path, sprint_id
             FROM claims
             WHERE space_id = ?1
               AND sprint_id = ?2
               AND status IN ('active', 'paused')
               AND tombstoned_at IS NULL
             ORDER BY created_at ASC`
          )
          .all(input.space_id, fresh.sprint_id) as Array<{
          claim_id: string;
          principal: string;
          scope_json: string;
          repo_id: string;
          branch: string;
          path: string;
          sprint_id: string;
        }>;

        for (const claim of activeClaims) {
          const releaseEvent = buildArchiveClaimReleaseEvent(
            ctx,
            input,
            claim,
            fresh,
            now
          );
          ctx.store.appendInTx(releaseEvent);
          ctx.applyProjectionUpdate(ctx.db, releaseEvent);
          insertUnreadNotificationInTx(ctx, input, releaseEvent);
          eventIds.push(releaseEvent.event_id);
          releasedClaims.push({
            claim_id: claim.claim_id,
            original_holder: claim.principal,
            event_id: releaseEvent.event_id
          });
        }
      })
      .immediate();
  } catch (error) {
    const reason = (error as Error).message;
    if (reason === 'sprint_has_members') {
      return ctx.toolError(
        'sprint_has_members',
        'archive requires every member to leave the Sprint first',
        { sprint: sprintFromRow(target) }
      );
    }
    return ctx.toolError('sprint_archive_failed', 'failed to archive sprint', {
      reason
    });
  }

  const archived = readSprintById(ctx, input.space_id, target.sprint_id);
  return {
    ok: true,
    data: {
      sprint: sprintFromRow(archived ?? target),
      event_ids: eventIds,
      idempotent: false,
      released_claims: releasedClaims,
      message:
        releasedClaims.length > 0
          ? `Archived ${target.slug}; force-released ${releasedClaims.length} remaining claim${releasedClaims.length === 1 ? '' : 's'}.`
          : `Archived ${target.slug}.`
    }
  };
}

export function reopenSprint(
  ctx: ToolContext,
  input: {
    space_id: string;
    principal: string;
    actor?: string;
    delegation?: string;
    sprint: unknown;
  }
): ToolResponse<SprintLifecycleResponse> {
  const memberError = requireActiveMember(ctx, input);
  if (memberError) return memberError;
  if (typeof input.sprint !== 'string' || input.sprint.trim().length === 0) {
    return ctx.toolError(
      'invalid_sprint_target',
      'sprint must be a non-empty slug or sprint_id'
    );
  }
  const sprintTarget = input.sprint.trim();

  const target = findSprintByTarget(ctx, input.space_id, sprintTarget);
  if (!target) {
    return ctx.toolError('sprint_not_found', 'no sprint with that slug or id');
  }

  const oldSprint = readCurrentSprint(ctx, input.space_id, input.principal);
  if (target.status === 'active') {
    if (oldSprint?.sprint_id === target.sprint_id) {
      const context = sprintContext(target);
      return {
        ok: true,
        data: {
          sprint: sprintFromRow(target),
          old_context: context,
          new_context: context,
          event_ids: [],
          idempotent: true,
          message: `Already in ${target.slug}.`,
          warnings: contextWarnings(ctx, input, target.sprint_id)
        }
      };
    }
    return ctx.toolError(
      'sprint_active_use_join',
      'Sprint is active; use join instead of reopen',
      { hint: 'join', sprint: sprintFromRow(target) }
    );
  }

  const eventIds: string[] = [];
  try {
    ctx.db
      .transaction(() => {
        const fresh = findSprintByTarget(ctx, input.space_id, sprintTarget);
        if (!fresh) throw new Error('sprint disappeared during reopen');
        if (fresh.status === 'active') return;

        const reopenEvent = buildSprintEvent(ctx, input, 'sprint_reopened', {
          sprint_id: fresh.sprint_id,
          slug: fresh.slug,
          reopened_by: input.principal
        });
        appendSprintEventInTx(ctx, reopenEvent);
        insertUnreadNotificationInTx(ctx, input, reopenEvent);
        eventIds.push(reopenEvent.event_id);

        if (oldSprint) {
          const leaveEvent = buildSprintEvent(ctx, input, 'sprint_left', {
            sprint_id: oldSprint.sprint_id,
            slug: oldSprint.slug,
            reason: 'switch'
          });
          appendSprintEventInTx(ctx, leaveEvent);
          eventIds.push(leaveEvent.event_id);
        }

        const joinEvent = buildSprintEvent(ctx, input, 'sprint_joined', {
          sprint_id: fresh.sprint_id,
          slug: fresh.slug,
          previous_sprint_id: oldSprint?.sprint_id ?? null,
          reason: 'reopen'
        });
        appendSprintEventInTx(ctx, joinEvent);
        eventIds.push(joinEvent.event_id);
      })
      .immediate();
  } catch (error) {
    return ctx.toolError('sprint_reopen_failed', 'failed to reopen sprint', {
      reason: (error as Error).message
    });
  }

  const reopened = readSprintById(ctx, input.space_id, target.sprint_id);
  return {
    ok: true,
    data: {
      sprint: sprintFromRow(reopened ?? target),
      old_context: sprintContext(oldSprint),
      new_context: sprintContext(reopened ?? target),
      event_ids: eventIds,
      idempotent: false,
      message: oldSprint
        ? `Reopened ${target.slug}; left ${oldSprint.slug}; joined ${target.slug}.`
        : `Reopened and joined ${target.slug}.`,
      warnings: contextWarnings(ctx, input, target.sprint_id)
    }
  };
}

export function getSprintHistory(
  ctx: ToolContext,
  input: {
    space_id: string;
    principal: string;
    sprint: unknown;
    limit?: unknown;
  }
): ToolResponse<{
  sprint: SprintSummary;
  events: SprintHistoryItem[];
  limit: number;
  truncated: boolean;
}> {
  const memberError = requireActiveMember(ctx, input);
  if (memberError) return memberError;
  if (typeof input.sprint !== 'string' || input.sprint.trim().length === 0) {
    return ctx.toolError(
      'invalid_sprint_target',
      'sprint must be a non-empty slug or sprint_id'
    );
  }

  const target = findSprintByTarget(ctx, input.space_id, input.sprint.trim());
  if (!target) {
    return ctx.toolError('sprint_not_found', 'no sprint with that slug or id');
  }

  const requestedLimit =
    typeof input.limit === 'number'
      ? input.limit
      : typeof input.limit === 'string' && input.limit.trim().length > 0
        ? Number(input.limit)
        : DEFAULT_HISTORY_LIMIT;
  if (
    !Number.isInteger(requestedLimit) ||
    requestedLimit < 1 ||
    requestedLimit > MAX_HISTORY_LIMIT
  ) {
    return ctx.toolError(
      'invalid_history_limit',
      `limit must be an integer from 1 to ${MAX_HISTORY_LIMIT}`
    );
  }

  const rows = ctx.db
    .prepare(
      `SELECT raw_json
       FROM events
       WHERE space_id = ?1
         AND (
           (
             event_type IN ('sprint_created', 'sprint_joined', 'sprint_left', 'sprint_archived', 'sprint_reopened')
             AND json_extract(payload_json, '$.sprint_id') = ?2
           )
           OR (
             event_type = 'claim_force_released'
             AND json_extract(payload_json, '$.archive_cleanup') = 1
             AND json_extract(raw_json, '$.sprint_id') = ?2
           )
         )
       ORDER BY timestamp DESC, rowid DESC
       LIMIT ?3`
    )
    .all(input.space_id, target.sprint_id, requestedLimit + 1) as Array<{
    raw_json: string;
  }>;
  const selectedRows = rows.slice(0, requestedLimit);
  const events = selectedRows
    .map((row) => JSON.parse(row.raw_json) as TeamemEvent)
    .reverse()
    .map((event) => ({
      event_id: event.event_id,
      event_type: event.event_type,
      timestamp: event.timestamp,
      principal: event.principal,
      sprint_id: String(
        (event.payload.sprint_id as string | undefined) ??
          event.sprint_id ??
          target.sprint_id
      ),
      summary: sprintHistorySummary(event),
      payload: event.payload
    }));

  return {
    ok: true,
    data: {
      sprint: sprintFromRow(target),
      events,
      limit: requestedLimit,
      truncated: rows.length > requestedLimit
    }
  };
}
