import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';
import {
  createSqliteClient,
  runMigration
} from '../../src/infra/db/sqlite-client.js';
import { SqliteEventStore } from '../../src/infra/db/sqlite-event-store.js';
import { createTeamemTools } from '../../src/server/tools/index.js';

function setup() {
  const db = createSqliteClient(':memory:');
  runMigration(db, join(process.cwd(), 'src/infra/db/migrations/001_init.sql'));
  runMigration(
    db,
    join(
      process.cwd(),
      'src/infra/db/migrations/002_decisions_kind_and_indexes.sql'
    )
  );
  runMigration(
    db,
    join(
      process.cwd(),
      'src/infra/db/migrations/003_room_codes_and_members.sql'
    )
  );
  const store = new SqliteEventStore(db);
  const tools = createTeamemTools({ db, store });
  return { db, store, tools };
}

describe('perf: getUpdates — 10k events, p50 < 120ms', () => {
  it('getUpdates p50 < 120ms over 10k events', () => {
    const { store, tools } = setup();

    for (let i = 0; i < 10000; i++) {
      store.append({
        schema_version: '1.0',
        event_id: `gu-perf-${String(i).padStart(6, '0')}`,
        idempotency_key: `gu-idem-${String(i).padStart(6, '0')}`,
        space_id: 'perf-repo',
        timestamp: new Date(
          Date.UTC(2026, 4, 1, 0, Math.floor(i / 60), i % 60)
        ).toISOString(),
        principal: i % 3 === 0 ? 'alice' : i % 3 === 1 ? 'bob' : 'carol',
        actor: 'agent',
        delegation: 'principal->agent',
        event_type: 'task_started' as const,
        scope: { paths: [`src/module-${i % 100}.ts`] },
        payload: { task_id: `TASK-${i}` }
      });
    }

    const times: number[] = [];
    for (let run = 0; run < 11; run++) {
      const t = performance.now();
      tools.getUpdates({ space_id: 'perf-repo', limit: 100 });
      times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    const p50 = times[Math.floor(times.length / 2)]!;
    expect(p50).toBeLessThan(120);
  });

  it('getUpdates with cursor p50 < 120ms over 10k events', () => {
    const { store, tools } = setup();

    for (let i = 0; i < 10000; i++) {
      store.append({
        schema_version: '1.0',
        event_id: `gu-cur-${String(i).padStart(6, '0')}`,
        idempotency_key: `gu-cur-idem-${String(i).padStart(6, '0')}`,
        space_id: 'cursor-repo',
        timestamp: new Date(
          Date.UTC(2026, 4, 1, 0, Math.floor(i / 60), i % 60)
        ).toISOString(),
        principal: 'alice',
        actor: 'agent',
        delegation: 'alice->agent',
        event_type: 'task_started' as const,
        scope: {},
        payload: { task_id: `T-${i}` }
      });
    }

    // Cursor pointing at the midpoint event
    const midCursor = `gu-cur-${String(5000).padStart(6, '0')}`;

    const times: number[] = [];
    for (let run = 0; run < 11; run++) {
      const t = performance.now();
      tools.getUpdates({
        space_id: 'cursor-repo',
        since: midCursor,
        limit: 100
      });
      times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    const p50 = times[Math.floor(times.length / 2)]!;
    expect(p50).toBeLessThan(120);
  });
});
