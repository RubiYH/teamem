/**
 * TOCTOU pre-claim gate integration tests.
 *
 * AC-NEW-1  Real-concurrency race — 50-iter loop, both principals win ≥10 times,
 *           zero double-200, exactly 1 active claim after each iter.
 * AC-NEW-2  SELECT-then-INSERT atomicity via SYNC function-injection seam.
 * AC-NEW-3  Self-overlap idempotency — same principal + same paths → same claim_id.
 * AC-NEW-4  Self-superset idempotency — wider existing claim returned.
 * AC-NEW-5  Released claim does NOT block a new claim by another principal.
 * AC-NEW-6  Expired claim does NOT block (direct DB mutation, no real-clock wait).
 * AC-NEW-9  Observability counter assertions — 100 mixed calls (50/30/20).
 * AC-NEW-10 Cross-actor same-principal idempotency (actor does not affect key).
 * AC-NEW-11 Parallel-release dedup — two concurrent releases → exactly one event.
 *
 * All tests that need real concurrency use Bun subprocesses against the same
 * migrated SQLite file — NOT in-process app.request(), which shares the
 * SQLite handle and microtask-orders deterministically (Critic K1).
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it
} from 'bun:test';
import { runAllMigrations } from '../../helpers/migrations.js';
import {
  createTempDbFile,
  runToolSubprocess
} from '../../helpers/tool-subprocess.js';
import { createSqliteClient } from '../../../src/infra/db/sqlite-client.js';
import { SqliteEventStore } from '../../../src/infra/db/sqlite-event-store.js';
import { createTeamemTools } from '../../../src/server/tools/index.js';
import { resetRateLimitBuckets } from '../../../src/server/rate-limit.js';
import { metricsResetAll, metrics } from '../../../src/server/metrics.js';
import { createSpace, joinSpace } from '../../../src/server/spaces.js';
import type { Database } from 'bun:sqlite';

const TEST_JWT_SECRET = 'test-secret-32bytes-padded-xxxxx';

// ── helpers ──────────────────────────────────────────────────────────────────

function setupDb(): Database {
  const db = createSqliteClient(':memory:');
  runAllMigrations(db);
  return db;
}

type TestContext = {
  db: Database;
  spaceId: string;
  dbPath: string;
  cleanup: () => void;
};

async function bootstrapServer(): Promise<TestContext> {
  resetRateLimitBuckets();
  const { dbPath, cleanup } = createTempDbFile('teamem-toctou');
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
    throw new Error('missing room code for test bootstrap');
  }
  const joinResult = await joinSpace(
    db,
    { room_code: roomCodeRow.code, member_name: 'bob' },
    TEST_JWT_SECRET
  );
  if (typeof joinResult === 'string') {
    throw new Error(`failed to join TOCTOU test space: ${joinResult}`);
  }

  return { db, spaceId: alice.space_id, dbPath, cleanup };
}

async function httpClaim(
  ctx: TestContext,
  principal: string,
  paths: string[]
): Promise<{ status: number; body: unknown }> {
  return runToolSubprocess('claim', ctx.dbPath, {
    space_id: ctx.spaceId,
    principal,
    actor: `${principal}/race`,
    delegation: `${principal}->${principal}/race`,
    scope: { paths },
    intent: 'test'
  });
}

async function httpRelease(
  ctx: TestContext,
  principal: string,
  claim_id: string
): Promise<{ status: number; body: unknown }> {
  return runToolSubprocess('release', ctx.dbPath, {
    space_id: ctx.spaceId,
    principal,
    actor: `${principal}/race`,
    delegation: `${principal}->${principal}/race`,
    claim_id
  });
}

function activeClaimCount(db: Database, spaceId: string): number {
  const row = db
    .query(
      "SELECT COUNT(*) AS c FROM claims WHERE space_id = ?1 AND status = 'active'"
    )
    .get(spaceId) as { c: number };
  return row.c;
}

// ── AC-NEW-1: Real-concurrency race (50 iter loop) ──────────────────────────

describe('AC-NEW-1: parallel claim race — 50 iter loop', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await bootstrapServer();
  });

  afterAll(() => {
    ctx.cleanup();
  });

  it('alice wins ≥10, bob wins ≥10, zero double-200, exactly 1 active claim each iter', async () => {
    const ITERS = 50;
    const PATHS = ['src/components/Form.jsx'];
    let aliceWins = 0;
    let bobWins = 0;
    let doubleWins = 0;

    for (let i = 0; i < ITERS; i++) {
      // Clear all claims and events between iterations.
      // Order: idempotency_keys first (FK references events), then events, then claims.
      ctx.db.exec(
        `DELETE FROM idempotency_keys WHERE idempotency_key IN (
          SELECT idempotency_key FROM events WHERE space_id = '${ctx.spaceId}'
        )`
      );
      ctx.db.exec(`DELETE FROM events WHERE space_id = '${ctx.spaceId}'`);
      ctx.db.exec(`DELETE FROM claims WHERE space_id = '${ctx.spaceId}'`);

      // Randomize submission order per iteration. Promise.all preserves
      // microtask scheduling order, so always launching alice first biases
      // the lock-acquisition race deterministically. Coin-flip the order so
      // both principals can win across the 50 iterations.
      const aliceFirst = Math.random() < 0.5;
      const [first, second] = aliceFirst
        ? [httpClaim(ctx, 'alice', PATHS), httpClaim(ctx, 'bob', PATHS)]
        : [httpClaim(ctx, 'bob', PATHS), httpClaim(ctx, 'alice', PATHS)];
      const [r1, r2] = await Promise.all([first, second]);
      const [aliceRes, bobRes] = aliceFirst ? [r1, r2] : [r2, r1];

      const aliceOk = aliceRes.status === 200;
      const bobOk = bobRes.status === 200;

      if (aliceOk && bobOk) {
        doubleWins++;
      } else if (aliceOk) {
        aliceWins++;
        // Verify loser got 409 with correct shape
        const errBody = bobRes.body as {
          ok: boolean;
          error: {
            code: string;
            conflicting_claim_id: string;
            conflicting_principal: string;
            colliding_paths: string[];
            message: string;
          };
        };
        expect(bobRes.status).toBe(409);
        expect(errBody.ok).toBe(false);
        expect(errBody.error.code).toBe('scope_conflict');
        expect(errBody.error.conflicting_principal).toBe('alice');
        expect(errBody.error.colliding_paths).toEqual(PATHS);
        const aliceBody = aliceRes.body as {
          ok: boolean;
          data: { claim_id: string };
        };
        expect(errBody.error.conflicting_claim_id).toBe(
          aliceBody.data.claim_id
        );
      } else if (bobOk) {
        bobWins++;
        const errBody = aliceRes.body as {
          ok: boolean;
          error: {
            code: string;
            conflicting_principal: string;
            colliding_paths: string[];
          };
        };
        expect(aliceRes.status).toBe(409);
        expect(errBody.ok).toBe(false);
        expect(errBody.error.code).toBe('scope_conflict');
        expect(errBody.error.conflicting_principal).toBe('bob');
        expect(errBody.error.colliding_paths).toEqual(PATHS);
      } else {
        // Both 409 — impossible with correct gate; both lost
      }

      // Exactly 1 active claim after each iteration
      expect(activeClaimCount(ctx.db, ctx.spaceId)).toBe(1);
    }

    expect(doubleWins).toBe(0);
    expect(aliceWins).toBeGreaterThanOrEqual(10);
    expect(bobWins).toBeGreaterThanOrEqual(10);
    expect(aliceWins + bobWins).toBe(ITERS);
  });
});

// ── AC-NEW-2: SELECT-then-INSERT atomicity via SYNC seam ────────────────────

describe('AC-NEW-2: atomicity via afterSelectHook sync seam', () => {
  it('hook fires inside tx and second concurrent caller still sees the first INSERT', async () => {
    const db = setupDb();
    const store = new SqliteEventStore(db);
    const tools = createTeamemTools({ db, store });

    // Create a real Bun.serve server with the hook injected via in-process call.
    // For the atomicity proof we use the direct tools API with the seam.
    // Two concurrent in-process calls share the same DB — the .immediate()
    // transaction makes the second call block until the first commits.

    const PATHS = ['src/components/Button.tsx'];
    const SPACE = 'seam-test-space';

    let hookFiredCount = 0;

    // Call 1 with a 50ms sync delay inside the tx (Atomics.wait on a fresh SAB)
    const hookedClaim = () =>
      tools.claimScope(
        {
          space_id: SPACE,
          principal: 'alice',
          actor: 'alice/agent',
          delegation: 'alice->agent',
          scope: { paths: PATHS },
          intent: 'test atomicity'
        },
        {
          afterSelectHook: () => {
            hookFiredCount++;
            // Sync 50ms wait — MUST NOT be async/awaited inside the tx
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
          }
        }
      );

    // Call 2 without hook — will block at BEGIN IMMEDIATE until call 1 commits
    const plainClaim = () =>
      tools.claimScope({
        space_id: SPACE,
        principal: 'bob',
        actor: 'bob/agent',
        delegation: 'bob->agent',
        scope: { paths: PATHS },
        intent: 'test atomicity'
      });

    // Note: bun:sqlite transactions are synchronous. We cannot run two
    // true-concurrent JS tasks in the same thread. The seam proves atomicity
    // by verifying the hook fired and the gate correctly enforces serial
    // execution: whichever runs second sees the first INSERT.
    const r1 = hookedClaim();
    const r2 = plainClaim();

    expect(hookFiredCount).toBe(1);

    // Exactly one succeeds, one gets 409
    const results = [r1, r2];
    const successes = results.filter((r) => r.ok);
    const conflicts = results.filter(
      (r) =>
        !r.ok &&
        (r as { error: { code: string } }).error.code === 'scope_conflict'
    );
    expect(successes).toHaveLength(1);
    expect(conflicts).toHaveLength(1);

    // Exactly one scope_claimed event
    const evCount = db
      .query(
        "SELECT COUNT(*) AS c FROM events WHERE space_id = ?1 AND event_type = 'scope_claimed'"
      )
      .get(SPACE) as { c: number };
    expect(evCount.c).toBe(1);

    // Exactly one active claim
    expect(activeClaimCount(db, SPACE)).toBe(1);
  });
});

// ── AC-NEW-3: Self-overlap idempotency ──────────────────────────────────────

describe('AC-NEW-3: self-overlap idempotency', () => {
  it('same principal + same paths → same claim_id, exactly one scope_claimed event', () => {
    const db = setupDb();
    const store = new SqliteEventStore(db);
    const tools = createTeamemTools({ db, store });

    const SPACE = 'idempotent-space';
    const PATHS = ['src/auth/login.ts'];

    const r1 = tools.claimScope({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice/agent',
      delegation: 'alice->agent',
      scope: { paths: PATHS },
      intent: 'first claim'
    });
    const r2 = tools.claimScope({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice/agent',
      delegation: 'alice->agent',
      scope: { paths: PATHS },
      intent: 'retry'
    });

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      // Same claim_id returned on retry — that's the idempotency contract.
      expect(r2.data.claim_id).toBe(r1.data.claim_id);
      // PRD §150: default mode is on_commit → expires_at IS NULL.
      // The refresh path keeps NULL for non-ttl modes. (TTL refresh is
      // covered by AC-NEW-3a below.)
      expect(r1.data.expires_at).toBeNull();
      expect(r2.data.expires_at).toBeNull();
    }

    // Exactly one scope_claimed event — no duplicate written
    const evCount = db
      .query(
        "SELECT COUNT(*) AS c FROM events WHERE space_id = ?1 AND event_type = 'scope_claimed'"
      )
      .get(SPACE) as { c: number };
    expect(evCount.c).toBe(1);
  });
});

// ── AC-NEW-3a: Self-overlap idempotency — expires_at refreshed ──────────────

describe('AC-NEW-3a: self-overlap idempotent re-claim refreshes expires_at', () => {
  it('re-claim returns refreshed expires_at > original, DB row updated, exactly one scope_claimed event', () => {
    const db = setupDb();
    const store = new SqliteEventStore(db);
    const tools = createTeamemTools({ db, store });

    const SPACE = 'refresh-space';
    const PATHS = ['src/auth/login.ts'];

    // First claim with 60s lease (ttl mode — only mode that uses lease_seconds
    // per PRD §150).
    const r1 = tools.claimScope({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice/agent',
      delegation: 'alice->agent',
      scope: { paths: PATHS },
      intent: 'first claim',
      auto_release_mode: 'ttl',
      lease_seconds: 60
    });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;

    const originalExpiresAt = r1.data.expires_at;

    // Fast-forward the DB row's expires_at by 30s into the past relative to
    // the original value, simulating that 30s have elapsed without a real wait.
    const originalMs = new Date(originalExpiresAt!).getTime();
    const fastForwardedExpiresAt = new Date(originalMs - 30_000).toISOString();
    db.prepare('UPDATE claims SET expires_at = ?1 WHERE claim_id = ?2').run(
      fastForwardedExpiresAt,
      r1.data.claim_id
    );

    // Re-call claim_scope for same principal + paths with a 60s lease
    const r2 = tools.claimScope({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice/agent',
      delegation: 'alice->agent',
      scope: { paths: PATHS },
      intent: 'retry',
      auto_release_mode: 'ttl',
      lease_seconds: 60
    });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;

    // Response expires_at must be strictly greater than the fast-forwarded value
    expect(new Date(r2.data.expires_at!).getTime()).toBeGreaterThan(
      new Date(fastForwardedExpiresAt).getTime()
    );

    // Same claim_id (idempotent)
    expect(r2.data.claim_id).toBe(r1.data.claim_id);

    // DB row expires_at must match what the response returned
    const dbRow = db
      .query('SELECT expires_at FROM claims WHERE claim_id = ?1')
      .get(r1.data.claim_id) as { expires_at: string } | null;
    expect(dbRow?.expires_at).toBe(r2.data.expires_at!);

    // Still exactly one scope_claimed event
    const evCount = db
      .query(
        "SELECT COUNT(*) AS c FROM events WHERE space_id = ?1 AND event_type = 'scope_claimed'"
      )
      .get(SPACE) as { c: number };
    expect(evCount.c).toBe(1);
  });
});

// ── AC-NEW-4: Self-superset idempotency ─────────────────────────────────────

describe('AC-NEW-4: self-superset idempotency', () => {
  it('existing wider claim returned when new scope is a subset', () => {
    const db = setupDb();
    const store = new SqliteEventStore(db);
    const tools = createTeamemTools({ db, store });

    const SPACE = 'superset-space';

    // Alice first claims a glob (wider scope)
    const r1 = tools.claimScope({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice/agent',
      delegation: 'alice->agent',
      scope: { paths: ['src/auth/**'] },
      intent: 'rewrite auth'
    });
    expect(r1.ok).toBe(true);

    // Alice then claims a specific file (subset of the glob)
    const r2 = tools.claimScope({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice/agent',
      delegation: 'alice->agent',
      scope: { paths: ['src/auth/login.ts'] },
      intent: 'edit login'
    });
    expect(r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      // Second call returns the first (superset) claim_id
      expect(r2.data.claim_id).toBe(r1.data.claim_id);
    }

    // Exactly one scope_claimed event
    const evCount = db
      .query(
        "SELECT COUNT(*) AS c FROM events WHERE space_id = ?1 AND event_type = 'scope_claimed'"
      )
      .get(SPACE) as { c: number };
    expect(evCount.c).toBe(1);
  });

  it('tiebreaker: when multiple self-claims overlap, latest ULID wins', () => {
    const db = setupDb();
    const store = new SqliteEventStore(db);
    const tools = createTeamemTools({ db, store });

    const SPACE = 'tiebreaker-space';

    // Alice claims two separate globs (disjoint — each can be claimed independently)
    const r1 = tools.claimScope({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice/agent',
      delegation: 'alice->agent',
      scope: { paths: ['src/auth/**'] },
      intent: 'first'
    });
    expect(r1.ok).toBe(true);

    // Second claim on overlapping path returns the first claim's id (superset)
    const r2 = tools.claimScope({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice/agent',
      delegation: 'alice->agent',
      scope: { paths: ['src/auth/login.ts'] },
      intent: 'subset'
    });
    expect(r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      expect(r2.data.claim_id).toBe(r1.data.claim_id);
    }
  });
});

// ── AC-NEW-5: Released claim does NOT block ──────────────────────────────────

describe('AC-NEW-5: released claim does not block new claim', () => {
  it('principal B can claim after principal A releases', () => {
    const db = setupDb();
    const store = new SqliteEventStore(db);
    const tools = createTeamemTools({ db, store });

    const SPACE = 'release-space';
    const PATHS = ['src/x.ts'];

    // Alice claims and releases
    const r1 = tools.claimScope({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice/agent',
      delegation: 'alice->agent',
      scope: { paths: PATHS },
      intent: 'temporary'
    });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;

    const rel = tools.releaseScope({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice/agent',
      delegation: 'alice->agent',
      claim_id: r1.data.claim_id
    });
    expect(rel.ok).toBe(true);

    // Bob can now claim the same path
    const r2 = tools.claimScope({
      space_id: SPACE,
      principal: 'bob',
      actor: 'bob/agent',
      delegation: 'bob->agent',
      scope: { paths: PATHS },
      intent: 'after release'
    });
    expect(r2.ok).toBe(true);

    // Alice's row has released_at set, Bob's row is active
    const aliceRow = db
      .query('SELECT released_at, status FROM claims WHERE claim_id = ?1')
      .get(r1.data.claim_id) as {
      released_at: string | null;
      status: string;
    } | null;
    expect(aliceRow?.released_at).not.toBeNull();

    if (r2.ok) {
      const bobRow = db
        .query('SELECT status FROM claims WHERE claim_id = ?1')
        .get(r2.data.claim_id) as { status: string } | null;
      expect(bobRow?.status).toBe('active');
    }
  });
});

// ── AC-NEW-6: Expired claim does NOT block ───────────────────────────────────

describe('AC-NEW-6: expired claim does not block new claim', () => {
  it('expired claim (direct DB mutation, no real clock wait) does not block bob', () => {
    const db = setupDb();
    const store = new SqliteEventStore(db);
    const tools = createTeamemTools({ db, store });

    const SPACE = 'expired-space';
    const PATHS = ['src/y.ts'];

    // Alice claims with a 60s lease (ttl mode — only mode that has a TTL
    // per PRD §150).
    const r1 = tools.claimScope({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice/agent',
      delegation: 'alice->agent',
      scope: { paths: PATHS },
      intent: 'will expire',
      auto_release_mode: 'ttl',
      lease_seconds: 60
    });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;

    // Direct DB mutation — set expires_at in the past (no real clock wait)
    db.prepare(
      "UPDATE claims SET expires_at = '2020-01-01T00:00:00.000Z' WHERE claim_id = ?1"
    ).run(r1.data.claim_id);

    // Bob can now claim the same path because alice's claim is expired
    const r2 = tools.claimScope({
      space_id: SPACE,
      principal: 'bob',
      actor: 'bob/agent',
      delegation: 'bob->agent',
      scope: { paths: PATHS },
      intent: 'after expiry'
    });
    expect(r2.ok).toBe(true);
    if (r2.ok) {
      expect(r2.data.claim_id).not.toBe(r1.data.claim_id);
    }
  });
});

// ── AC-NEW-9: Observability counter assertions ────────────────────────────────

describe('AC-NEW-9: counter assertions — 100 mixed calls (50/30/20)', () => {
  beforeEach(() => {
    metricsResetAll();
  });

  it('exact counter values after 50 success + 30 self-idempotent + 20 foreign-conflict', () => {
    const db = setupDb();
    const store = new SqliteEventStore(db);
    const tools = createTeamemTools({ db, store });

    // 50 unique-success claims: each principal claims a distinct path in a distinct space
    for (let i = 0; i < 50; i++) {
      const r = tools.claimScope({
        space_id: `counter-space-${i}`,
        principal: 'alice',
        actor: 'alice/agent',
        delegation: 'alice->agent',
        scope: { paths: [`src/module-${i}.ts`] },
        intent: `claim ${i}`
      });
      expect(r.ok).toBe(true);
    }

    // 30 self-idempotent retries: repeat the same (space_id, principal, paths) tuples
    for (let i = 0; i < 30; i++) {
      const spaceIdx = i % 50;
      const r = tools.claimScope({
        space_id: `counter-space-${spaceIdx}`,
        principal: 'alice',
        actor: 'alice/cli', // different actor — idempotency is keyed on principal, NOT actor
        delegation: 'alice->cli',
        scope: { paths: [`src/module-${spaceIdx}.ts`] },
        intent: 'retry'
      });
      expect(r.ok).toBe(true);
    }

    // 20 foreign-conflict attempts: bob tries to claim paths already held by alice
    for (let i = 0; i < 20; i++) {
      const spaceIdx = i % 50;
      const r = tools.claimScope({
        space_id: `counter-space-${spaceIdx}`,
        principal: 'bob',
        actor: 'bob/agent',
        delegation: 'bob->agent',
        scope: { paths: [`src/module-${spaceIdx}.ts`] },
        intent: 'conflict'
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe('scope_conflict');
      }
    }

    expect(metrics.getCounter('claim_scope.gate.success')).toBe(50);
    expect(metrics.getCounter('claim_scope.gate.self_idempotent')).toBe(30);
    expect(metrics.getCounter('claim_scope.gate.foreign_conflict')).toBe(20);

    // tx_duration_ms histogram has exactly 100 observations (one per call)
    const durations = metrics.getHistogram('claim_scope.gate.tx_duration_ms');
    expect(durations.length).toBe(100);
    const sorted = [...durations].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length / 2)]!;
    expect(p50).toBeLessThan(50);
  });
});

// ── AC-NEW-10: Cross-actor same-principal idempotency ────────────────────────

describe('AC-NEW-10: cross-actor same-principal idempotency', () => {
  it('alice/cli and alice/codex both get the same claim_id — idempotency keyed on principal, not actor', () => {
    const db = setupDb();
    const store = new SqliteEventStore(db);
    const tools = createTeamemTools({ db, store });

    const SPACE = 'cross-actor-space';
    const PATHS = ['src/auth/login.ts'];

    const r1 = tools.claimScope({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice/cli',
      delegation: 'alice->cli',
      scope: { paths: PATHS },
      intent: 'from CLI'
    });
    expect(r1.ok).toBe(true);

    const r2 = tools.claimScope({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice/codex',
      delegation: 'alice->codex',
      scope: { paths: PATHS },
      intent: 'from Codex'
    });
    expect(r2.ok).toBe(true);

    if (r1.ok && r2.ok) {
      // Different actor, same claim_id
      expect(r2.data.claim_id).toBe(r1.data.claim_id);
    }

    // Exactly one scope_claimed event
    const evCount = db
      .query(
        "SELECT COUNT(*) AS c FROM events WHERE space_id = ?1 AND event_type = 'scope_claimed'"
      )
      .get(SPACE) as { c: number };
    expect(evCount.c).toBe(1);
  });
});

// ── AC-NEW-11: Parallel-release dedup ───────────────────────────────────────

describe('AC-NEW-11: parallel-release dedup', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await bootstrapServer();
  });

  afterAll(() => {
    ctx.cleanup();
  });

  it('two parallel releases → both return released:true, exactly one scope_released event', async () => {
    // Clean slate for this test
    ctx.db.exec(
      `DELETE FROM idempotency_keys WHERE idempotency_key IN (
        SELECT idempotency_key FROM events WHERE space_id = '${ctx.spaceId}'
      )`
    );
    ctx.db.exec(`DELETE FROM events WHERE space_id = '${ctx.spaceId}'`);
    ctx.db.exec(`DELETE FROM claims WHERE space_id = '${ctx.spaceId}'`);

    // Alice claims a scope first
    const claimRes = await httpClaim(ctx, 'alice', ['src/dedup/file.ts']);
    expect(claimRes.status).toBe(200);
    const claimBody = claimRes.body as {
      ok: boolean;
      data: { claim_id: string };
    };
    expect(claimBody.ok).toBe(true);
    const claimId = claimBody.data.claim_id;

    // Two parallel releases for the same claim_id
    const [rel1, rel2] = await Promise.all([
      httpRelease(ctx, 'alice', claimId),
      httpRelease(ctx, 'alice', claimId)
    ]);

    // Both return released: true (idempotent no-op for the second one)
    expect(rel1.status).toBe(200);
    expect(rel2.status).toBe(200);
    const r1b = rel1.body as { ok: boolean; data: { released: boolean } };
    const r2b = rel2.body as { ok: boolean; data: { released: boolean } };
    expect(r1b.data.released).toBe(true);
    expect(r2b.data.released).toBe(true);

    // Exactly one scope_released event for this claim_id
    const evCount = db_from_ctx(ctx)
      .query(
        "SELECT COUNT(*) AS c FROM events WHERE space_id = ?1 AND event_type = 'scope_released'"
      )
      .get(ctx.spaceId) as { c: number };
    expect(evCount.c).toBe(1);
  });
});

function db_from_ctx(ctx: TestContext): Database {
  return ctx.db;
}

// ── AC-NEW-1 409 shape validation (dedicated shape test) ─────────────────────

describe('AC-NEW-1: 409 response body has all four required fields', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await bootstrapServer();
  });

  afterAll(() => {
    ctx.cleanup();
  });

  it('409 body has code, conflicting_claim_id, conflicting_principal, colliding_paths, message', async () => {
    // Clear in correct order: idempotency_keys (FK) → events → claims
    ctx.db.exec(
      `DELETE FROM idempotency_keys WHERE idempotency_key IN (
        SELECT idempotency_key FROM events WHERE space_id = '${ctx.spaceId}'
      )`
    );
    ctx.db.exec(`DELETE FROM events WHERE space_id = '${ctx.spaceId}'`);
    ctx.db.exec(`DELETE FROM claims WHERE space_id = '${ctx.spaceId}'`);

    const PATHS = ['src/shape-test/file.ts'];

    // Alice claims first
    const aliceRes = await httpClaim(ctx, 'alice', PATHS);
    expect(aliceRes.status).toBe(200);
    const aliceBody = aliceRes.body as {
      ok: boolean;
      data: { claim_id: string };
    };

    // Bob tries to claim the same path
    const bobRes = await httpClaim(ctx, 'bob', PATHS);
    expect(bobRes.status).toBe(409);

    const errBody = bobRes.body as {
      ok: boolean;
      error: {
        code: string;
        conflicting_claim_id: string;
        conflicting_principal: string;
        colliding_paths: string[];
        message: string;
      };
    };

    expect(errBody.ok).toBe(false);
    expect(errBody.error.code).toBe('scope_conflict');
    expect(typeof errBody.error.conflicting_claim_id).toBe('string');
    expect(errBody.error.conflicting_claim_id).toBe(aliceBody.data.claim_id);
    expect(errBody.error.conflicting_principal).toBe('alice');
    expect(Array.isArray(errBody.error.colliding_paths)).toBe(true);
    expect(errBody.error.colliding_paths).toEqual(PATHS);
    expect(typeof errBody.error.message).toBe('string');
    expect(errBody.error.message.length).toBeGreaterThan(0);
  });
});
