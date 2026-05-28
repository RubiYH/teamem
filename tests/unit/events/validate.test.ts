import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';
import { EventValidationError } from '../../../src/domain/events/errors.js';
import { validateEvent } from '../../../src/domain/events/validate.js';
import { EVENT_TYPES } from '../../../src/domain/events/types.js';

function readFixture(kind: 'valid' | 'invalid', name: string): unknown {
  const p = join(
    process.cwd(),
    'tests',
    'fixtures',
    'events',
    kind,
    `${name}.json`
  );
  return JSON.parse(readFileSync(p, 'utf-8'));
}

function fixtureNames(kind: 'valid' | 'invalid'): string[] {
  const dir = join(process.cwd(), 'tests', 'fixtures', 'events', kind);
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''));
}

describe('validateEvent — valid fixtures (AC12)', () => {
  it('accepts valid task-started event', () => {
    const evt = readFixture('valid', 'task-started');
    const validated = validateEvent(evt);
    expect(validated.event_type).toBe('task_started');
  });

  it('accepts valid scope-claimed event', () => {
    const evt = readFixture('valid', 'scope-claimed');
    const validated = validateEvent(evt);
    expect(validated.event_type).toBe('scope_claimed');
  });

  it('accepts valid scope-released event', () => {
    const evt = readFixture('valid', 'scope-released');
    const validated = validateEvent(evt);
    expect(validated.event_type).toBe('scope_released');
  });

  it('accepts valid task-progressed event', () => {
    const evt = readFixture('valid', 'task-progressed');
    const validated = validateEvent(evt);
    expect(validated.event_type).toBe('task_progressed');
  });

  it('accepts valid task-completed event', () => {
    const evt = readFixture('valid', 'task-completed');
    const validated = validateEvent(evt);
    expect(validated.event_type).toBe('task_completed');
  });

  it('accepts valid decision-recorded event', () => {
    const evt = readFixture('valid', 'decision-recorded');
    const validated = validateEvent(evt);
    expect(validated.event_type).toBe('decision_recorded');
  });

  it('accepts valid decision-published event', () => {
    const evt = readFixture('valid', 'decision-published');
    const validated = validateEvent(evt);
    expect(validated.event_type).toBe('decision_published');
  });

  it('accepts valid contract-changed event', () => {
    const evt = readFixture('valid', 'contract-changed');
    const validated = validateEvent(evt);
    expect(validated.event_type).toBe('contract_changed');
  });

  it('accepts valid blocker-raised event', () => {
    const evt = readFixture('valid', 'blocker-raised');
    const validated = validateEvent(evt);
    expect(validated.event_type).toBe('blocker_raised');
  });

  it('accepts valid blocker-resolved event', () => {
    const evt = readFixture('valid', 'blocker-resolved');
    const validated = validateEvent(evt);
    expect(validated.event_type).toBe('blocker_resolved');
  });

  it('accepts valid conflict-detected event', () => {
    const evt = readFixture('valid', 'conflict-detected');
    const validated = validateEvent(evt);
    expect(validated.event_type).toBe('conflict_detected');
  });

  it('accepts valid conflict-resolved event', () => {
    const evt = readFixture('valid', 'conflict-resolved');
    const validated = validateEvent(evt);
    expect(validated.event_type).toBe('conflict_resolved');
  });

  it('accepts valid acknowledgment-recorded event', () => {
    const evt = readFixture('valid', 'acknowledgment-recorded');
    const validated = validateEvent(evt);
    expect(validated.event_type).toBe('acknowledgment_recorded');
  });

  it('every EVENT_TYPES entry has a valid fixture file', () => {
    const names = fixtureNames('valid');
    // Convert fixture filenames (kebab) to event_type (snake) for comparison
    const fixtureTypes = names.map((n) => n.replace(/-/g, '_'));
    for (const eventType of EVENT_TYPES) {
      expect(fixtureTypes).toContain(eventType);
    }
  });
});

