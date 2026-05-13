import {
  classifyTeamemChannelRoute,
  createClaudeChannelNotification,
  isUrgentTeamemChannelEvent,
  isNoiseTeamemChannelEvent,
  type ClaudeChannelNotification,
  type TeamemChannelEvent
} from './payload.js';

export type ChannelEmitDecisionOptions = {
  myPrincipal: string;
  allowedSenders?: ReadonlySet<string>;
};

function discussionRecipient(
  ev: TeamemChannelEvent
): string | null | undefined {
  if (ev.event_type !== 'discussion_posted') return undefined;
  const raw = ev.payload?.recipient_principal;
  if (raw === null) return null;
  if (typeof raw === 'string') return raw;
  return undefined;
}

function permissionRequestRecipient(
  ev: TeamemChannelEvent
): string | undefined {
  if (ev.event_type !== 'permission_requested') return undefined;
  const raw = ev.payload?.incumbent_principal;
  return typeof raw === 'string' ? raw : undefined;
}

function isDecisionBroadcast(ev: TeamemChannelEvent): boolean {
  return (
    ev.event_type === 'decision_published' ||
    ev.event_type === 'decision_amended' ||
    ev.event_type === 'decision_superseded'
  );
}

function gotchaRecipients(ev: TeamemChannelEvent): string[] {
  if (ev.event_type !== 'finding_shared' || ev.payload?.kind !== 'gotcha') {
    return [];
  }
  const raw = ev.payload.recipient_principals;
  return Array.isArray(raw)
    ? raw.filter(
        (recipient): recipient is string => typeof recipient === 'string'
      )
    : [];
}

export function shouldEmitTeamemChannelEvent(
  ev: TeamemChannelEvent,
  opts: ChannelEmitDecisionOptions
): boolean {
  if (opts.myPrincipal && ev.principal === opts.myPrincipal) return false;
  if (opts.allowedSenders && !opts.allowedSenders.has(ev.principal)) {
    return false;
  }
  if (isNoiseTeamemChannelEvent(ev)) return false;
  if (classifyTeamemChannelRoute(ev) !== 'peer') return false;
  if (ev.event_type === 'discussion_posted') {
    const recipient = discussionRecipient(ev);
    return recipient === null || recipient === opts.myPrincipal;
  }
  if (isDecisionBroadcast(ev)) return true;
  if (ev.event_type === 'finding_shared' && ev.payload?.kind === 'gotcha') {
    const recipients = gotchaRecipients(ev);
    return recipients.length === 0 || recipients.includes(opts.myPrincipal);
  }
  if (isUrgentTeamemChannelEvent(ev)) {
    return permissionRequestRecipient(ev) === opts.myPrincipal;
  }
  return false;
}

export function createTeamemChannelNotifications(
  events: TeamemChannelEvent[],
  opts: ChannelEmitDecisionOptions
): ClaudeChannelNotification[] {
  return events
    .filter((ev) => shouldEmitTeamemChannelEvent(ev, opts))
    .map((ev) => createClaudeChannelNotification(ev));
}
