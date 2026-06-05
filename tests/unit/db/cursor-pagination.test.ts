import { describe, expect, it } from 'bun:test';
import { runAllMigrations } from '../../helpers/migrations.js';
import { createSqliteClient } from '../../../src/infra/db/sqlite-client.js';
import { SqliteEventStore } from '../../../src/infra/db/sqlite-event-store.js';
import { createTeamemTools } from '../../../src/server/tools/index.js';

function setup() {
  const db = createSqliteClient(':memory:');
  runAllMigrations(db);
  const store = new SqliteEventStore(db);
  const tools = createTeamemTools({ db, store });
  return { db, tools, store };
}

function publishEvent(
  tools: ReturnType<typeof createTeamemTools>,
  id: string,
  timestamp: string
) {
  return tools.publishEvent({
    schema_version: '1.0',
    event_id: id,
    idempotency_key: `idem-${id}`,
    space_id: 'teamem-poc',
    timestamp,
    principal: 'alice',
    actor: 'alice/agent',
    delegation: 'alice->agent',
    event_type: 'task_started',
    sprint_id: null,
    delivery_scope: 'space',
    scope: { paths: ['src/index.ts'] },
    payload: { task_id: id }
  });
}

describe('cursor-based pagination (AC9)', () => {
  it('next_cursor is the event_id of the last event (ULID)', () => {
    const { tools } = setup();

    publishEvent(
      tools,
      '01HZ000000000000000000001',
      '2026-05-01T00:00:00.000Z'
    );
    publishEvent(
      tools,
      '01HZ000000000000000000002',
      '2026-05-01T00:00:01.000Z'
    );

    const result = tools.getUpdates({ space_id: 'teamem-poc' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.next_cursor).toBe('01HZ000000000000000000002');
    }
  });

  it('events with same timestamp are not duplicated across paginated calls', () => {
    const { tools } = setup();

    // Same timestamp — ULID ordering ensures deterministic, non-duplicate pagination
    publishEvent(
      tools,
      '01HZ000000000000000000010',
      '2026-05-01T00:01:00.000Z'
    );
    publishEvent(
      tools,
      '01HZ000000000000000000011',
      '2026-05-01T00:01:00.000Z'
    );
    publishEvent(
      tools,
      '01HZ000000000000000000012',
      '2026-05-01T00:01:00.000Z'
    );

    // First page: limit 2
    const page1 = tools.getUpdates({ space_id: 'teamem-poc', limit: 2 });
    expect(page1.ok).toBe(true);
    if (!page1.ok) return;

    expect(page1.data.events).toHaveLength(2);
    const cursor = page1.data.next_cursor;
    expect(cursor).toBeTruthy();

    // Second page: using cursor from first page
    const page2 = tools.getUpdates({
      space_id: 'teamem-poc',
      since: cursor!,
      limit: 2
    });
    expect(page2.ok).toBe(true);
    if (!page2.ok) return;

    expect(page2.data.events).toHaveLength(1);

    // Verify no overlap between pages
    const ids1 = new Set(page1.data.events.map((e) => e.event_id));
    const ids2 = new Set(page2.data.events.map((e) => e.event_id));
    const overlap = [...ids1].filter((id) => ids2.has(id));
    expect(overlap).toHaveLength(0);
  });

  it('cursor is persisted to cursors table when actor is provided', () => {
    const { db, tools } = setup();

    publishEvent(
      tools,
      '01HZ000000000000000000020',
      '2026-05-01T00:02:00.000Z'
    );

    tools.getUpdates({ space_id: 'teamem-poc', actor: 'alice/agent' });

    const row = db
      .query(
        'SELECT cursor_value FROM cursors WHERE actor = ?1 AND space_id = ?2'
      )
      .get('alice/agent', 'teamem-poc') as { cursor_value: string } | undefined;

    expect(row).toBeDefined();
    expect(row?.cursor_value).toBe('01HZ000000000000000000020');
  });

  it('no cursor row written when result is empty', () => {
    const { db, tools } = setup();

    tools.getUpdates({ space_id: 'teamem-poc', actor: 'alice/agent' });

    const row = db
      .query(
        'SELECT cursor_value FROM cursors WHERE actor = ?1 AND space_id = ?2'
      )
      .get('alice/agent', 'teamem-poc') as { cursor_value: string } | null;

    // bun:sqlite returns null (not undefined) when .get() finds no row
    expect(row).toBeNull();
  });

  it('claim_scope persists real expires_at ISO timestamp', () => {
    const { db, tools } = setup();

    const before = Date.now();
    const result = tools.claimScope({
      space_id: 'teamem-poc',
      principal: 'alice',
      actor: 'alice/agent',
      delegation: 'alice->agent',
      scope: { paths: ['src/api/user.ts'] },
      // PRD §150: only ttl mode produces a non-null expires_at.
      auto_release_mode: 'ttl',
      lease_seconds: 7200
    });
    const after = Date.now();

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { claim_id, expires_at } = result.data;
    const expiresMs = new Date(expires_at!).getTime();

    // expires_at should be ~2h in the future
    expect(expiresMs).toBeGreaterThan(before + 7200 * 1000 - 1000);
    expect(expiresMs).toBeLessThan(after + 7200 * 1000 + 1000);

    // Verify it's persisted in the claims table
    const row = db
      .query('SELECT expires_at FROM claims WHERE claim_id = ?1')
      .get(claim_id) as { expires_at: string } | undefined;

    expect(row).toBeDefined();
    expect(row?.expires_at).toBe(expires_at!);
  });
});
