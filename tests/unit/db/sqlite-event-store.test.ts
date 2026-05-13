import { describe, expect, it } from 'bun:test';
import type { TeamemEvent } from '../../../src/domain/events/types.js';
import { createSqliteClient } from '../../../src/infra/db/sqlite-client.js';
import { SqliteEventStore } from '../../../src/infra/db/sqlite-event-store.js';
import { applyProjectionUpdate } from '../../../src/infra/projections/apply-event.js';
import { runAllMigrations } from '../../helpers/migrations.js';

function sampleEvent(overrides: Partial<TeamemEvent> = {}): TeamemEvent {
  return {
    schema_version: '1.0',
    event_id: 'evt-1',
    idempotency_key: 'idem-1',
    space_id: 'teamem-poc',
    timestamp: '2026-04-30T00:00:00.000Z',
    principal: 'alice',
    actor: 'codex/session-1',
    delegation: 'alice->codex',
    event_type: 'task_started',
    scope: { paths: ['src/index.ts'] },
    payload: { task_id: 'TASK-1' },
    ...overrides
  };
}

describe('SqliteEventStore', () => {
  it('appends and fetches events by id', () => {
    const db = createSqliteClient(':memory:');
    runAllMigrations(db);

    const store = new SqliteEventStore(db);
    const event = sampleEvent();
    store.append(event);

    const got = store.getById(event.event_id);
    expect(got?.event_id).toBe('evt-1');
  });

  it('enforces idempotency and returns updates', () => {
    const db = createSqliteClient(':memory:');
    runAllMigrations(db);

    const store = new SqliteEventStore(db);
    const event = sampleEvent();
    store.append(event);
    store.append(event);

    const updates = store.getUpdates('teamem-poc');
    expect(updates).toHaveLength(1);
  });

  it('applies claim projections for claim/release lifecycle', () => {
    const db = createSqliteClient(':memory:');
    runAllMigrations(db);

    const claim = sampleEvent({
      event_id: 'evt-claim',
      idempotency_key: 'idem-claim',
      event_type: 'scope_claimed',
      payload: { claim_id: 'claim-1', intent: 'edit api' }
    });

    const release = sampleEvent({
      event_id: 'evt-release',
      idempotency_key: 'idem-release',
      event_type: 'scope_released',
      payload: { claim_id: 'claim-1' }
    });

    applyProjectionUpdate(db, claim);
    applyProjectionUpdate(db, release);

    const row = db
      .query('SELECT status FROM claims WHERE claim_id = ?1')
      .get('claim-1') as { status: string } | undefined;

    expect(row?.status).toBe('released');
  });
});
