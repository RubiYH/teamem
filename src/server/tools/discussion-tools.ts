import type { ToolContext } from './context.js';
import type { TeamemEvent } from '../../domain/events/types.js';
import type { ToolResponse } from '../types.js';

export function postMessage(
  ctx: ToolContext,
  input: {
    space_id: string;
    principal: string;
    actor: string;
    delegation: string;
    body: string;
    recipient_principal?: string | null;
    thread_id?: string;
    in_reply_to?: string;
    policy_decision?: 'autonomous_safe' | 'human_approved';
    policy_reason?: string;
    request_id?: string;
  }
): ToolResponse<{
  message_id: string;
  thread_id: string;
  event_id: string;
  delivery_scope: 'direct' | 'sprint' | 'space';
  sprint_id: string | null;
  recipient_principals: string[];
  broadcast_hint?: string;
}> {
  if (typeof input.body !== 'string' || input.body.length === 0) {
    return ctx.toolError('invalid_body', 'body must be a non-empty string');
  }
  if (Buffer.byteLength(input.body, 'utf8') > 65536) {
    return ctx.toolError('invalid_body', 'body exceeds 65536 bytes');
  }
  if (
    input.recipient_principal !== undefined &&
    input.recipient_principal !== null &&
    typeof input.recipient_principal !== 'string'
  ) {
    return ctx.toolError(
      'invalid_recipient',
      'recipient_principal must be a string or null'
    );
  }
  if (input.thread_id !== undefined && input.thread_id.length > 64) {
    return ctx.toolError(
      'invalid_thread_id',
      'thread_id must not exceed 64 characters'
    );
  }
  if (input.in_reply_to !== undefined && input.in_reply_to.length > 64) {
    return ctx.toolError(
      'invalid_reply_target',
      'in_reply_to must not exceed 64 characters'
    );
  }

  let senderSprintId: string | null;
  try {
    senderSprintId = readCurrentSprintId(ctx, input.space_id, input.principal);
  } catch (error) {
    return ctx.toolError(
      'sprint_context_unavailable',
      'failed to read current Sprint membership',
      { reason: error instanceof Error ? error.message : String(error) }
    );
  }
  const requestedSpaceWideEscalation = input.recipient_principal === '**';
  const requestedBroadcast =
    input.recipient_principal === '*' ||
    input.recipient_principal === '**' ||
    input.recipient_principal == null;
  const messageId = ctx.ulid();
  const threadId = input.thread_id || messageId;
  const existingThread = input.thread_id
    ? ctx.loadDiscussionThreadMetadata(ctx.db, input.space_id, input.thread_id)
    : null;
  if (input.thread_id && !existingThread) {
    return ctx.toolError(
      'thread_not_found',
      `thread_id=${input.thread_id} does not exist`
    );
  }

  let visibilityMode: 'broadcast' | 'direct' = requestedBroadcast
    ? 'broadcast'
    : 'direct';
  let participantPrincipals: string[] = [];
  let recipientPrincipal: string | null = requestedBroadcast
    ? null
    : (input.recipient_principal ?? null);

  if (existingThread) {
    const authorization = ctx.authorizeDiscussionThreadAccess(
      ctx.db,
      input.space_id,
      input.principal,
      existingThread
    );
    if (!authorization.allowed) {
      return ctx.toolError(
        'discussion_forbidden',
        'principal is not allowed to reply in this thread'
      );
    }

    visibilityMode = existingThread.visibility_mode;
    participantPrincipals = existingThread.participant_principals;

    if (existingThread.visibility_mode === 'broadcast') {
      if (
        input.recipient_principal !== undefined &&
        input.recipient_principal !== null
      ) {
        return ctx.toolError(
          'invalid_reply_visibility',
          'broadcast replies must preserve recipient_principal = null'
        );
      }
      recipientPrincipal = null;
    } else {
      if (!existingThread.participant_principals.includes(input.principal)) {
        return ctx.toolError(
          'discussion_forbidden',
          'principal is not a participant in this direct thread'
        );
      }
      const resolvedRecipient = ctx.resolveDirectReplyRecipient(
        input.principal,
        input.recipient_principal,
        existingThread.participant_principals
      );
      if (resolvedRecipient instanceof Error) {
        return ctx.toolError(
          'invalid_reply_visibility',
          resolvedRecipient.message
        );
      }
      recipientPrincipal = resolvedRecipient;
    }
  } else if (recipientPrincipal !== null) {
    if (recipientPrincipal === input.principal) {
      return ctx.toolError(
        'invalid_recipient',
        'recipient_principal must name another teammate'
      );
    }
    participantPrincipals = ctx.dedupeSorted([
      input.principal,
      recipientPrincipal
    ]);
  }

  const idempotencyKey = ctx.deterministicMessageIdempotencyKey(
    input.space_id,
    input.principal,
    recipientPrincipal ??
      (requestedSpaceWideEscalation
        ? '**'
        : senderSprintId
          ? `sprint:${senderSprintId}`
          : null),
    input.thread_id,
    input.in_reply_to,
    input.body,
    input.request_id
  );
  const deliveryScope =
    recipientPrincipal !== null
      ? 'direct'
      : senderSprintId && !requestedSpaceWideEscalation
        ? 'sprint'
        : 'space';
  const eventSprintId =
    deliveryScope === 'space' ? null : (senderSprintId ?? null);
  const recipientPrincipals =
    recipientPrincipal === null ? [] : [recipientPrincipal];
  const event: TeamemEvent = {
    schema_version: '1.0',
    event_id: ctx.newEventId(),
    idempotency_key: idempotencyKey,
    space_id: input.space_id,
    timestamp: new Date().toISOString(),
    principal: input.principal,
    actor: input.actor,
    delegation: input.delegation,
    event_type: 'discussion_posted',
    sprint_id: eventSprintId,
    delivery_scope: deliveryScope,
    ...(recipientPrincipals.length > 0
      ? { recipient_principals: recipientPrincipals }
      : {}),
    scope: {},
    payload: {
      message_id: messageId,
      thread_id: threadId,
      recipient_principal: recipientPrincipal,
      body: input.body,
      in_reply_to: input.in_reply_to ?? null,
      visibility_mode: visibilityMode,
      participant_principals: participantPrincipals,
      sender_sprint_id: senderSprintId,
      broadcast_marker: requestedSpaceWideEscalation
        ? '**'
        : requestedBroadcast
          ? '*'
          : null,
      ...ctx.readDiscussionHelperPolicy(input)
    }
  };

  try {
    ctx.store.append(event);
  } catch (appendErr) {
    const isIdempotencyError =
      appendErr instanceof Error &&
      (appendErr.message.includes('Idempotency conflict') ||
        appendErr.message.includes('UNIQUE') ||
        appendErr.message.includes('SQLITE_CONSTRAINT'));
    if (!isIdempotencyError) throw appendErr;

    // Idempotent retry — look up the original event and return its message data.
    const existingRow = ctx.db
      .query('SELECT event_id FROM idempotency_keys WHERE idempotency_key = ?1')
      .get(idempotencyKey) as { event_id: string } | null;
    if (existingRow) {
      const storedEventRow = ctx.db
        .query('SELECT raw_json FROM events WHERE event_id = ?1')
        .get(existingRow.event_id) as { raw_json: string } | null;
      if (storedEventRow) {
        const storedEvent = JSON.parse(storedEventRow.raw_json) as TeamemEvent;
        const p = storedEvent.payload as {
          message_id?: string;
          thread_id?: string;
        };
        if (p.message_id && p.thread_id) {
          return {
            ok: true,
            data: {
              message_id: p.message_id,
              thread_id: p.thread_id,
              event_id: existingRow.event_id,
              delivery_scope: storedEvent.delivery_scope ?? 'space',
              sprint_id: storedEvent.sprint_id ?? null,
              recipient_principals: storedEvent.recipient_principals ?? []
            }
          };
        }
      }
    }
    throw appendErr;
  }
  ctx.applyProjectionUpdate(ctx.db, event);

  return {
    ok: true,
    data: {
      message_id: messageId,
      thread_id: threadId,
      event_id: event.event_id,
      delivery_scope: deliveryScope,
      sprint_id: eventSprintId,
      recipient_principals: recipientPrincipals,
      ...(deliveryScope === 'sprint'
        ? { broadcast_hint: 'Sprint broadcast; use ** for Space-wide.' }
        : {})
    }
  };
}

