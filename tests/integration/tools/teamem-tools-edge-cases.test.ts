import { runAllMigrations } from '../../helpers/migrations.js';
import { describe, expect, it } from 'bun:test';
import { createSqliteClient } from '../../../src/infra/db/sqlite-client.js';
import { SqliteEventStore } from '../../../src/infra/db/sqlite-event-store.js';
import { createTeamemTools } from '../../../src/server/tools/index.js';

function setup() {
  const db = createSqliteClient(':memory:');
  runAllMigrations(db);
  const store = new SqliteEventStore(db);
  return createTeamemTools({ db, store });
}

describe('teamem tools edge cases', () => {
  it('returns structured error for invalid publish payload', () => {
    const tools = setup();
    const result = tools.publishEvent({ not: 'an event' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_EVENT');
    }
  });

  it('treats duplicate idempotency event as no-op success', () => {
    const tools = setup();
    const payload = {
      schema_version: '1.0',
      event_id: 'evt-dupe-1',
      idempotency_key: 'idem-dupe-1',
      space_id: 'teamem-poc',
      timestamp: '2026-04-30T02:00:00.000Z',
      principal: 'alice',
      actor: 'codex/session-1',
      delegation: 'alice->codex',
      event_type: 'task_started',
      sprint_id: null,
      delivery_scope: 'space',
      scope: { paths: ['src/index.ts'] },
      payload: { task_id: 'TASK-1' }
    } as const;

    const first = tools.publishEvent(payload);
    const second = tools.publishEvent(payload);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);

    const updates = tools.getUpdates({ space_id: 'teamem-poc' });
    expect(updates.ok).toBe(true);
    if (updates.ok) {
      expect(updates.data.events).toHaveLength(1);
    }
  });

  it('returns advisory with no data when querying empty contract state', () => {
    const tools = setup();
    const state = tools.getContractState({ space_id: 'teamem-poc' });

    expect(state.ok).toBe(true);
    if (state.ok) {
      expect(state.data.contracts).toHaveLength(0);
    }
  });
});
