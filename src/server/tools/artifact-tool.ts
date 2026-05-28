import type { ToolContext } from './context.js';
import type { TeamemEvent } from '../../domain/events/types.js';
import type { ToolResponse } from '../types.js';

export function shareArtifact(
  ctx: ToolContext,
  input: {
    space_id: string;
    principal: string;
    actor: string;
    delegation: string;
    kind: unknown;
    uri: unknown;
    title: unknown;
    summary?: unknown;
  }
): ToolResponse<{ artifact_id: string; event_id: string }> {
  const kind = input.kind;
  if (
    kind !== 'spec' &&
    kind !== 'fixture' &&
    kind !== 'doc' &&
    kind !== 'snippet'
  ) {
    return ctx.toolError(
      'invalid_kind',
      'kind must be one of spec | fixture | doc | snippet'
    );
  }

  const uri = typeof input.uri === 'string' ? input.uri : '';
  if (uri.length === 0) {
    return ctx.toolError('invalid_uri', 'uri must be a non-empty string');
  }
  if (uri.length > 1024) {
    return ctx.toolError('invalid_uri', 'uri must not exceed 1024 characters');
  }

  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (title.length === 0) {
    return ctx.toolError('invalid_title', 'title must be a non-empty string');
  }
  if (title.length > 200) {
    return ctx.toolError(
      'invalid_title',
      'title must not exceed 200 characters'
    );
  }

  const summary =
    typeof input.summary === 'string' && input.summary.length > 0
      ? input.summary
      : undefined;

  const artifactId = ctx.ulid();
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
    event_type: 'artifact_shared',
    ...ctx.routingMetadataForPrincipal(ctx.db, input, {
      delivery: 'broadcast'
    }),
    scope: {},
    payload: {
      artifact_id: artifactId,
      kind,
      uri,
      title,
      ...(summary !== undefined ? { summary } : {})
    }
  };

  ctx.store.append(event);
  ctx.applyProjectionUpdate(ctx.db, event);

  return {
    ok: true,
    data: {
      artifact_id: artifactId,
      event_id: event.event_id
    }
  };
}
