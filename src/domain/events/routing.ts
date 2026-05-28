import type { DeliveryScope, TeamemEvent } from './types.js';
import type { ValidationIssue } from './errors.js';

export function topLevelRecipients(event: TeamemEvent): string[] {
  return Array.isArray(event.recipient_principals)
    ? event.recipient_principals.filter(
        (recipient): recipient is string =>
          typeof recipient === 'string' && recipient.length > 0
      )
    : [];
}

export function directRecipientsForRead(event: TeamemEvent): string[] {
  const direct = topLevelRecipients(event);
  if (direct.length > 0) return direct;

  const payloadRecipient = event.payload.recipient_principal;
  if (typeof payloadRecipient === 'string' && payloadRecipient.length > 0) {
    return [payloadRecipient];
  }

  const payloadRecipients = event.payload.recipient_principals;
  if (Array.isArray(payloadRecipients)) {
    return payloadRecipients.filter(
      (recipient): recipient is string =>
        typeof recipient === 'string' && recipient.length > 0
    );
  }

  return [];
}

export function inferDeliveryScopeForRead(event: TeamemEvent): DeliveryScope {
  if (event.delivery_scope) return event.delivery_scope;
  if (directRecipientsForRead(event).length > 0) return 'direct';
  if (event.sprint_id !== undefined && event.sprint_id !== null) {
    return 'sprint';
  }
  return 'space';
}

export function normalizeEventRoutingForRead(event: TeamemEvent): TeamemEvent {
  return {
    ...event,
    sprint_id: event.sprint_id ?? null,
    delivery_scope: inferDeliveryScopeForRead(event)
  };
}

export function validateRoutingMetadata(
  input: Record<string, unknown>,
  options: { requireExplicit: boolean }
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const sprintId = input.sprint_id;
  const deliveryScope = input.delivery_scope;
  const recipients = input.recipient_principals;

  if (sprintId === undefined) {
    if (options.requireExplicit) {
      issues.push({
        path: '$.sprint_id',
        code: 'missing',
        message: 'sprint_id is required for new events'
      });
    }
  } else if (
    sprintId !== null &&
    (typeof sprintId !== 'string' || sprintId.length === 0)
  ) {
    issues.push({
      path: '$.sprint_id',
      code: 'invalid_type',
      message: 'sprint_id must be a non-empty string or null'
    });
  }

  if (deliveryScope === undefined) {
    if (options.requireExplicit) {
      issues.push({
        path: '$.delivery_scope',
        code: 'missing',
        message: 'delivery_scope is required for new events'
      });
    }
    return issues;
  }

  if (
    deliveryScope !== 'direct' &&
    deliveryScope !== 'sprint' &&
    deliveryScope !== 'space'
  ) {
    issues.push({
      path: '$.delivery_scope',
      code: 'invalid_value',
      message: 'delivery_scope must be direct, sprint, or space'
    });
    return issues;
  }

  const hasRecipientArray = recipients !== undefined;
  const validRecipients =
    Array.isArray(recipients) &&
    recipients.every(
      (recipient) => typeof recipient === 'string' && recipient.length > 0
    );

  if (hasRecipientArray && !validRecipients) {
    issues.push({
      path: '$.recipient_principals',
      code: 'invalid_type',
      message: 'recipient_principals must be non-empty strings'
    });
  }

  if (deliveryScope === 'direct') {
    if (!Array.isArray(recipients) || recipients.length === 0) {
      issues.push({
        path: '$.recipient_principals',
        code: 'missing',
        message: 'direct delivery requires recipient_principals'
      });
    }
    return issues;
  }

  if (hasRecipientArray) {
    issues.push({
      path: '$.recipient_principals',
      code: 'invalid_value',
      message: 'sprint and space delivery must not include recipients'
    });
  }

  if (deliveryScope === 'sprint' && sprintId === null) {
    issues.push({
      path: '$.sprint_id',
      code: 'invalid_value',
      message: 'sprint delivery requires a sprint_id'
    });
  }

  if (deliveryScope === 'space' && sprintId !== null) {
    issues.push({
      path: '$.sprint_id',
      code: 'invalid_value',
      message: 'space delivery requires sprint_id null'
    });
  }

  return issues;
}
