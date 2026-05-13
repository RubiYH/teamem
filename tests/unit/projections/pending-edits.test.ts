import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  findResolvableByRelease,
  gcExpiredPendingEdits,
  loadBlockingPreviews,
  markPendingResolved
} from '../../../src/domain/conflicts/pending-edits.js';

// Issue #10 — pending_edits projection unit tests. Exercises the pure
// query helpers in `src/domain/conflicts/pending-edits.ts` against a real
// in-memory SQLite with all migrations applied.

function buildDb(): Database {
  const db = new Database(':memory:');
  const migDir = join(process.cwd(), 'src/infra/db/migrations');
  const files = readdirSync(migDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const f of files) {
    db.exec(readFileSync(join(migDir, f), 'utf-8'));
  }
  return db;
}

function seedSpace(db: Database, spaceId = 'sp-test'): void {
  db.prepare(
    `INSERT INTO spaces (id, label, creator_member_id) VALUES (?1, 'test', 'm-1')`
  ).run(spaceId);
}

function insertPending(
  db: Database,
  opts: {
    pending_id: string;
    space_id?: string;
    blocked_principal: string;
    blocking_claim_id: string;
    paths: string[];
    intent?: string;
    created_at?: string;
    expires_at?: string;
    resolved_at?: string | null;
  }
): void {
  const space_id = opts.space_id ?? 'sp-test';
  const created = opts.created_at ?? new Date().toISOString();
  const expires =
    opts.expires_at ?? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  db.prepare(
    `INSERT INTO pending_edits
       (pending_id, space_id, blocked_principal, blocking_claim_id,
        paths_json, intent, created_at, expires_at, resolved_at,
        source_event_id, tombstoned_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL)`
  ).run(
    opts.pending_id,
    space_id,
    opts.blocked_principal,
    opts.blocking_claim_id,
    JSON.stringify(opts.paths),
    opts.intent ?? null,
    created,
    expires,
    opts.resolved_at ?? null,
    `evt-${opts.pending_id}`
  );
}

describe('findResolvableByRelease — direct claim_id match', () => {
  it('returns rows whose blocking_claim_id matches the released claim', () => {
    const db = buildDb();
    seedSpace(db);
    insertPending(db, {
      pending_id: 'p-1',
      blocked_principal: 'bob',
      blocking_claim_id: 'claim-alice-1',
      paths: ['src/auth/login.ts']
    });
    insertPending(db, {
      pending_id: 'p-2',
      blocked_principal: 'carol',
      blocking_claim_id: 'claim-alice-2', // different claim
      paths: ['src/server/routes.ts']
    });

    const hits = findResolvableByRelease(db, 'sp-test', 'claim-alice-1', []);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.pending_id).toBe('p-1');
    expect(hits[0]!.blocked_principal).toBe('bob');
  });
});

describe('findResolvableByRelease — path overlap match', () => {
  it('returns rows whose paths overlap the released scope', () => {
    const db = buildDb();
    seedSpace(db);
    insertPending(db, {
      pending_id: 'p-1',
      blocked_principal: 'bob',
      blocking_claim_id: 'unrelated-claim',
      paths: ['src/auth/login.ts']
    });
    const hits = findResolvableByRelease(db, 'sp-test', 'released-claim', [
      'src/auth/login.ts'
    ]);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.pending_id).toBe('p-1');
  });

  it('returns rows whose paths overlap via glob', () => {
    const db = buildDb();
    seedSpace(db);
    insertPending(db, {
      pending_id: 'p-1',
      blocked_principal: 'bob',
      blocking_claim_id: 'unrelated-claim',
      paths: ['src/auth/login.ts']
    });
    const hits = findResolvableByRelease(db, 'sp-test', 'released-claim', [
      'src/auth/*'
    ]);
    expect(hits).toHaveLength(1);
  });

  it('does NOT return rows whose paths do not overlap', () => {
    const db = buildDb();
    seedSpace(db);
    insertPending(db, {
      pending_id: 'p-1',
      blocked_principal: 'bob',
      blocking_claim_id: 'unrelated-claim',
      paths: ['docs/AGENTS.md']
    });
    const hits = findResolvableByRelease(db, 'sp-test', 'released-claim', [
      'src/auth/login.ts'
    ]);
    expect(hits).toHaveLength(0);
  });
});

describe('findResolvableByRelease — exclusion filters', () => {
  it('excludes already-resolved rows', () => {
    const db = buildDb();
    seedSpace(db);
    insertPending(db, {
      pending_id: 'p-1',
      blocked_principal: 'bob',
      blocking_claim_id: 'claim-alice-1',
      paths: ['src/auth/login.ts'],
      resolved_at: new Date().toISOString()
    });
    const hits = findResolvableByRelease(db, 'sp-test', 'claim-alice-1', []);
    expect(hits).toHaveLength(0);
  });

  it('excludes rows in other spaces', () => {
    const db = buildDb();
    seedSpace(db, 'sp-test');
    seedSpace(db, 'sp-other');
    insertPending(db, {
      pending_id: 'p-1',
      space_id: 'sp-other',
      blocked_principal: 'bob',
      blocking_claim_id: 'claim-alice-1',
      paths: ['src/auth/login.ts']
    });
    const hits = findResolvableByRelease(db, 'sp-test', 'claim-alice-1', []);
    expect(hits).toHaveLength(0);
  });
});

