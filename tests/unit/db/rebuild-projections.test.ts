import { describe, expect, it } from 'bun:test';
import type { TeamemEvent } from '../../../src/domain/events/types.js';
import { createSqliteClient } from '../../../src/infra/db/sqlite-client.js';
import { SqliteEventStore } from '../../../src/infra/db/sqlite-event-store.js';
import { applyProjectionUpdate } from '../../../src/infra/projections/apply-event.js';
import { rebuildProjections } from '../../../src/infra/projections/rebuild.js';
import { runAllMigrations } from '../../helpers/migrations.js';

function event(overrides: Partial<TeamemEvent>): TeamemEvent {
  return {
    schema_version: '1.0',
    event_id: 'evt-default',
    idempotency_key: 'idem-default',
    space_id: 'teamem-poc',
    timestamp: '2026-04-30T00:00:00.000Z',
    principal: 'alice',
    actor: 'codex/session-1',
    delegation: 'alice->codex',
    event_type: 'task_started',
    scope: { paths: ['src/index.ts'] },
    payload: {},
    ...overrides
  };
}

describe('rebuildProjections', () => {
  it('rebuilds claims projection from event log', () => {
    const db = createSqliteClient(':memory:');
    runAllMigrations(db);
    const store = new SqliteEventStore(db);

    const claim = event({
      event_id: 'evt-1',
      idempotency_key: 'idem-1',
      event_type: 'scope_claimed',
      payload: { claim_id: 'claim-1', intent: 'edit' }
    });
    const release = event({
      event_id: 'evt-2',
      idempotency_key: 'idem-2',
      timestamp: '2026-04-30T00:01:00.000Z',
      event_type: 'scope_released',
      payload: { claim_id: 'claim-1' }
    });

    store.append(claim);
    store.append(release);
    applyProjectionUpdate(db, claim);
    applyProjectionUpdate(db, release);

    db.prepare('DELETE FROM claims WHERE space_id = ?1').run('teamem-poc');

    const result = rebuildProjections(db, 'teamem-poc');
    expect(result.replayed).toBe(2);

    const row = db
      .query('SELECT status FROM claims WHERE claim_id = ?1')
      .get('claim-1') as { status: string } | undefined;
    expect(row?.status).toBe('released');
  });

  it('rebuilds persistent gotcha projection with nullable expires_at', () => {
    const db = createSqliteClient(':memory:');
    runAllMigrations(db);
    const store = new SqliteEventStore(db);

    const gotcha = event({
      event_id: 'evt-finding-1',
      idempotency_key: 'idem-finding-1',
      event_type: 'finding_shared',
      scope: { paths: ['src/server/tools/briefing.ts'] },
      payload: {
        finding_id: 'finding-1',
        kind: 'gotcha',
        lifecycle: 'persistent',
        status: 'active',
        version: 1,
        summary: 'Persistent gotcha',
        body: 'Do not treat null expires_at as expired.',
        paths: ['src/server/tools/briefing.ts'],
        tags: ['space-memory'],
        severity: 'warning',
        refs: { modules: ['server/tools'] },
        expires_at: null
      }
    });

    store.append(gotcha);
    applyProjectionUpdate(db, gotcha);

    db.prepare('DELETE FROM findings WHERE space_id = ?1').run('teamem-poc');

    const result = rebuildProjections(db, 'teamem-poc');
    expect(result.replayed).toBe(1);

    const row = db
      .query(
        `SELECT kind, lifecycle, status, version, expires_at
           FROM findings
          WHERE finding_id = ?1`
      )
      .get('finding-1') as
      | {
          kind: string;
          lifecycle: string;
          status: string;
          version: number;
          expires_at: string | null;
        }
      | undefined;
    expect(row?.kind).toBe('gotcha');
    expect(row?.lifecycle).toBe('persistent');
    expect(row?.status).toBe('active');
    expect(row?.version).toBe(1);
    expect(row?.expires_at).toBeNull();
  });

  it('rebuilds finding acknowledgements from acknowledgment_recorded events', () => {
    const db = createSqliteClient(':memory:');
    runAllMigrations(db);
    const store = new SqliteEventStore(db);

    const gotcha = event({
      event_id: 'evt-finding-ack-1',
      idempotency_key: 'idem-finding-ack-1',
      event_type: 'finding_shared',
      payload: {
        finding_id: 'finding-ack-1',
        kind: 'gotcha',
        lifecycle: 'persistent',
        status: 'active',
        version: 2,
        summary: 'Gotcha to acknowledge',
        recipient_principals: ['bob']
      }
    });
    const ack = event({
      event_id: 'evt-ack-1',
      idempotency_key: 'idem-ack-1',
      principal: 'bob',
      event_type: 'acknowledgment_recorded',
      payload: {
        finding_id: 'finding-ack-1',
        version: 2,
        acknowledged_by: 'bob',
        acknowledgment_kind: 'seen'
      }
    });

    for (const evt of [gotcha, ack]) {
      store.append(evt);
      applyProjectionUpdate(db, evt);
    }

    db.prepare('DELETE FROM finding_acknowledgements WHERE space_id = ?1').run(
      'teamem-poc'
    );

    const result = rebuildProjections(db, 'teamem-poc');
    expect(result.replayed).toBe(2);

    const row = db
      .query(
        `SELECT version, principal
           FROM finding_acknowledgements
          WHERE space_id = ?1
            AND finding_id = ?2`
      )
      .get('teamem-poc', 'finding-ack-1') as
      | { version: number; principal: string }
      | undefined;
    expect(row?.version).toBe(2);
    expect(row?.principal).toBe('bob');
  });

  it('rebuilds decision current state and history from lifecycle events', () => {
    const db = createSqliteClient(':memory:');
    runAllMigrations(db);
    const store = new SqliteEventStore(db);

    const published = event({
      event_id: 'evt-decision-1',
      idempotency_key: 'idem-decision-1',
      event_type: 'decision_published',
      payload: {
        decision_id: 'dec-1',
        title: 'Initial plan',
        summary: 'Start with the bridge.',
        body: 'Initial body',
        kind: 'plan',
        version: 1
      }
    });
    const amended = event({
      event_id: 'evt-decision-2',
      idempotency_key: 'idem-decision-2',
      timestamp: '2026-04-30T00:01:00.000Z',
      principal: 'bob',
      event_type: 'decision_amended',
      payload: {
        decision_id: 'dec-1',
        title: 'Initial plan',
        summary: 'Start with the bridge and persist lifecycle history.',
        body: 'Amended body',
        kind: 'plan',
        version: 2
      }
    });
    const superseded = event({
      event_id: 'evt-decision-3',
      idempotency_key: 'idem-decision-3',
      timestamp: '2026-04-30T00:02:00.000Z',
      principal: 'carol',
      event_type: 'decision_superseded',
      payload: {
        decision_id: 'dec-1',
        title: 'Initial plan',
        summary: 'Start with the bridge and persist lifecycle history.',
        body: 'Amended body',
        kind: 'plan',
        version: 3,
        superseded_by_decision_id: 'dec-2'
      }
    });

    for (const evt of [published, amended, superseded]) {
      store.append(evt);
      applyProjectionUpdate(db, evt);
    }

    db.prepare('DELETE FROM decisions WHERE space_id = ?1').run('teamem-poc');
    db.prepare('DELETE FROM decision_history WHERE space_id = ?1').run(
      'teamem-poc'
    );

    const result = rebuildProjections(db, 'teamem-poc');
    expect(result.replayed).toBe(3);

    const current = db
      .query(
        `SELECT status, version, latest_event_type, superseded_by_decision_id
           FROM decisions
          WHERE decision_id = ?1`
      )
      .get('dec-1') as
      | {
          status: string;
          version: number;
          latest_event_type: string;
          superseded_by_decision_id: string | null;
        }
      | undefined;
    expect(current?.status).toBe('superseded');
    expect(current?.version).toBe(3);
    expect(current?.latest_event_type).toBe('decision_superseded');
    expect(current?.superseded_by_decision_id).toBe('dec-2');

    const history = db
      .query(
        `SELECT lifecycle_event, version
           FROM decision_history
          WHERE decision_id = ?1
          ORDER BY version ASC`
      )
      .all('dec-1') as Array<{ lifecycle_event: string; version: number }>;
    expect(history).toEqual([
      { lifecycle_event: 'decision_published', version: 1 },
      { lifecycle_event: 'decision_amended', version: 2 },
      { lifecycle_event: 'decision_superseded', version: 3 }
    ]);
  });
});
