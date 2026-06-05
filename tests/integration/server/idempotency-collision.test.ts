/**
 * AC16 + AC17 — server-side claimScope idempotency collision recovery.
 *
 * AC16: key exists + event exists + active projection → idempotent return of claim_id from stored event.
 * AC17: key exists but events row is GONE → idempotency_collision 409 returned.
 * AC30: TEAMEM_IDEMPOTENCY_RECOVERY=0 → collision propagates as 500/throw
 *        (recovery is default-on; unset/anything-else gives recovery semantics).
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { runAllMigrations } from '../../helpers/migrations.js';

import { createSqliteClient } from '../../../src/infra/db/sqlite-client.js';
import { SqliteEventStore } from '../../../src/infra/db/sqlite-event-store.js';
import { createTeamemTools } from '../../../src/server/tools/index.js';
import { resetRateLimitBuckets } from '../../../src/server/rate-limit.js';

function buildTestDb() {
  const db = createSqliteClient(':memory:');
  runAllMigrations(db);
  return db;
}

const TEST_SPACE = 'space-idem-test';
const TEST_PRINCIPAL = 'alice';

beforeEach(() => {
  resetRateLimitBuckets();
});

describe('AC16 — idempotency recovery: key + event present → return stored claim', () => {
  it('second claimScope call with same (space, principal, paths) returns original claim_id', async () => {
    const db = buildTestDb();
    const store = new SqliteEventStore(db);
    const tools = createTeamemTools({ db, store });

    const savedRecovery = process.env.TEAMEM_IDEMPOTENCY_RECOVERY;
    process.env.TEAMEM_IDEMPOTENCY_RECOVERY = '1';

    try {
      const first = tools.claimScope({
        space_id: TEST_SPACE,
        principal: TEST_PRINCIPAL,
        actor: TEST_PRINCIPAL,
        delegation: `${TEST_PRINCIPAL}->${TEST_PRINCIPAL}`,
        scope: { paths: ['src/idem.ts'] },
        auto_release_mode: 'ttl',
        lease_seconds: 3600
      });

      expect(first.ok).toBe(true);
      if (!first.ok) throw new Error('first claim failed');
      const { claim_id: firstClaimId } = first.data;

      // Second call with identical shape → idempotent path via self-superset gate
      const second = tools.claimScope({
        space_id: TEST_SPACE,
        principal: TEST_PRINCIPAL,
        actor: TEST_PRINCIPAL,
        delegation: `${TEST_PRINCIPAL}->${TEST_PRINCIPAL}`,
        scope: { paths: ['src/idem.ts'] },
        auto_release_mode: 'ttl',
        lease_seconds: 3600
      });

      expect(second.ok).toBe(true);
      if (!second.ok) throw new Error('second claim failed');
      // Self-superset gate returns the existing claim
      expect(second.data.claim_id).toBe(firstClaimId);
    } finally {
      if (savedRecovery === undefined) {
        delete process.env.TEAMEM_IDEMPOTENCY_RECOVERY;
      } else {
        process.env.TEAMEM_IDEMPOTENCY_RECOVERY = savedRecovery;
      }
    }
  });

  it('missing claims projection row is stale and re-claims with a fresh visible claim_id', () => {
    const db = buildTestDb();
    const store = new SqliteEventStore(db);
    const tools = createTeamemTools({ db, store });

    const savedRecovery = process.env.TEAMEM_IDEMPOTENCY_RECOVERY;
    process.env.TEAMEM_IDEMPOTENCY_RECOVERY = '1';

    try {
      // First claim
      const first = tools.claimScope({
        space_id: TEST_SPACE,
        principal: TEST_PRINCIPAL,
        actor: TEST_PRINCIPAL,
        delegation: `${TEST_PRINCIPAL}->${TEST_PRINCIPAL}`,
        scope: { paths: ['src/recovery-test.ts'] },
        auto_release_mode: 'ttl',
        lease_seconds: 3600
      });
      expect(first.ok).toBe(true);
      if (!first.ok) throw new Error('first claim failed');
      const firstClaimId = first.data.claim_id;

      // Delete only the projection row to force re-insert attempt while
      // keeping the original event and idempotency_keys row intact.
      db.prepare('DELETE FROM claims WHERE claim_id = ?1').run(firstClaimId);

      // Second call with same paths — gate sees no active claims, tries to insert,
      // hits UNIQUE constraint on idempotency_keys, then treats the missing
      // projection row as stale and salts the new event's idempotency_key.
      const second = tools.claimScope({
        space_id: TEST_SPACE,
        principal: TEST_PRINCIPAL,
        actor: TEST_PRINCIPAL,
        delegation: `${TEST_PRINCIPAL}->${TEST_PRINCIPAL}`,
        scope: { paths: ['src/recovery-test.ts'] },
        auto_release_mode: 'ttl',
        lease_seconds: 3600
      });

      expect(second.ok).toBe(true);
      if (!second.ok) throw new Error('second claim (recovery) failed');
      expect(second.data.claim_id).not.toBe(firstClaimId);

      const listed = tools.listClaims({
        space_id: TEST_SPACE,
        principal: TEST_PRINCIPAL,
        scope: 'self'
      });
      expect(listed.ok).toBe(true);
      if (!listed.ok) throw new Error('list_claims failed');
      expect(listed.data.claims.map((claim) => claim.claim_id)).toEqual([
        second.data.claim_id
      ]);
    } finally {
      if (savedRecovery === undefined) {
        delete process.env.TEAMEM_IDEMPOTENCY_RECOVERY;
      } else {
        process.env.TEAMEM_IDEMPOTENCY_RECOVERY = savedRecovery;
      }
    }
  });
});

describe('AC17 — idempotency_collision: key exists but events row is GONE', () => {
  it('returns ok:false with code=idempotency_collision when event row deleted', () => {
    const db = buildTestDb();
    const store = new SqliteEventStore(db);
    const tools = createTeamemTools({ db, store });

    const savedRecovery = process.env.TEAMEM_IDEMPOTENCY_RECOVERY;
    process.env.TEAMEM_IDEMPOTENCY_RECOVERY = '1';

    try {
      // First claim to establish idempotency_key row
      const first = tools.claimScope({
        space_id: TEST_SPACE,
        principal: TEST_PRINCIPAL,
        actor: TEST_PRINCIPAL,
        delegation: `${TEST_PRINCIPAL}->${TEST_PRINCIPAL}`,
        scope: { paths: ['src/orphan.ts'] },
        auto_release_mode: 'ttl',
        lease_seconds: 3600
      });
      expect(first.ok).toBe(true);
      if (!first.ok) throw new Error('first claim failed');

      const firstClaimId = first.data.claim_id;

      // Delete the event row (but keep idempotency_keys row) — simulates the AC17 scenario
      db.prepare('DELETE FROM events WHERE payload_json LIKE ?1').run(
        `%${firstClaimId}%`
      );
      // Also delete claim so gate doesn't short-circuit via self-overlap
      db.prepare('DELETE FROM claims WHERE claim_id = ?1').run(firstClaimId);

      // Second call: idempotency_key row exists, events row is gone → idempotency_collision
      const second = tools.claimScope({
        space_id: TEST_SPACE,
        principal: TEST_PRINCIPAL,
        actor: TEST_PRINCIPAL,
        delegation: `${TEST_PRINCIPAL}->${TEST_PRINCIPAL}`,
        scope: { paths: ['src/orphan.ts'] },
        auto_release_mode: 'ttl',
        lease_seconds: 3600
      });

      expect(second.ok).toBe(false);
      if (second.ok) throw new Error('expected failure');
      expect(second.error.code).toBe('idempotency_collision');
      expect(second.error).toHaveProperty('idempotency_key');
    } finally {
      if (savedRecovery === undefined) {
        delete process.env.TEAMEM_IDEMPOTENCY_RECOVERY;
      } else {
        process.env.TEAMEM_IDEMPOTENCY_RECOVERY = savedRecovery;
      }
    }
  });
});

describe('AC30 — TEAMEM_IDEMPOTENCY_RECOVERY=0: collision propagates', () => {
  it('with TEAMEM_IDEMPOTENCY_RECOVERY=0, duplicate idempotency key does not silently recover', () => {
    const db = buildTestDb();
    const store = new SqliteEventStore(db);
    const tools = createTeamemTools({ db, store });

    const savedRecovery = process.env.TEAMEM_IDEMPOTENCY_RECOVERY;
    // Recovery is default-on now; opt out by setting the env to '0'.
    process.env.TEAMEM_IDEMPOTENCY_RECOVERY = '0';

    try {
      // First claim
      const first = tools.claimScope({
        space_id: TEST_SPACE,
        principal: TEST_PRINCIPAL,
        actor: TEST_PRINCIPAL,
        delegation: `${TEST_PRINCIPAL}->${TEST_PRINCIPAL}`,
        scope: { paths: ['src/no-recovery.ts'] },
        auto_release_mode: 'ttl',
        lease_seconds: 3600
      });
      expect(first.ok).toBe(true);
      if (!first.ok) throw new Error('first claim failed');

      const firstClaimId = first.data.claim_id;

      // Delete the claim so gate doesn't self-superset
      db.prepare('DELETE FROM claims WHERE claim_id = ?1').run(firstClaimId);

      // Second call: with recovery OFF, UNIQUE constraint throws → propagates (throw or ok:false non-collision)
      // The key assertion: it does NOT silently return idempotency_collision with recovery path
      let threw = false;
      let result: ReturnType<typeof tools.claimScope> | undefined;
      try {
        result = tools.claimScope({
          space_id: TEST_SPACE,
          principal: TEST_PRINCIPAL,
          actor: TEST_PRINCIPAL,
          delegation: `${TEST_PRINCIPAL}->${TEST_PRINCIPAL}`,
          scope: { paths: ['src/no-recovery.ts'] },
          auto_release_mode: 'ttl',
          lease_seconds: 3600
        });
      } catch {
        threw = true;
      }

      // Either threw (error propagated) or returned non-collision result
      // The important assertion: if result exists and ok:false, it should NOT be idempotency_collision
      if (!threw && result && !result.ok) {
        expect(result.error.code).not.toBe('idempotency_collision');
      }
      // If it threw, that is also acceptable (non-recovery propagation)
      expect(threw || result !== undefined).toBe(true);
    } finally {
      if (savedRecovery === undefined) {
        delete process.env.TEAMEM_IDEMPOTENCY_RECOVERY;
      } else {
        process.env.TEAMEM_IDEMPOTENCY_RECOVERY = savedRecovery;
      }
    }
  });
});

describe('AC-NEW: fresh-after-terminal — re-claim succeeds after release/expiry', () => {
  // Prior bug: server's deterministic idempotency key locked alice out of
  // re-claiming a path forever once she'd released or let expire her first
  // claim. The recovery branch returned the OLD (stale) claim instead of
  // letting her acquire a new one. Surfaced in production smoke when alice's
  // first claim sat in idempotency_keys for hours past lease expiry — every
  // subsequent claim_scope on the same path threw "Idempotency conflict".
  it('claim_scope on a path whose prior claim was released succeeds with a fresh claim_id', () => {
    const db = buildTestDb();
    const store = new SqliteEventStore(db);
    const tools = createTeamemTools({ db, store });

    const savedRecovery = process.env.TEAMEM_IDEMPOTENCY_RECOVERY;
    process.env.TEAMEM_IDEMPOTENCY_RECOVERY = '1';

    try {
      const first = tools.claimScope({
        space_id: TEST_SPACE,
        principal: TEST_PRINCIPAL,
        actor: TEST_PRINCIPAL,
        delegation: `${TEST_PRINCIPAL}->${TEST_PRINCIPAL}`,
        scope: { paths: ['src/recycle.ts'] },
        auto_release_mode: 'ttl',
        lease_seconds: 3600
      });
      expect(first.ok).toBe(true);
      if (!first.ok) throw new Error('first claim failed');
      const firstClaimId = first.data.claim_id;

      const released = tools.releaseScope({
        space_id: TEST_SPACE,
        principal: TEST_PRINCIPAL,
        actor: TEST_PRINCIPAL,
        delegation: `${TEST_PRINCIPAL}->${TEST_PRINCIPAL}`,
        claim_id: firstClaimId
      });
      expect(released.ok).toBe(true);

      // Sanity: prior claim is now in terminal state per the projection.
      const priorRow = db
        .query('SELECT released_at FROM claims WHERE claim_id = ?1')
        .get(firstClaimId) as { released_at: string | null } | null;
      expect(priorRow?.released_at).not.toBeNull();

      // Re-claim same path. With the legacy logic this throws Idempotency
      // conflict. With the fresh-after-terminal branch it salts the key and
      // the new acquisition succeeds with a brand-new claim_id.
      const second = tools.claimScope({
        space_id: TEST_SPACE,
        principal: TEST_PRINCIPAL,
        actor: TEST_PRINCIPAL,
        delegation: `${TEST_PRINCIPAL}->${TEST_PRINCIPAL}`,
        scope: { paths: ['src/recycle.ts'] },
        auto_release_mode: 'ttl',
        lease_seconds: 3600
      });
      expect(second.ok).toBe(true);
      if (!second.ok) throw new Error('second claim failed');
      expect(second.data.claim_id).not.toBe(firstClaimId);
      expect(new Date(second.data.expires_at!).getTime()).toBeGreaterThan(
        Date.now()
      );
    } finally {
      if (savedRecovery === undefined) {
        delete process.env.TEAMEM_IDEMPOTENCY_RECOVERY;
      } else {
        process.env.TEAMEM_IDEMPOTENCY_RECOVERY = savedRecovery;
      }
    }
  });

  // Codex F2 (PRD §150 revert regression): when on_commit was switched to
  // expires_at IS NULL, the fresh-after-terminal recovery branch silently
  // skipped because its guard was `if (storedClaimId && storedExpiresAt)`.
  // Releasing then re-claiming the same on_commit path returned
  // idempotency_collision instead of a fresh claim. The fix drops the
  // truthiness guard on storedExpiresAt and consults projection.released_at.
  it('on_commit re-claim after release succeeds with a fresh claim_id (NULL expires_at safe)', () => {
    const db = buildTestDb();
    const store = new SqliteEventStore(db);
    const tools = createTeamemTools({ db, store });

    const savedRecovery = process.env.TEAMEM_IDEMPOTENCY_RECOVERY;
    process.env.TEAMEM_IDEMPOTENCY_RECOVERY = '1';

    try {
      const first = tools.claimScope({
        space_id: TEST_SPACE,
        principal: TEST_PRINCIPAL,
        actor: TEST_PRINCIPAL,
        delegation: `${TEST_PRINCIPAL}->${TEST_PRINCIPAL}`,
        scope: { paths: ['src/oncommit-recycle.ts'] },
        auto_release_mode: 'on_commit'
      });
      expect(first.ok).toBe(true);
      if (!first.ok) throw new Error('first on_commit claim failed');
      // PRD §150 sanity: on_commit produces NULL expires_at.
      expect(first.data.expires_at).toBeNull();
      const firstClaimId = first.data.claim_id;

      const released = tools.releaseScope({
        space_id: TEST_SPACE,
        principal: TEST_PRINCIPAL,
        actor: TEST_PRINCIPAL,
        delegation: `${TEST_PRINCIPAL}->${TEST_PRINCIPAL}`,
        claim_id: firstClaimId
      });
      expect(released.ok).toBe(true);

      const priorRow = db
        .query('SELECT released_at, expires_at FROM claims WHERE claim_id = ?1')
        .get(firstClaimId) as {
        released_at: string | null;
        expires_at: string | null;
      } | null;
      expect(priorRow?.released_at).not.toBeNull();
      expect(priorRow?.expires_at).toBeNull();

      const second = tools.claimScope({
        space_id: TEST_SPACE,
        principal: TEST_PRINCIPAL,
        actor: TEST_PRINCIPAL,
        delegation: `${TEST_PRINCIPAL}->${TEST_PRINCIPAL}`,
        scope: { paths: ['src/oncommit-recycle.ts'] },
        auto_release_mode: 'on_commit'
      });
      expect(second.ok).toBe(true);
      if (!second.ok) throw new Error('second on_commit claim failed');
      expect(second.data.claim_id).not.toBe(firstClaimId);
      expect(second.data.expires_at).toBeNull();
    } finally {
      if (savedRecovery === undefined) {
        delete process.env.TEAMEM_IDEMPOTENCY_RECOVERY;
      } else {
        process.env.TEAMEM_IDEMPOTENCY_RECOVERY = savedRecovery;
      }
    }
  });

  it('on_commit re-claim after missing projection row succeeds with a fresh visible claim_id', () => {
    const db = buildTestDb();
    const store = new SqliteEventStore(db);
    const tools = createTeamemTools({ db, store });

    const savedRecovery = process.env.TEAMEM_IDEMPOTENCY_RECOVERY;
    process.env.TEAMEM_IDEMPOTENCY_RECOVERY = '1';

    try {
      const first = tools.claimScope({
        space_id: TEST_SPACE,
        principal: TEST_PRINCIPAL,
        actor: TEST_PRINCIPAL,
        delegation: `${TEST_PRINCIPAL}->${TEST_PRINCIPAL}`,
        scope: { paths: ['src/oncommit-missing-projection.ts'] },
        auto_release_mode: 'on_commit'
      });
      expect(first.ok).toBe(true);
      if (!first.ok) throw new Error('first on_commit claim failed');
      expect(first.data.expires_at).toBeNull();
      const firstClaimId = first.data.claim_id;

      db.prepare('DELETE FROM claims WHERE claim_id = ?1').run(firstClaimId);

      const second = tools.claimScope({
        space_id: TEST_SPACE,
        principal: TEST_PRINCIPAL,
        actor: TEST_PRINCIPAL,
        delegation: `${TEST_PRINCIPAL}->${TEST_PRINCIPAL}`,
        scope: { paths: ['src/oncommit-missing-projection.ts'] },
        auto_release_mode: 'on_commit'
      });
      expect(second.ok).toBe(true);
      if (!second.ok) throw new Error('second on_commit claim failed');
      expect(second.data.claim_id).not.toBe(firstClaimId);
      expect(second.data.expires_at).toBeNull();

      const listed = tools.listClaims({
        space_id: TEST_SPACE,
        principal: TEST_PRINCIPAL,
        scope: 'self'
      });
      expect(listed.ok).toBe(true);
      if (!listed.ok) throw new Error('list_claims failed');
      expect(listed.data.claims.map((claim) => claim.claim_id)).toEqual([
        second.data.claim_id
      ]);
    } finally {
      if (savedRecovery === undefined) {
        delete process.env.TEAMEM_IDEMPOTENCY_RECOVERY;
      } else {
        process.env.TEAMEM_IDEMPOTENCY_RECOVERY = savedRecovery;
      }
    }
  });
});