describe('markPendingResolved', () => {
  it('flips resolved_at to the supplied timestamp', () => {
    const db = buildDb();
    seedSpace(db);
    insertPending(db, {
      pending_id: 'p-1',
      blocked_principal: 'bob',
      blocking_claim_id: 'c-1',
      paths: ['x']
    });
    markPendingResolved(db, 'p-1', '2026-05-03T10:00:00.000Z');

    const row = db
      .prepare('SELECT resolved_at FROM pending_edits WHERE pending_id = ?1')
      .get('p-1') as { resolved_at: string | null };
    expect(row.resolved_at).toBe('2026-05-03T10:00:00.000Z');
  });

  it('is a no-op on already-resolved rows (preserves original timestamp)', () => {
    const db = buildDb();
    seedSpace(db);
    insertPending(db, {
      pending_id: 'p-1',
      blocked_principal: 'bob',
      blocking_claim_id: 'c-1',
      paths: ['x'],
      resolved_at: '2026-05-01T00:00:00.000Z'
    });
    markPendingResolved(db, 'p-1', '2026-05-03T10:00:00.000Z');
    const row = db
      .prepare('SELECT resolved_at FROM pending_edits WHERE pending_id = ?1')
      .get('p-1') as { resolved_at: string };
    expect(row.resolved_at).toBe('2026-05-01T00:00:00.000Z');
  });
});

describe('gcExpiredPendingEdits', () => {
  it('removes rows whose expires_at is in the past and resolved_at IS NULL', () => {
    const db = buildDb();
    seedSpace(db);
    insertPending(db, {
      pending_id: 'p-old',
      blocked_principal: 'bob',
      blocking_claim_id: 'c-1',
      paths: ['x'],
      expires_at: '2020-01-01T00:00:00.000Z'
    });
    insertPending(db, {
      pending_id: 'p-fresh',
      blocked_principal: 'carol',
      blocking_claim_id: 'c-2',
      paths: ['y']
      // expires_at defaults to now+24h
    });

    const removed = gcExpiredPendingEdits(db, '2026-05-03T00:00:00.000Z');
    expect(removed).toBe(1);

    const remaining = db
      .prepare('SELECT pending_id FROM pending_edits ORDER BY pending_id')
      .all() as Array<{ pending_id: string }>;
    expect(remaining.map((r) => r.pending_id)).toEqual(['p-fresh']);
  });

  it('does NOT delete expired-but-resolved rows (kept for audit)', () => {
    const db = buildDb();
    seedSpace(db);
    insertPending(db, {
      pending_id: 'p-resolved-old',
      blocked_principal: 'bob',
      blocking_claim_id: 'c-1',
      paths: ['x'],
      expires_at: '2020-01-01T00:00:00.000Z',
      resolved_at: '2020-01-01T00:00:01.000Z'
    });
    const removed = gcExpiredPendingEdits(db, '2026-05-03T00:00:00.000Z');
    expect(removed).toBe(0);
    const count = (
      db.prepare('SELECT COUNT(*) AS c FROM pending_edits').get() as {
        c: number;
      }
    ).c;
    expect(count).toBe(1);
  });
});

describe('loadBlockingPreviews', () => {
  it('groups blocked principals by blocking_claim_id', () => {
    const db = buildDb();
    seedSpace(db);
    insertPending(db, {
      pending_id: 'p-1',
      blocked_principal: 'bob',
      blocking_claim_id: 'claim-alice-1',
      paths: ['src/auth/login.ts']
    });
    insertPending(db, {
      pending_id: 'p-2',
      blocked_principal: 'carol',
      blocking_claim_id: 'claim-alice-1',
      paths: ['src/auth/utils.ts']
    });
    insertPending(db, {
      pending_id: 'p-3',
      blocked_principal: 'dan',
      blocking_claim_id: 'claim-alice-2',
      paths: ['src/server/routes.ts']
    });

    const map = loadBlockingPreviews(db, 'sp-test');
    expect(map.size).toBe(2);
    const aliceQueue1 = map.get('claim-alice-1')!;
    expect(aliceQueue1).toHaveLength(2);
    const principals = aliceQueue1.map((q) => q.blocked_principal).sort();
    expect(principals).toEqual(['bob', 'carol']);

    const aliceQueue2 = map.get('claim-alice-2')!;
    expect(aliceQueue2).toHaveLength(1);
    expect(aliceQueue2[0]!.blocked_principal).toBe('dan');
    expect(aliceQueue2[0]!.paths).toEqual(['src/server/routes.ts']);
  });

  it('omits resolved rows', () => {
    const db = buildDb();
    seedSpace(db);
    insertPending(db, {
      pending_id: 'p-1',
      blocked_principal: 'bob',
      blocking_claim_id: 'claim-x',
      paths: ['x'],
      resolved_at: new Date().toISOString()
    });
    const map = loadBlockingPreviews(db, 'sp-test');
    expect(map.size).toBe(0);
  });
});
