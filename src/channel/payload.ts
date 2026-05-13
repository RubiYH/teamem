export type TeamemChannelEvent = {
  event_id: string;
  event_type: string;
  principal: string;
  space_id?: string;
  scope?: { paths?: string[] };
  payload?: Record<string, unknown>;
};

export type TeamemChannelRoute = 'peer' | 'dispute';

export type TeamemChannelEnvelope = {
  name: 'teamem.peer_event' | 'teamem.dispute_event';
  route: TeamemChannelRoute;
  principal: string;
  event_type: string;
  event_id: string;
  scope?: TeamemChannelEvent['scope'];
  payload?: TeamemChannelEvent['payload'];
  summary: string;
  instructions?: string;
};

export type ClaudeChannelNotification = {
  method: 'notifications/claude/channel';
  params: {
    content: string;
    meta: Record<string, string>;
  };
};

export function classifyTeamemChannelRoute(
  ev: TeamemChannelEvent
): TeamemChannelRoute {
  if (ev.event_type === 'dispute_opened') return 'dispute';
  if (
    ev.event_type === 'discussion_posted' &&
    ev.payload != null &&
    typeof ev.payload === 'object' &&
    ev.payload.dispute_move != null
  ) {
    return 'dispute';
  }
  return 'peer';
}

export function summarizeTeamemChannelEvent(ev: TeamemChannelEvent): string {
  const p = ev.principal;
  const t = ev.event_type;
  const paths = ev.scope?.paths;
  const pathSummary =
    paths && paths.length > 0 ? ` [${paths.slice(0, 3).join(', ')}]` : '';

  switch (t) {
    case 'scope_claimed':
      return `${p} claimed scope${pathSummary}`;
    case 'scope_released':
      return `${p} released a claim`;
    case 'decision_published':
      return `${p} published decision: ${String(ev.payload?.title ?? '')}`;
    case 'decision_amended':
      return `${p} amended decision: ${String(ev.payload?.title ?? '')}`;
    case 'decision_superseded':
      return `${p} superseded decision: ${String(ev.payload?.title ?? '')}`;
    case 'decision_recorded':
      return `${p} recorded decision: ${String(ev.payload?.title ?? '')}`;
    case 'finding_shared':
      if (ev.payload?.kind === 'gotcha') {
        return `${p} shared gotcha: ${String(ev.payload?.summary ?? '')}`;
      }
      return `${p} shared finding: ${String(ev.payload?.summary ?? '')}`;
    case 'discussion_posted': {
      const to = String(ev.payload?.recipient_principal ?? 'space');
      const body = String(ev.payload?.body ?? '')
        .replace(/\s+/g, ' ')
        .slice(0, 120);
      return `${p} -> ${to}: ${body}`;
    }
    case 'permission_requested': {
      const incumbent = String(ev.payload?.incumbent_principal ?? 'incumbent');
      const reqId = String(ev.payload?.req_id ?? ev.event_id);
      const pathText =
        paths && paths.length > 0 ? paths.join(', ') : 'the requested paths';
      return `${p} requests permission from ${incumbent} for ${pathText} (req ${reqId}). Urgent: /teamem-grant ${reqId} or /teamem-deny ${reqId}`;
    }
    case 'blocker_raised':
      return `${p} raised blocker: ${String(ev.payload?.summary ?? '')}`;
    case 'blocker_resolved':
      return `${p} resolved a blocker`;
    case 'task_started':
    case 'task_progressed':
    case 'task_completed':
      return `${p} ${t.replace('task_', '')} ${String(ev.payload?.task_id ?? '')}`;
    case 'conflict_detected':
      return `${p} detected a conflict`;
    case 'conflict_resolved':
      return `${p} resolved a conflict`;
    default:
      return `${p} ${t}`;
  }
}

function publicChannelPayload(
  ev: TeamemChannelEvent
): TeamemChannelEvent['payload'] {
  if (ev.event_type !== 'finding_shared' || ev.payload?.kind !== 'gotcha') {
    return ev.payload;
  }
  const payload = ev.payload;
  return {
    finding_id: payload.finding_id,
    kind: 'gotcha',
    version: payload.version,
    summary: payload.summary,
    severity: payload.severity,
    paths: payload.paths,
    tags: payload.tags,
    recipient_principals: payload.recipient_principals,
    action: 'fetch_detail_with_teamem.get_finding'
  };
}

export function createTeamemChannelEnvelope(
  ev: TeamemChannelEvent
): TeamemChannelEnvelope {
  const route = classifyTeamemChannelRoute(ev);
  const reqId =
    ev.event_type === 'permission_requested' &&
    typeof ev.payload?.req_id === 'string'
      ? ev.payload.req_id
      : null;
  return {
    name: route === 'dispute' ? 'teamem.dispute_event' : 'teamem.peer_event',
    route,
    principal: ev.principal,
    event_type: ev.event_type,
    event_id: ev.event_id,
    scope: ev.scope,
    payload: publicChannelPayload(ev),
    summary: summarizeTeamemChannelEvent(ev),
    ...(reqId
      ? {
          instructions: `Urgent: run /teamem-grant ${reqId} to allow the edit or /teamem-deny ${reqId} to reject it.`
        }
      : {})
  };
}

export function isNoiseTeamemChannelEvent(ev: TeamemChannelEvent): boolean {
  if (ev.event_type !== 'task_started') return false;
  return String(ev.payload?.task_id ?? '').startsWith('session-');
}

export function createClaudeChannelNotification(
  ev: TeamemChannelEvent
): ClaudeChannelNotification {
  const envelope = createTeamemChannelEnvelope(ev);
  const meta: Record<string, string> =
    ev.event_type === 'permission_requested'
      ? {
          req_id: String(ev.payload?.req_id ?? ''),
          blocking_claim_id: String(ev.payload?.blocking_claim_id ?? ''),
          incumbent_principal: String(ev.payload?.incumbent_principal ?? ''),
          event_id: envelope.event_id,
          event_type: envelope.event_type,
          principal: envelope.principal
        }
      : {
          route: envelope.route,
          event_type: envelope.event_type,
          event_id: envelope.event_id,
          principal: envelope.principal,
          notification_name: envelope.name
        };
  const messageId = ev.payload?.message_id;
  if (ev.event_type !== 'permission_requested' && typeof messageId === 'string')
    meta.message_id = messageId;
  const threadId = ev.payload?.thread_id;
  if (ev.event_type !== 'permission_requested' && typeof threadId === 'string')
    meta.thread_id = threadId;
  const recipient = ev.payload?.recipient_principal;
  if (ev.event_type !== 'permission_requested') {
    if (typeof recipient === 'string') meta.recipient_principal = recipient;
    if (recipient === null) meta.recipient_principal = 'space';
  }

  return {
    method: 'notifications/claude/channel',
    params: {
      content: JSON.stringify(envelope),
      meta
    }
  };
}

export function isUrgentTeamemChannelEvent(ev: TeamemChannelEvent): boolean {
  return ev.event_type === 'permission_requested';
}