function readCurrentSprintId(
  ctx: ToolContext,
  spaceId: string,
  principal: string
): string | null {
  try {
    const row = ctx.db
      .prepare(
        `SELECT sm.sprint_id
           FROM sprint_memberships sm
           JOIN sprints s ON s.sprint_id = sm.sprint_id
          WHERE sm.space_id = ?1
            AND sm.principal = ?2
            AND sm.sprint_id IS NOT NULL
            AND s.status = 'active'
          LIMIT 1`
      )
      .get(spaceId, principal) as { sprint_id: string } | null;
    return row?.sprint_id ?? null;
  } catch (error) {
    if (isMissingSprintContextTableError(error)) return null;
    throw error;
  }
}

function isMissingSprintContextTableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.message.includes('no such table: sprint_memberships') ||
    error.message.includes('no such table: sprints')
  );
}

export function readThread(
  ctx: ToolContext,
  input: {
    space_id: string;
    principal: string;
    thread_id?: string;
    since?: string;
    limit?: number;
  }
): ToolResponse<{
  messages: Array<{
    message_id: string;
    thread_id: string;
    sender_principal: string;
    recipient_principal: string | null;
    body: string;
    in_reply_to: string | null;
    created_at: string;
  }>;
}> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const memberStatus = ctx.getSpaceMembershipStatus(
    ctx.db,
    input.space_id,
    input.principal
  );
  if (memberStatus === 'inactive') {
    return input.thread_id
      ? ctx.toolError(
          'discussion_forbidden',
          'principal is not an active member of this space'
        )
      : { ok: true, data: { messages: [] } };
  }

  let rows: Array<{
    message_id: string;
    thread_id: string;
    sender_principal: string;
    recipient_principal: string | null;
    body: string;
    in_reply_to: string | null;
    created_at: string;
  }>;

  try {
    if (input.thread_id) {
      const thread = ctx.loadDiscussionThreadMetadata(
        ctx.db,
        input.space_id,
        input.thread_id
      );
      if (!thread) {
        return { ok: true, data: { messages: [] } };
      }
      const authorization = ctx.authorizeDiscussionThreadAccess(
        ctx.db,
        input.space_id,
        input.principal,
        thread
      );
      if (!authorization.allowed) {
        return ctx.toolError(
          'discussion_forbidden',
          'principal is not allowed to read this thread'
        );
      }
      rows = ctx.db
        .query(
          `SELECT message_id, thread_id, sender_principal, recipient_principal,
                  body, in_reply_to, created_at
             FROM discussions
            WHERE space_id = ?1 AND thread_id = ?2
              AND tombstoned_at IS NULL
              AND (?3 IS NULL OR created_at > ?3)
            ORDER BY created_at ASC
            LIMIT ?4`
        )
        .all(
          input.space_id,
          input.thread_id,
          input.since ?? null,
          limit
        ) as typeof rows;
    } else {
      rows = ctx.db
        .query(
          `SELECT d.message_id, d.thread_id, d.sender_principal, d.recipient_principal,
                  d.body, d.in_reply_to, d.created_at
             FROM discussions d
             LEFT JOIN discussion_threads dt
               ON dt.thread_id = d.thread_id AND dt.space_id = d.space_id
            WHERE d.space_id = ?1
              AND d.tombstoned_at IS NULL
              AND (?3 IS NULL OR d.created_at > ?3)
              AND (
                d.sender_principal = ?2
                OR (
                  COALESCE(dt.visibility_mode,
                    CASE WHEN d.recipient_principal IS NULL THEN 'broadcast' ELSE 'direct' END
                  ) = 'broadcast'
                )
                OR (
                  COALESCE(dt.visibility_mode,
                    CASE WHEN d.recipient_principal IS NULL THEN 'broadcast' ELSE 'direct' END
                  ) = 'direct'
                  AND EXISTS (
                    SELECT 1
                      FROM json_each(
                        COALESCE(
                          dt.participant_principals_json,
                          json_array(d.sender_principal, d.recipient_principal)
                        )
                      ) participants
                     WHERE participants.value = ?2
                  )
                )
              )
            ORDER BY d.created_at DESC
            LIMIT ?4`
        )
        .all(
          input.space_id,
          input.principal,
          input.since ?? null,
          limit
        ) as typeof rows;
    }
  } catch (err) {
    const e = err as { code?: string; message?: string };
    if (e?.message?.includes('no such table: discussions')) {
      rows = [];
    } else {
      throw err;
    }
  }

  return { ok: true, data: { messages: rows } };
}
