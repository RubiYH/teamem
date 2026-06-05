import type { ToolContext } from './context.js';
import type { TeamemEvent } from '../../domain/events/types.js';
import type { ToolResponse } from '../types.js';

export function shareFinding(
  ctx: ToolContext,
  input: {
    space_id: string;
    principal: string;
    actor: string;
    delegation: string;
    summary: unknown;
    body?: unknown;
    kind?: unknown;
    status?: unknown;
    paths?: unknown;
    tags?: unknown;
    recipient_principals?: unknown;
    severity?: unknown;
    refs?: unknown;
    scope?: 'current' | 'space';
  }
): ToolResponse<{
  finding_id: string;
  event_id: string;
  kind: 'finding' | 'gotcha';
  lifecycle: 'ttl' | 'persistent';
  status: 'active' | 'resolved' | 'archived';
  version: number;
  expires_at: string | null;
  sprint_id: string | null;
  context: 'space' | 'sprint';
}> {
  const summary = typeof input.summary === 'string' ? input.summary.trim() : '';
  if (summary.length === 0) {
    return ctx.toolError(
      'invalid_summary',
      'summary must be a non-empty string'
    );
  }
  if (summary.length > 280) {
    return ctx.toolError(
      'invalid_summary',
      'summary must not exceed 280 characters'
    );
  }

  const tagsArray = Array.isArray(input.tags)
    ? (input.tags as unknown[]).filter(
        (t): t is string => typeof t === 'string'
      )
    : [];
  if (tagsArray.length > 32) {
    return ctx.toolError('invalid_tags', 'tags must not exceed 32 entries');
  }
  const tags = Array.from(new Set(tagsArray));
  const recipientPrincipals = Array.from(
    new Set(ctx.parseStringArray(input.recipient_principals))
  ).filter((recipient) => recipient !== input.principal);

  const kind = input.kind === 'gotcha' ? 'gotcha' : 'finding';
  const lifecycle = kind === 'gotcha' ? 'persistent' : 'ttl';
  const status =
    input.status === 'resolved' || input.status === 'archived'
      ? input.status
      : 'active';
  const severity =
    input.severity === 'urgent' ||
    input.severity === 'warning' ||
    input.severity === 'info'
      ? input.severity
      : 'info';

  const body =
    typeof input.body === 'string' && input.body.length > 0 ? input.body : '';

  const refs = ctx.parseFindingRefs(input.refs);
  const paths = ctx.parseFindingPaths(input.paths, refs);

  const findingId = ctx.ulid();
  const version = 1;
  const now = new Date();
  const timestamp = now.toISOString();
  const expiresAt =
    lifecycle === 'ttl'
      ? new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString()
      : null;

  const event: TeamemEvent = {
    schema_version: '1.0',
    event_id: ctx.newEventId(),
    idempotency_key: ctx.newIdempotencyKey(),
    space_id: input.space_id,
    timestamp,
    principal: input.principal,
    actor: input.actor,
    delegation: input.delegation,
    event_type: 'finding_shared',
    ...ctx.routingMetadataForPrincipal(
      ctx.db,
      input,
      input.scope === 'space'
        ? { delivery: 'space' }
        : recipientPrincipals.length > 0
          ? { delivery: 'direct', recipient_principals: recipientPrincipals }
          : { delivery: 'broadcast' }
    ),
    scope:
      paths.length > 0
        ? { paths }
        : refs.modules
          ? { modules: refs.modules }
          : {},
    payload: {
      finding_id: findingId,
      kind,
      lifecycle,
      status,
      version,
      summary,
      body,
      paths,
      tags,
      recipient_principals: recipientPrincipals,
      severity,
      refs,
      expires_at: expiresAt
    }
  };

  ctx.store.append(event);
  ctx.applyProjectionUpdate(ctx.db, event);

  return {
    ok: true,
    data: {
      finding_id: findingId,
      event_id: event.event_id,
      kind,
      lifecycle,
      status,
      version,
      expires_at: expiresAt,
      sprint_id: event.sprint_id ?? null,
      context: event.sprint_id == null ? 'space' : 'sprint'
    }
  };
}

