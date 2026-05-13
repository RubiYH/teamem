/**
 * E2E: concurrent claim race via subprocess clients (Critic H-K1).
 *
 * The original version bound a loopback HTTP server and raced two claim
 * requests through it. In this environment, local listens are blocked, so
 * the race now uses two Bun subprocesses that open independent SQLite
 * connections against the same migrated DB file and call `claimScope`
 * directly. This keeps the concurrency model meaningful: separate OS
 * processes, separate event loops, separate DB connections.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  createTempDbFile,
  runToolSubprocess
} from '../helpers/tool-subprocess.js';
import { runAllMigrations } from '../helpers/migrations.js';
import { createSqliteClient } from '../../src/infra/db/sqlite-client.js';
import { resetRateLimitBuckets } from '../../src/server/rate-limit.js';
import { createSpace, joinSpace } from '../../src/server/spaces.js';
import type { Database } from 'bun:sqlite';

const TEST_JWT_SECRET = 'test-secret-32bytes-padded-xxxxx';

type E2ECtx = {
  db: Database;
  dbPath: string;
  cleanup: () => void;
  spaceId: string;
};

async function createRaceContext(): Promise<E2ECtx> {
  resetRateLimitBuckets();
  const { dbPath, cleanup } = createTempDbFile('teamem-e2e-race');
  const db = createSqliteClient(dbPath);
  db.exec('PRAGMA busy_timeout = 5000');
  runAllMigrations(db);

  const alice = await createSpace(
    db,
    { member_name: 'alice' },
    TEST_JWT_SECRET
  );
  const roomCodeRow = db
    .query(
      "SELECT code FROM room_codes WHERE space_id = ?1 AND expires_at > datetime('now') LIMIT 1"
    )
    .get(alice.space_id) as { code: string } | null;
  if (!roomCodeRow) {
    throw new Error('missing room code for race bootstrap');
  }

  const joinResult = await joinSpace(
    db,
    { room_code: roomCodeRow.code, member_name: 'bob' },
    TEST_JWT_SECRET
  );
  if (typeof joinResult === 'string') {
    throw new Error(`failed to join race space: ${joinResult}`);
  }

  return { db, dbPath, cleanup, spaceId: alice.space_id };
}

async function fetchClaim(
  dbPath: string,
  spaceId: string,
  principal: string,
  paths: string[]
): Promise<{ status: number; body: unknown }> {
  return runToolSubprocess('claim', dbPath, {
    space_id: spaceId,
    principal,
    actor: `${principal}/race`,
    delegation: `${principal}->${principal}/race`,
    scope: { paths },
    intent: 'e2e race test'
  });
}

describe('E2E: concurrent-claim-race — 10 iter loop, both principals win ≥1', () => {
  let ctx: E2ECtx;

  beforeAll(async () => {
    ctx = await createRaceContext();
  });

  afterAll(() => {
    ctx.cleanup();
  });

  it('both alice and bob each win at least once across 10 iterations', async () => {
    const ITERS = 10;
    const PATHS = ['src/shared/utils.ts'];
    let aliceWins = 0;
    let bobWins = 0;
    let doubleWins = 0;

    for (let i = 0; i < ITERS; i++) {
      // Clear in correct order: idempotency_keys (FK) → events → claims
      ctx.db.exec(
        `DELETE FROM idempotency_keys WHERE idempotency_key IN (
          SELECT idempotency_key FROM events WHERE space_id = '${ctx.spaceId}'
        )`
      );
      ctx.db.exec(`DELETE FROM events WHERE space_id = '${ctx.spaceId}'`);
      ctx.db.exec(`DELETE FROM claims WHERE space_id = '${ctx.spaceId}'`);

      const aliceFirst = i % 2 === 0;
      const [first, second] = aliceFirst
        ? [
            fetchClaim(ctx.dbPath, ctx.spaceId, 'alice', PATHS),
            fetchClaim(ctx.dbPath, ctx.spaceId, 'bob', PATHS)
          ]
        : [
            fetchClaim(ctx.dbPath, ctx.spaceId, 'bob', PATHS),
            fetchClaim(ctx.dbPath, ctx.spaceId, 'alice', PATHS)
          ];
      const [r1, r2] = await Promise.all([first, second]);
      const [aliceRes, bobRes] = aliceFirst ? [r1, r2] : [r2, r1];

      const aliceOk = aliceRes.status === 200;
      const bobOk = bobRes.status === 200;

      if (aliceOk && bobOk) {
        doubleWins++;
      } else if (aliceOk) {
        aliceWins++;
        expect(bobRes.status).toBe(409);
      } else if (bobOk) {
        bobWins++;
        expect(aliceRes.status).toBe(409);
      }

      const activeCount = ctx.db
        .query(
          "SELECT COUNT(*) AS c FROM claims WHERE space_id = ?1 AND status = 'active'"
        )
        .get(ctx.spaceId) as { c: number };
      expect(activeCount.c).toBe(1);
    }

    expect(doubleWins).toBe(0);
    expect(aliceWins).toBeGreaterThanOrEqual(1);
    expect(bobWins).toBeGreaterThanOrEqual(1);
    expect(aliceWins + bobWins).toBe(ITERS);
  });
});
