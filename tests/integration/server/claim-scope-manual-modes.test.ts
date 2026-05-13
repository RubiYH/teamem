/**
 * Slice #34 — manual claim modes integration tests.
 *
 * AC coverage (PRD §150 — expires_at IS NULL for on_commit and manual_only):
 *  - manual_only: expires_at IS NULL, auto_release_mode='manual_only'
 *  - ttl: expires_at = acquire_time + lease_seconds (within 1s), mode='ttl'
 *  - on_commit: expires_at IS NULL, mode='on_commit'
 *  - ttl + branch composes correctly
 *  - Server rejects ttl with lease_seconds <= 0
 *  - Server rejects manual_only and on_commit with lease_seconds (ttl-only field)
 *  - Story 12 — mode stickiness: gate self-overlap leaves manual_only unchanged
 *  - TTL expiry at query-time: expired ttl claim allows new claim from bob
 *  - Pause does NOT pause TTL countdown (expires_at unchanged after pause)
 */

import { describe, expect, it } from 'bun:test';
import { createSqliteClient } from '../../../src/infra/db/sqlite-client.js';
import { SqliteEventStore } from '../../../src/infra/db/sqlite-event-store.js';
import { createTeamemTools } from '../../../src/server/tools/index.js';
import { runAllMigrations } from '../../helpers/migrations.js';
import type { Database } from 'bun:sqlite';

const SPACE = 'space-manual-modes-test';
const REPO = 'github.com/org/repo';
const BRANCH = 'feature/alice';
const PATH = 'src/Form.jsx';

function setup(): {
  db: Database;
  tools: ReturnType<typeof createTeamemTools>;
} {
  const db = createSqliteClient(':memory:');
  runAllMigrations(db);
  const store = new SqliteEventStore(db);
  const tools = createTeamemTools({ db, store });
  db.prepare(
    `INSERT OR IGNORE INTO spaces (id, label, created_at) VALUES (?1, ?2, ?3)`
  ).run(SPACE, 'test-space', new Date().toISOString());
  return { db, tools };
}

