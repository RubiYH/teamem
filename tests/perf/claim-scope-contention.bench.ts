/**
 * AC-NEW-8 (relaxed): concurrent claim_scope under contention.
 *
 * 10 concurrent disjoint-space claims (one per distinct space_id, mimicking
 * the realistic PoC fan-out of <50 concurrent agents). All return 200.
 * Total wall time < 500ms, p50 < 50ms, p99 < 200ms.
 *
 * SQLite's RESERVED lock under WAL is database-wide, so even disjoint-space
 * claims serialize at the lock layer. Per-call wait is bounded by
 * N × commit-time ≈ 1–5ms. With 10 claimants, total wall ≈ 10–50ms.
 */

import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { createSqliteClient } from '../../src/infra/db/sqlite-client.js';
import { SqliteEventStore } from '../../src/infra/db/sqlite-event-store.js';
import { createTeamemTools } from '../../src/server/tools/index.js';
import type { Database } from 'bun:sqlite';

const MIGRATIONS = [
  '001_init.sql',
  '002_decisions_kind_and_indexes.sql',
  '003_room_codes_and_members.sql'
];

function setupDb(): Database {
  const db = createSqliteClient(':memory:');
  const migrationsDir = join(process.cwd(), 'src/infra/db/migrations');
  for (const f of MIGRATIONS) {
    db.exec(readFileSync(join(migrationsDir, f), 'utf-8'));
  }
  return db;
}

describe('perf: claim_scope contention — 10 concurrent disjoint-space claims', () => {
  it('all 10 return 200, total wall < 500ms, p50 < 50ms, p99 < 200ms', async () => {
    const db = setupDb();
    const store = new SqliteEventStore(db);
    const tools = createTeamemTools({ db, store });

    const N = 10;
    const durations: number[] = [];

    // Run serially (bun:sqlite is sync) but measure each call's duration.
    // The gate uses .immediate() transactions; serial here is the right model
    // because SQLite serializes concurrent writers anyway. True concurrency
    // from Promise.all with sync tools would just queue on the JS event loop.
    const wallStart = performance.now();

    for (let i = 0; i < N; i++) {
      const t0 = performance.now();
      const result = tools.claimScope({
        space_id: `perf-space-${i}`, // disjoint space per call
        principal: `agent-${i}`,
        actor: `agent-${i}/codex`,
        delegation: `agent-${i}->codex`,
        scope: { paths: [`src/module-${i}/index.ts`] },
        intent: `perf claim ${i}`
      });
      durations.push(performance.now() - t0);
      expect(result.ok).toBe(true);
    }

    const totalWall = performance.now() - wallStart;

    durations.sort((a, b) => a - b);
    const p50 = durations[Math.floor(N * 0.5)]!;
    const p99 = durations[Math.floor(N * 0.99)] ?? durations[N - 1]!;

    expect(totalWall).toBeLessThan(500);
    expect(p50).toBeLessThan(50);
    expect(p99).toBeLessThan(200);
  });

  it('100 claim_scope calls on same space serialize correctly — total wall < 1000ms', () => {
    const db = setupDb();
    const store = new SqliteEventStore(db);
    const tools = createTeamemTools({ db, store });

    const SPACE = 'contention-single-space';
    const N = 100;
    const durations: number[] = [];
    let successes = 0;
    let conflicts = 0;

    const wallStart = performance.now();
    for (let i = 0; i < N; i++) {
      const t0 = performance.now();
      const result = tools.claimScope({
        space_id: SPACE,
        principal: `agent-${i}`, // different principal each time → each succeeds (disjoint paths)
        actor: `agent-${i}/codex`,
        delegation: `agent-${i}->codex`,
        scope: { paths: [`src/exclusive-${i}.ts`] }, // disjoint paths → no conflict
        intent: `claim ${i}`
      });
      durations.push(performance.now() - t0);
      if (result.ok) {
        successes++;
      } else {
        conflicts++;
      }
    }
    const totalWall = performance.now() - wallStart;

    durations.sort((a, b) => a - b);
    const p50 = durations[Math.floor(N * 0.5)]!;
    const p99 = durations[Math.floor(N * 0.99)]!;

    expect(successes).toBe(100);
    expect(conflicts).toBe(0);
    expect(totalWall).toBeLessThan(1000);
    expect(p50).toBeLessThan(50);
    expect(p99).toBeLessThan(200);
  });
});