describe('validateEvent — invalid fixtures (AC12)', () => {
  it('rejects missing-event-type with $.event_type missing issue', () => {
    const evt = readFixture('invalid', 'missing-event-type');
    expect(() => validateEvent(evt)).toThrowError(EventValidationError);
    try {
      validateEvent(evt);
    } catch (error) {
      const typed = error as EventValidationError;
      expect(typed.issues[0]?.path).toBe('$.event_type');
      expect(typed.issues[0]?.code).toBe('missing');
    }
  });

  it('rejects scope-claimed-missing-scope with $.scope missing issue', () => {
    const evt = readFixture('invalid', 'scope-claimed-missing-scope');
    expect(() => validateEvent(evt)).toThrowError(EventValidationError);
  });

  it('rejects scope-released-missing-payload with $.payload missing issue', () => {
    const evt = readFixture('invalid', 'scope-released-missing-payload');
    expect(() => validateEvent(evt)).toThrowError(EventValidationError);
  });

  it('rejects task-started-missing-principal with $.principal missing issue', () => {
    const evt = readFixture('invalid', 'task-started-missing-principal');
    expect(() => validateEvent(evt)).toThrowError(EventValidationError);
    try {
      validateEvent(evt);
    } catch (error) {
      const typed = error as EventValidationError;
      expect(typed.issues.some((i) => i.path === '$.principal')).toBe(true);
    }
  });

  it('rejects task-progressed-bad-confidence with $.confidence invalid_value issue', () => {
    const evt = readFixture('invalid', 'task-progressed-bad-confidence');
    expect(() => validateEvent(evt)).toThrowError(EventValidationError);
    try {
      validateEvent(evt);
    } catch (error) {
      const typed = error as EventValidationError;
      expect(typed.issues.some((i) => i.path === '$.confidence')).toBe(true);
    }
  });

  it('rejects task-completed-missing-event-id with $.event_id missing issue', () => {
    const evt = readFixture('invalid', 'task-completed-missing-event-id');
    expect(() => validateEvent(evt)).toThrowError(EventValidationError);
    try {
      validateEvent(evt);
    } catch (error) {
      const typed = error as EventValidationError;
      expect(typed.issues.some((i) => i.path === '$.event_id')).toBe(true);
    }
  });

  it('rejects decision-recorded-bad-schema-version with $.schema_version invalid_value issue', () => {
    const evt = readFixture('invalid', 'decision-recorded-bad-schema-version');
    expect(() => validateEvent(evt)).toThrowError(EventValidationError);
    try {
      validateEvent(evt);
    } catch (error) {
      const typed = error as EventValidationError;
      expect(typed.issues.some((i) => i.path === '$.schema_version')).toBe(
        true
      );
    }
  });

  it('rejects decision-published-missing-title with $.payload.title missing issue', () => {
    const evt = readFixture('invalid', 'decision-published-missing-title');
    expect(() => validateEvent(evt)).toThrowError(EventValidationError);
    try {
      validateEvent(evt);
    } catch (error) {
      const typed = error as EventValidationError;
      expect(typed.issues.some((i) => i.path === '$.payload.title')).toBe(true);
    }
  });

  it('rejects sprint-created-missing-slug with $.payload.slug missing issue', () => {
    const evt = readFixture('invalid', 'sprint-created-missing-slug');
    expect(() => validateEvent(evt)).toThrowError(EventValidationError);
    try {
      validateEvent(evt);
    } catch (error) {
      const typed = error as EventValidationError;
      expect(typed.issues.some((i) => i.path === '$.payload.slug')).toBe(true);
    }
  });

  it('rejects sprint-joined-missing-sprint-id with $.payload.sprint_id missing issue', () => {
    const evt = readFixture('invalid', 'sprint-joined-missing-sprint-id');
    expect(() => validateEvent(evt)).toThrowError(EventValidationError);
    try {
      validateEvent(evt);
    } catch (error) {
      const typed = error as EventValidationError;
      expect(typed.issues.some((i) => i.path === '$.payload.sprint_id')).toBe(
        true
      );
    }
  });

  it('rejects sprint-left-missing-slug with $.payload.slug missing issue', () => {
    const evt = readFixture('invalid', 'sprint-left-missing-slug');
    expect(() => validateEvent(evt)).toThrowError(EventValidationError);
    try {
      validateEvent(evt);
    } catch (error) {
      const typed = error as EventValidationError;
      expect(typed.issues.some((i) => i.path === '$.payload.slug')).toBe(true);
    }
  });

  it('rejects sprint-archived-missing-sprint-id with $.payload.sprint_id missing issue', () => {
    const evt = readFixture('invalid', 'sprint-archived-missing-sprint-id');
    expect(() => validateEvent(evt)).toThrowError(EventValidationError);
    try {
      validateEvent(evt);
    } catch (error) {
      const typed = error as EventValidationError;
      expect(typed.issues.some((i) => i.path === '$.payload.sprint_id')).toBe(
        true
      );
    }
  });

  it('rejects sprint-reopened-missing-slug with $.payload.slug missing issue', () => {
    const evt = readFixture('invalid', 'sprint-reopened-missing-slug');
    expect(() => validateEvent(evt)).toThrowError(EventValidationError);
    try {
      validateEvent(evt);
    } catch (error) {
      const typed = error as EventValidationError;
      expect(typed.issues.some((i) => i.path === '$.payload.slug')).toBe(true);
    }
  });

  it('rejects contract-changed-missing-repo-id with $.space_id missing issue', () => {
    const evt = readFixture('invalid', 'contract-changed-missing-repo-id');
    expect(() => validateEvent(evt)).toThrowError(EventValidationError);
  });

  it('rejects blocker-raised-missing-delegation with $.delegation missing issue', () => {
    const evt = readFixture('invalid', 'blocker-raised-missing-delegation');
    expect(() => validateEvent(evt)).toThrowError(EventValidationError);
    try {
      validateEvent(evt);
    } catch (error) {
      const typed = error as EventValidationError;
      expect(typed.issues.some((i) => i.path === '$.delegation')).toBe(true);
    }
  });

  it('rejects blocker-resolved-unknown-event-type with $.event_type invalid_value issue', () => {
    const evt = readFixture('invalid', 'blocker-resolved-unknown-event-type');
    expect(() => validateEvent(evt)).toThrowError(EventValidationError);
    try {
      validateEvent(evt);
    } catch (error) {
      const typed = error as EventValidationError;
      expect(typed.issues.some((i) => i.path === '$.event_type')).toBe(true);
    }
  });

  it('rejects conflict-detected-non-object-scope with $.scope missing issue', () => {
    const evt = readFixture('invalid', 'conflict-detected-non-object-scope');
    expect(() => validateEvent(evt)).toThrowError(EventValidationError);
  });

  it('rejects conflict-resolved-missing-actor with $.actor missing issue', () => {
    const evt = readFixture('invalid', 'conflict-resolved-missing-actor');
    expect(() => validateEvent(evt)).toThrowError(EventValidationError);
    try {
      validateEvent(evt);
    } catch (error) {
      const typed = error as EventValidationError;
      expect(typed.issues.some((i) => i.path === '$.actor')).toBe(true);
    }
  });

  it('rejects acknowledgment-recorded-missing-idempotency-key with $.idempotency_key missing issue', () => {
    const evt = readFixture(
      'invalid',
      'acknowledgment-recorded-missing-idempotency-key'
    );
    expect(() => validateEvent(evt)).toThrowError(EventValidationError);
    try {
      validateEvent(evt);
    } catch (error) {
      const typed = error as EventValidationError;
      expect(typed.issues.some((i) => i.path === '$.idempotency_key')).toBe(
        true
      );
    }
  });

  it('all invalid fixtures fail validation', () => {
    const names = fixtureNames('invalid');
    expect(names.length).toBeGreaterThanOrEqual(13);
    for (const name of names) {
      const evt = readFixture('invalid', name);
      expect(() => validateEvent(evt)).toThrowError(EventValidationError);
    }
  });

  // Codex F25 — dispute payload tightening. The validator now requires
  // `payload.opened_by` and `payload.target_principal` for both
  // `dispute_opened` events AND any `discussion_posted` event whose
  // `payload.dispute_move` is set. These tests pin the contract.
  it('accepts the F22-shaped dispute-opened fixture (with opened_by + target_principal)', () => {
    const evt = readFixture('valid', 'dispute-opened');
    const validated = validateEvent(evt);
    expect(validated.event_type).toBe('dispute_opened');
    expect((validated.payload as Record<string, unknown>).opened_by).toBe(
      'bob'
    );
    expect(
      (validated.payload as Record<string, unknown>).target_principal
    ).toBe('alice');
  });

  it('rejects dispute-opened-missing-opened-by with $.payload.opened_by missing issue', () => {
    const evt = readFixture('invalid', 'dispute-opened-missing-opened-by');
    expect(() => validateEvent(evt)).toThrowError(EventValidationError);
    try {
      validateEvent(evt);
    } catch (error) {
      const typed = error as EventValidationError;
      expect(typed.issues.some((i) => i.path === '$.payload.opened_by')).toBe(
        true
      );
    }
  });

  it('rejects discussion_posted move event missing target_principal in payload', () => {
    const evt = readFixture(
      'invalid',
      'discussion-posted-dispute-move-missing-target-principal'
    );
    expect(() => validateEvent(evt)).toThrowError(EventValidationError);
    try {
      validateEvent(evt);
    } catch (error) {
      const typed = error as EventValidationError;
      expect(
        typed.issues.some((i) => i.path === '$.payload.target_principal')
      ).toBe(true);
    }
  });

  it('still accepts plain discussion_posted (no dispute_move) without opened_by/target_principal', () => {
    // Regression guard for F25: only DISPUTE moves require the side
    // metadata. Plain discussion threads keep their original loose shape.
    const evt = {
      schema_version: '1.0' as const,
      event_id: 'evt-plain-disc-1',
      idempotency_key: 'idem-plain-disc-1',
      space_id: 'space-1',
      timestamp: '2026-05-04T00:00:00.000Z',
      principal: 'bob',
      actor: 'bob',
      delegation: 'bob->bob',
      event_type: 'discussion_posted',
      scope: {},
      payload: {
        message_id: 'msg-1',
        thread_id: 't-1',
        recipient_principal: 'alice',
        body: 'hello',
        in_reply_to: null
      }
    };
    const validated = validateEvent(evt);
    expect(validated.event_type).toBe('discussion_posted');
  });
});