describe('manual_only mode (slice #34)', () => {
  it('creates claim with expires_at IS NULL and mode=manual_only', () => {
    const { db, tools } = setup();
    const before = Date.now();

    const result = tools.claimScope({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      scope: { paths: [PATH] },
      repo_id: REPO,
      branch: BRANCH,
      auto_release_mode: 'manual_only'
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.expires_at).toBeNull();

    const row = db
      .query(
        'SELECT expires_at, auto_release_mode FROM claims WHERE claim_id = ?1'
      )
      .get(result.data.claim_id) as {
      expires_at: string | null;
      auto_release_mode: string;
    } | null;
    expect(row).not.toBeNull();
    expect(row!.expires_at).toBeNull();
    expect(row!.auto_release_mode).toBe('manual_only');

    void before;
  });

  it('rejects manual_only with lease_seconds', () => {
    const { tools } = setup();

    const result = tools.claimScope({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      scope: { paths: [PATH] },
      repo_id: REPO,
      branch: BRANCH,
      auto_release_mode: 'manual_only',
      lease_seconds: 300
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_PAYLOAD');
    }
  });
});

describe('ttl mode (slice #34)', () => {
  it('creates claim with expires_at ~= now + lease_seconds, mode=ttl', () => {
    const { db, tools } = setup();
    const before = Date.now();

    const result = tools.claimScope({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      scope: { paths: [PATH] },
      repo_id: REPO,
      branch: BRANCH,
      auto_release_mode: 'ttl',
      lease_seconds: 1800 // 30 minutes
    });

    const after = Date.now();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.expires_at).not.toBeNull();
    const expiresMs = new Date(result.data.expires_at!).getTime();
    expect(expiresMs).toBeGreaterThanOrEqual(before + 1800 * 1000 - 1000);
    expect(expiresMs).toBeLessThanOrEqual(after + 1800 * 1000 + 1000);

    const row = db
      .query('SELECT auto_release_mode FROM claims WHERE claim_id = ?1')
      .get(result.data.claim_id) as { auto_release_mode: string } | null;
    expect(row!.auto_release_mode).toBe('ttl');
  });

  it('rejects ttl with lease_seconds <= 0', () => {
    const { tools } = setup();

    const result = tools.claimScope({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      scope: { paths: [PATH] },
      repo_id: REPO,
      branch: BRANCH,
      auto_release_mode: 'ttl',
      lease_seconds: 0
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_PAYLOAD');
    }
  });

  it('--ttl + --branch compose correctly', () => {
    const { db, tools } = setup();

    const result = tools.claimScope({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      scope: { paths: [PATH] },
      repo_id: REPO,
      branch: 'feature/x',
      auto_release_mode: 'ttl',
      lease_seconds: 300
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.expires_at).not.toBeNull();

    const row = db
      .query('SELECT branch, auto_release_mode FROM claims WHERE claim_id = ?1')
      .get(result.data.claim_id) as {
      branch: string;
      auto_release_mode: string;
    } | null;
    expect(row!.branch).toBe('feature/x');
    expect(row!.auto_release_mode).toBe('ttl');
  });
});

describe('on_commit mode (slice #34, PRD §150 — expires_at NULL)', () => {
  it('creates claim with expires_at IS NULL and mode=on_commit', () => {
    const { db, tools } = setup();

    const result = tools.claimScope({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      scope: { paths: [PATH] },
      repo_id: REPO,
      branch: BRANCH,
      auto_release_mode: 'on_commit'
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.expires_at).toBeNull();

    const row = db
      .query(
        'SELECT expires_at, auto_release_mode FROM claims WHERE claim_id = ?1'
      )
      .get(result.data.claim_id) as {
      expires_at: string | null;
      auto_release_mode: string;
    } | null;
    expect(row!.expires_at).toBeNull();
    expect(row!.auto_release_mode).toBe('on_commit');
  });

  it('rejects on_commit when caller passes lease_seconds (ttl-only field)', () => {
    const { tools } = setup();

    const result = tools.claimScope({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      scope: { paths: [PATH] },
      repo_id: REPO,
      branch: BRANCH,
      auto_release_mode: 'on_commit',
      lease_seconds: 3600
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_PAYLOAD');
  });
});

describe('story 12 — mode stickiness (slice #34)', () => {
  it('gate self-overlap on manual_only claim does not mutate auto_release_mode', () => {
    const { db, tools } = setup();

    // Alice manually claims as manual_only
    const r1 = tools.claimScope({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      scope: { paths: [PATH] },
      repo_id: REPO,
      branch: BRANCH,
      auto_release_mode: 'manual_only'
    });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;

    // Gate re-claims (simulates PreToolUse) with on_commit — should be idempotent,
    // keeping manual_only mode in the projection row.
    const r2 = tools.claimScope({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      scope: { paths: [PATH] },
      repo_id: REPO,
      branch: BRANCH,
      auto_release_mode: 'on_commit'
    });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;

    // Same claim_id (idempotent self-overlap)
    expect(r2.data.claim_id).toBe(r1.data.claim_id);

    // Projection row must still have manual_only — mode is sticky
    const row = db
      .query('SELECT auto_release_mode FROM claims WHERE claim_id = ?1')
      .get(r1.data.claim_id) as { auto_release_mode: string } | null;
    expect(row!.auto_release_mode).toBe('manual_only');
  });
});

describe('TTL expiry at query-time (slice #34)', () => {
  it('expired ttl claim allows new claim from bob', () => {
    const { db, tools } = setup();

    // Alice claims with a 2s TTL
    const r1 = tools.claimScope({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      scope: { paths: [PATH] },
      repo_id: REPO,
      branch: BRANCH,
      auto_release_mode: 'ttl',
      lease_seconds: 2
    });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;

    // Simulate TTL expiry by back-dating expires_at
    db.prepare('UPDATE claims SET expires_at = ?1 WHERE claim_id = ?2').run(
      new Date(Date.now() - 5000).toISOString(),
      r1.data.claim_id
    );

    // Bob can now claim the same path (alice's claim is expired)
    const r2 = tools.claimScope({
      space_id: SPACE,
      principal: 'bob',
      actor: 'bob',
      delegation: 'bob->bob',
      scope: { paths: [PATH] },
      repo_id: REPO,
      branch: BRANCH,
      auto_release_mode: 'on_commit'
    });
    expect(r2.ok).toBe(true);
  });
});

describe('pause does not affect TTL countdown (slice #34)', () => {
  it('expires_at is unchanged after pause', () => {
    const { db, tools } = setup();

    const r1 = tools.claimScope({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      scope: { paths: [PATH] },
      repo_id: REPO,
      branch: BRANCH,
      auto_release_mode: 'ttl',
      lease_seconds: 1800
    });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;

    const expiresAtBefore = db
      .query('SELECT expires_at FROM claims WHERE claim_id = ?1')
      .get(r1.data.claim_id) as { expires_at: string } | null;
    expect(expiresAtBefore).not.toBeNull();

    // Pause the claim (branch switch)
    const pauseResult = tools.pauseClaimsForBranch({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      repo_id: REPO,
      branch: BRANCH,
      reason: 'branch_switch'
    });
    expect(pauseResult.ok).toBe(true);

    // expires_at must be unchanged after pause
    const expiresAtAfter = db
      .query('SELECT expires_at FROM claims WHERE claim_id = ?1')
      .get(r1.data.claim_id) as { expires_at: string } | null;
    expect(expiresAtAfter!.expires_at).toBe(expiresAtBefore!.expires_at);
  });
});

describe('codex P1 — self-reclaim must not silently mutate the stored mode', () => {
  it('TTL claim re-claimed without auto_release_mode keeps non-null expires_at', () => {
    const { db, tools } = setup();

    // 1. Original ttl claim with 30-minute lease.
    const r1 = tools.claimScope({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      scope: { paths: [PATH] },
      repo_id: REPO,
      branch: BRANCH,
      auto_release_mode: 'ttl',
      lease_seconds: 1800
    });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.data.expires_at).not.toBeNull();
    const claimId = r1.data.claim_id;

    // 2. Self-reclaim with no auto_release_mode (defaults to on_commit). The
    //    pre-fix code would have rewritten expires_at to NULL because it used
    //    the new request's resolvedMode for the refresh decision. The fix:
    //    the stored claim's mode (ttl) must drive the refresh — and since
    //    the user did NOT re-assert ttl + lease here, expires_at must NOT
    //    be wiped. It stays at whatever the stored value was.
    const r2 = tools.claimScope({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      scope: { paths: [PATH] },
      repo_id: REPO,
      branch: BRANCH
    });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.data.claim_id).toBe(claimId);
    expect(r2.data.expires_at).not.toBeNull();

    const row = db
      .query(
        'SELECT auto_release_mode, expires_at FROM claims WHERE claim_id = ?1'
      )
      .get(claimId) as {
      auto_release_mode: string;
      expires_at: string | null;
    } | null;
    expect(row!.auto_release_mode).toBe('ttl');
    expect(row!.expires_at).not.toBeNull();
  });

  it('TTL claim re-asserted with new ttl + lease refreshes expires_at forward', () => {
    const { db, tools } = setup();

    const r1 = tools.claimScope({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      scope: { paths: [PATH] },
      repo_id: REPO,
      branch: BRANCH,
      auto_release_mode: 'ttl',
      lease_seconds: 60
    });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    const original = Date.parse(r1.data.expires_at!);

    // Back-date the stored expires_at into the past so we can detect a
    // real refresh (the wall-clock granularity at ms makes a real-time
    // refresh hard to tell from a no-op).
    db.prepare('UPDATE claims SET expires_at = ?1 WHERE claim_id = ?2').run(
      new Date(original - 30_000).toISOString(),
      r1.data.claim_id
    );

    const r2 = tools.claimScope({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      scope: { paths: [PATH] },
      repo_id: REPO,
      branch: BRANCH,
      auto_release_mode: 'ttl',
      lease_seconds: 60
    });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(Date.parse(r2.data.expires_at!)).toBeGreaterThan(original - 30_000);
  });

  it('on_commit claim re-claimed without args keeps stored mode + null expires_at', () => {
    const { db, tools } = setup();

    const r1 = tools.claimScope({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      scope: { paths: [PATH] },
      repo_id: REPO,
      branch: BRANCH,
      auto_release_mode: 'on_commit'
    });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.data.expires_at).toBeNull();

    const r2 = tools.claimScope({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      scope: { paths: [PATH] },
      repo_id: REPO,
      branch: BRANCH
    });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.data.claim_id).toBe(r1.data.claim_id);
    expect(r2.data.expires_at).toBeNull();

    const row = db
      .query(
        'SELECT auto_release_mode, expires_at FROM claims WHERE claim_id = ?1'
      )
      .get(r1.data.claim_id) as {
      auto_release_mode: string;
      expires_at: string | null;
    } | null;
    expect(row!.auto_release_mode).toBe('on_commit');
    expect(row!.expires_at).toBeNull();
  });
});
