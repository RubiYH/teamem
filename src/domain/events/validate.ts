import { EventValidationError, type ValidationIssue } from './errors.js';
import { validateRoutingMetadata } from './routing.js';
import { EVENT_TYPES, type TeamemEvent } from './types.js';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateEvent(
  input: unknown,
  options: { requireRoutingMetadata?: boolean } = {}
): TeamemEvent {
  const issues: ValidationIssue[] = [];

  if (!isObject(input)) {
    throw new EventValidationError([
      {
        path: '$',
        code: 'invalid_type',
        message: 'Expected object event payload'
      }
    ]);
  }

  const requiredStringFields = [
    'schema_version',
    'event_id',
    'idempotency_key',
    'space_id',
    'timestamp',
    'principal',
    'actor',
    'delegation',
    'event_type'
  ] as const;

  for (const field of requiredStringFields) {
    const value = input[field];
    if (value === undefined) {
      issues.push({
        path: `$.${field}`,
        code: 'missing',
        message: `${field} is required`
      });
      continue;
    }
    if (typeof value !== 'string') {
      issues.push({
        path: `$.${field}`,
        code: 'invalid_type',
        message: `${field} must be a string`
      });
    }
  }

  if (input.schema_version !== '1.0') {
    issues.push({
      path: '$.schema_version',
      code: 'invalid_value',
      message: 'schema_version must be 1.0'
    });
  }

  if (
    typeof input.event_type === 'string' &&
    !EVENT_TYPES.includes(input.event_type as never)
  ) {
    issues.push({
      path: '$.event_type',
      code: 'invalid_value',
      message: `Unsupported event_type: ${String(input.event_type)}`
    });
  }

  if (!isObject(input.scope)) {
    issues.push({
      path: '$.scope',
      code: 'missing',
      message: 'scope object is required'
    });
  }

  if (!isObject(input.payload)) {
    issues.push({
      path: '$.payload',
      code: 'missing',
      message: 'payload object is required'
    });
  }

  issues.push(
    ...validateRoutingMetadata(input, {
      requireExplicit: options.requireRoutingMetadata === true
    })
  );

  // Codex F25 — dispute payload tightening. Both the `dispute_opened`
  // event AND any `discussion_posted` event with `payload.dispute_move`
  // set MUST carry server-authoritative `opened_by` and
  // `target_principal` so the auto-negotiator can derive its `side`
  // without a re-query (see ADR-0002, F22 fix in slice #24). Pre-#25
  // the validator only required `payload` to be an object — fixtures
  // missing these fields silently passed validation, hiding the
  // production payload-contract drift that F22 caught.
  if (isObject(input.payload)) {
    const isDecisionLifecycleEvent =
      input.event_type === 'decision_published' ||
      input.event_type === 'decision_amended' ||
      input.event_type === 'decision_superseded' ||
      input.event_type === 'decision_recorded';
    if (isDecisionLifecycleEvent) {
      for (const field of ['decision_id', 'title'] as const) {
        const v = input.payload[field];
        if (v === undefined) {
          issues.push({
            path: `$.payload.${field}`,
            code: 'missing',
            message: `${field} is required for decision lifecycle events`
          });
        } else if (typeof v !== 'string' || v.length === 0) {
          issues.push({
            path: `$.payload.${field}`,
            code: 'invalid_type',
            message: `${field} must be a non-empty string`
          });
        }
      }
    }

    if (input.event_type === 'sprint_created') {
      for (const field of [
        'sprint_id',
        'slug',
        'display_name',
        'goal'
      ] as const) {
        const v = input.payload[field];
        if (v === undefined) {
          issues.push({
            path: `$.payload.${field}`,
            code: 'missing',
            message: `${field} is required for sprint_created events`
          });
        } else if (typeof v !== 'string' || v.length === 0) {
          issues.push({
            path: `$.payload.${field}`,
            code: 'invalid_type',
            message: `${field} must be a non-empty string`
          });
        }
      }
    }

    if (
      input.event_type === 'sprint_joined' ||
      input.event_type === 'sprint_left' ||
      input.event_type === 'sprint_archived' ||
      input.event_type === 'sprint_reopened'
    ) {
      for (const field of ['sprint_id', 'slug'] as const) {
        const v = input.payload[field];
        if (v === undefined) {
          issues.push({
            path: `$.payload.${field}`,
            code: 'missing',
            message: `${field} is required for ${String(input.event_type)} events`
          });
        } else if (typeof v !== 'string' || v.length === 0) {
          issues.push({
            path: `$.payload.${field}`,
            code: 'invalid_type',
            message: `${field} must be a non-empty string`
          });
        }
      }
    }

    const isDisputeOpened = input.event_type === 'dispute_opened';
    const isDisputeMove =
      input.event_type === 'discussion_posted' &&
      input.payload.dispute_move !== undefined &&
      input.payload.dispute_move !== null;

    if (isDisputeOpened || isDisputeMove) {
      for (const field of ['opened_by', 'target_principal'] as const) {
        const v = input.payload[field];
        if (v === undefined) {
          issues.push({
            path: `$.payload.${field}`,
            code: 'missing',
            message: `${field} is required for dispute events`
          });
        } else if (typeof v !== 'string' || v.length === 0) {
          issues.push({
            path: `$.payload.${field}`,
            code: 'invalid_type',
            message: `${field} must be a non-empty string`
          });
        }
      }
    }
  }

  if (input.confidence !== undefined) {
    if (
      typeof input.confidence !== 'number' ||
      input.confidence < 0 ||
      input.confidence > 1
    ) {
      issues.push({
        path: '$.confidence',
        code: 'invalid_value',
        message: 'confidence must be a number between 0 and 1'
      });
    }
  }

  if (issues.length > 0) {
    throw new EventValidationError(issues);
  }

  return input as TeamemEvent;
}
