import { runAllMigrations } from '../helpers/migrations.js';
import { describe, expect, it } from 'bun:test';
import { createSqliteClient } from '../../src/infra/db/sqlite-client.js';
import { SqliteEventStore } from '../../src/infra/db/sqlite-event-store.js';
import { createTeamemTools } from '../../src/server/tools/index.js';

type FixtureContext = ReturnType<typeof setup>;

function setup() {
  const db = createSqliteClient(':memory:');
  runAllMigrations(db);

  const store = new SqliteEventStore(db);
  const tools = createTeamemTools({ db, store });
  return { db, store, tools };
}

function publishTaskStarted(
  ctx: FixtureContext,
  id: string,
  principal: string,
  path: string
) {
  return ctx.tools.publishEvent({
    schema_version: '1.0',
    event_id: `evt-${id}`,
    idempotency_key: `idem-${id}`,
    space_id: 'teamem-poc',
    timestamp: `2026-04-30T03:00:${id}.000Z`,
    principal,
    actor: `${principal}/agent`,
    delegation: `${principal}->agent`,
    event_type: 'task_started',
    sprint_id: null,
    delivery_scope: 'space',
    scope: { paths: [path] },
    payload: { task_id: id }
  });
}

describe('scenario: multi-agent coordination', () => {
  it('flags duplicate active scope claims via claim_scope conflict', () => {
    const ctx = setup();

    const claimA = ctx.tools.claimScope({
      space_id: 'teamem-poc',
      principal: 'alice',
      actor: 'alice/agent',
      delegation: 'alice->agent',
      scope: { paths: ['src/api/user.ts'] }
    });
    expect(claimA.ok).toBe(true);

    const claimB = ctx.tools.claimScope({
      space_id: 'teamem-poc',
      principal: 'bob',
      actor: 'bob/agent',
      delegation: 'bob->agent',
      scope: { paths: ['src/api/user.ts'] }
    });
    expect(claimB.ok).toBe(false);
    if (!claimB.ok) {
      expect(claimB.error.code).toBe('scope_conflict');
    }
  });

  it('supports degraded-mode retry simulation through duplicate publish replay', () => {
    const ctx = setup();

    const first = publishTaskStarted(ctx, '11', 'alice', 'src/index.ts');
    const replay = publishTaskStarted(ctx, '11', 'alice', 'src/index.ts');

    expect(first.ok).toBe(true);
    expect(replay.ok).toBe(true);

    const updates = ctx.tools.getUpdates({ space_id: 'teamem-poc' });
    expect(updates.ok).toBe(true);
    if (updates.ok) {
      expect(updates.data.events).toHaveLength(1);
    }
  });

  it('performance smoke: get_updates remains responsive', () => {
    const ctx = setup();

    for (let i = 0; i < 200; i += 1) {
      const result = publishTaskStarted(
        ctx,
        `${1000 + i}`,
        'alice',
        `src/module-${i}.ts`
      );
      expect(result.ok).toBe(true);
    }

    const t1 = performance.now();
    const updates = ctx.tools.getUpdates({
      space_id: 'teamem-poc',
      limit: 200
    });
    const updatesMs = performance.now() - t1;

    expect(updates.ok).toBe(true);
    expect(updatesMs).toBeLessThan(100);
  });
});