export function getFinding(
  ctx: ToolContext,
  input: {
    space_id: string;
    principal: string;
    finding_id: string;
  }
): ToolResponse<{
  finding_id: string;
  kind: 'finding' | 'gotcha';
  lifecycle: 'ttl' | 'persistent';
  status: 'active' | 'resolved' | 'archived';
  version: number;
  principal: string;
  summary: string;
  body: string | null;
  paths: string[];
  tags: string[];
  recipient_principals: string[];
  severity: 'info' | 'warning' | 'urgent';
  refs: { paths?: string[]; modules?: string[] } | null;
  created_at: string;
  expires_at: string | null;
  source_event_id: string;
}> {
  const findingId =
    typeof input.finding_id === 'string' ? input.finding_id.trim() : '';
  if (findingId.length === 0) {
    return ctx.toolError(
      'invalid_finding_id',
      'finding_id must be a non-empty string'
    );
  }

  try {
    const row = ctx.db
      .prepare(
        `SELECT finding_id, kind, lifecycle, status, version, principal,
                summary, body, paths_json, tags_json,
                recipient_principals_json, severity, refs_json,
                created_at, expires_at, source_event_id
           FROM findings
          WHERE space_id = ?1
            AND finding_id = ?2
            AND tombstoned_at IS NULL`
      )
      .get(input.space_id, findingId) as {
      finding_id: string;
      kind: 'finding' | 'gotcha';
      lifecycle: 'ttl' | 'persistent';
      status: 'active' | 'resolved' | 'archived';
      version: number;
      principal: string;
      summary: string;
      body: string | null;
      paths_json: string;
      tags_json: string;
      recipient_principals_json: string;
      severity: 'info' | 'warning' | 'urgent';
      refs_json: string | null;
      created_at: string;
      expires_at: string | null;
      source_event_id: string;
    } | null;

    if (!row) {
      return ctx.toolError('finding_not_found', 'finding not found');
    }
    const recipientPrincipals = ctx.parseJsonStringArray(
      row.recipient_principals_json
    );
    if (
      row.kind === 'gotcha' &&
      recipientPrincipals.length > 0 &&
      row.principal !== input.principal &&
      !recipientPrincipals.includes(input.principal)
    ) {
      return ctx.toolError('finding_not_found', 'finding not found');
    }

    const refs = ctx.parseNullableFindingRefs(row.refs_json);

    return {
      ok: true,
      data: {
        finding_id: row.finding_id,
        kind: row.kind,
        lifecycle: row.lifecycle,
        status: row.status,
        version: row.version,
        principal: row.principal,
        summary: row.summary,
        body: row.body,
        paths: ctx.parseJsonStringArray(row.paths_json),
        tags: ctx.parseJsonStringArray(row.tags_json),
        recipient_principals: recipientPrincipals,
        severity: row.severity,
        refs,
        created_at: row.created_at,
        expires_at: row.expires_at,
        source_event_id: row.source_event_id
      }
    };
  } catch (err) {
    const e = err as { message?: string };
    if (e?.message?.includes('no such table: findings')) {
      return ctx.toolError('finding_not_found', 'finding not found');
    }
    throw err;
  }
}

export function acknowledgeFinding(
  ctx: ToolContext,
  input: {
    space_id: string;
    principal: string;
    actor: string;
    delegation: string;
    finding_id: unknown;
    version?: unknown;
    note?: unknown;
  }
): ToolResponse<{
  finding_id: string;
  version: number;
  acknowledged_at: string;
  already_acknowledged: boolean;
  meaning: 'seen';
}> {
  const findingId =
    typeof input.finding_id === 'string' ? input.finding_id.trim() : '';
  if (findingId.length === 0) {
    return ctx.toolError(
      'invalid_finding_id',
      'finding_id must be a non-empty string'
    );
  }
  const version =
    typeof input.version === 'number' &&
    Number.isInteger(input.version) &&
    input.version > 0
      ? input.version
      : 1;
  const note =
    typeof input.note === 'string' && input.note.length > 0
      ? input.note
      : undefined;

  try {
    const finding = ctx.db
      .prepare(
        `SELECT version
           FROM findings
          WHERE space_id = ?1
            AND finding_id = ?2
            AND tombstoned_at IS NULL
          LIMIT 1`
      )
      .get(input.space_id, findingId) as { version: number } | null;
    if (!finding) {
      return ctx.toolError('finding_not_found', 'finding not found');
    }
    if (finding.version < version) {
      return ctx.toolError(
        'invalid_version',
        'version is newer than the current finding version'
      );
    }

    const existing = ctx.db
      .prepare(
        `SELECT acknowledged_at
           FROM finding_acknowledgements
          WHERE space_id = ?1
            AND finding_id = ?2
            AND version = ?3
            AND principal = ?4
          LIMIT 1`
      )
      .get(input.space_id, findingId, version, input.principal) as {
      acknowledged_at: string;
    } | null;
    if (existing) {
      return {
        ok: true,
        data: {
          finding_id: findingId,
          version,
          acknowledged_at: existing.acknowledged_at,
          already_acknowledged: true,
          meaning: 'seen'
        }
      };
    }

    const timestamp = new Date().toISOString();
    const event: TeamemEvent = {
      schema_version: '1.0',
      event_id: ctx.newEventId(),
      idempotency_key: `finding-ack:${input.space_id}:${findingId}:${version}:${input.principal}`,
      space_id: input.space_id,
      timestamp,
      principal: input.principal,
      actor: input.actor,
      delegation: input.delegation,
      event_type: 'acknowledgment_recorded',
      ...ctx.routingMetadataForPrincipal(ctx.db, input, {
        delivery: 'broadcast'
      }),
      scope: {},
      payload: {
        finding_id: findingId,
        version,
        acknowledged_by: input.principal,
        acknowledgment_kind: 'seen',
        ...(note ? { note } : {})
      }
    };

    return ctx.db
      .transaction(() => {
        ctx.store.appendInTx(event);
        ctx.applyProjectionUpdate(ctx.db, event);
        return {
          ok: true as const,
          data: {
            finding_id: findingId,
            version,
            acknowledged_at: timestamp,
            already_acknowledged: false,
            meaning: 'seen' as const
          }
        };
      })
      .immediate() as ToolResponse<{
      finding_id: string;
      version: number;
      acknowledged_at: string;
      already_acknowledged: boolean;
      meaning: 'seen';
    }>;
  } catch (err) {
    const e = err as { message?: string };
    if (
      e?.message?.includes('no such table: findings') ||
      e?.message?.includes('no such table: finding_acknowledgements')
    ) {
      return ctx.toolError(
        'acknowledgements_unavailable',
        'finding acknowledgement storage is unavailable'
      );
    }
    throw err;
  }
}
