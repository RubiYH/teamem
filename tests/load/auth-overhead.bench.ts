/**
 * AC22 — Auth-overhead load test.
 *
 * Populates a space with N=1000 members, then sends 1000 authenticated
 * POST /tools/teamem.get_updates requests and measures the p50 latency
 * added vs. an unauth baseline (no-op route hit by the same loop).
 * Asserts p50 added < 5ms.
 */
import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { Hono } from 'hono';
import {
  createSqliteClient,
  runMigration
} from '../../src/infra/db/sqlite-client.js';
import { SqliteEventStore } from '../../src/infra/db/sqlite-event-store.js';
import { createTeamemTools } from '../../src/server/tools/index.js';
import { createRouter } from '../../src/server/routes.js';
import { createRequireMemberMiddleware } from '../../src/server/auth.js';
import { signJwt } from '../../src/server/jwt.js';
import { resetRateLimitBuckets } from '../../src/server/rate-limit.js';

const TEST_SECRET = 'load-test-secret-32bytes-padded-x';
const N = 1000;

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

async function setupLoadApp() {
  resetRateLimitBuckets();
  const db = createSqliteClient(':memory:');
  const migrationsDir = join(process.cwd(), 'src/infra/db/migrations');
  runMigration(db, join(migrationsDir, '001_init.sql'));
  runMigration(db, join(migrationsDir, '002_decisions_kind_and_indexes.sql'));
  runMigration(db, join(migrationsDir, '003_room_codes_and_members.sql'));

  const SPACE_ID = 'load-space-001';
  db.run(
    `INSERT INTO spaces (id, label, creator_member_id, created_at) VALUES (?, ?, ?, ?)`,
    [SPACE_ID, 'load-space', 'member-load-0', new Date().toISOString()]
  );

  // Insert N members
  const insertMember = db.prepare(
    `INSERT INTO members (id, space_id, name, joined_at, is_creator) VALUES (?, ?, ?, ?, ?)`
  );
  for (let i = 0; i < N; i++) {
    insertMember.run(
      `member-load-${i}`,
      SPACE_ID,
      `member${i}`,
      new Date().toISOString(),
      i === 0 ? 1 : 0
    );
  }

  const store = new SqliteEventStore(db);
  const tools = createTeamemTools({ db, store });
  const router = createRouter(tools, db, TEST_SECRET);
  const requireMember = createRequireMemberMiddleware(TEST_SECRET, db);

  const app = new Hono();
  // Unauth baseline route
  app.get('/noop', (c) => c.json({ ok: true }));
  app.use('/tools/*', requireMember);
  app.route('/', router);

  // Use the last member for auth (exercises the full members table scan)
  const jwt = await signJwt(
    { sub: `member${N - 1}`, space_id: SPACE_ID },
    TEST_SECRET
  );

  return { app, jwt, spaceId: SPACE_ID };
}

describe('AC22 — auth overhead load test', () => {
  it(`p50 auth overhead < 5ms over ${N} requests`, async () => {
    const { app, jwt, spaceId } = await setupLoadApp();

    // Warm up (10 requests, discarded)
    for (let i = 0; i < 10; i++) {
      await app.request('/noop');
      await app.request('/tools/teamem.get_updates', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${jwt}`
        },
        body: JSON.stringify({ space_id: spaceId })
      });
    }

    // Baseline: N no-op requests (no auth)
    const baselineTimes: number[] = [];
    for (let i = 0; i < N; i++) {
      const t0 = performance.now();
      await app.request('/noop');
      baselineTimes.push(performance.now() - t0);
    }

    // Auth path: N authenticated tool requests
    const authTimes: number[] = [];
    for (let i = 0; i < N; i++) {
      const t0 = performance.now();
      await app.request('/tools/teamem.get_updates', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${jwt}`
        },
        body: JSON.stringify({ space_id: spaceId })
      });
      authTimes.push(performance.now() - t0);
    }

    baselineTimes.sort((a, b) => a - b);
    authTimes.sort((a, b) => a - b);

    const p50Baseline = percentile(baselineTimes, 50);
    const p50Auth = percentile(authTimes, 50);
    const p50Added = p50Auth - p50Baseline;

    console.log(`  baseline p50: ${p50Baseline.toFixed(3)}ms`);
    console.log(`  auth p50:     ${p50Auth.toFixed(3)}ms`);
    console.log(`  added p50:    ${p50Added.toFixed(3)}ms`);

    expect(p50Added).toBeLessThan(5);
  }, 60_000);
});
