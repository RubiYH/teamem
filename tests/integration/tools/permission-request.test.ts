/**
 * Issue #11 — `request_edit_permission` long-poll end-to-end.
 *
 * Three flows:
 *   - open → grant → atomic narrow + new claim minted (long-poll resolves
 *     with `allow`, kept/released paths reflected on incumbent's claim row)
 *   - open → deny → long-poll resolves with `skip(denied_by_incumbent)`
 *   - open → 60s timeout (simulated via `_long_poll_timeout_ms: 0`) →
 *     `permission_expired` event appended, status flipped to `expired`,
 *     long-poll resolves with `skip(timeout)`.
 *
 * Plus: per-space concurrency cap (Pre-mortem F1) and the `403 not_incumbent`
 * gate.
 */
import { describe, expect, it } from 'bun:test';
import { runAllMigrations } from '../../helpers/migrations.js';
import { createSqliteClient } from '../../../src/infra/db/sqlite-client.js';
import { SqliteEventStore } from '../../../src/infra/db/sqlite-event-store.js';
import {
  createTeamemTools,
  DEFAULT_PERMISSION_REQUEST_TIMEOUT_MS
} from '../../../src/server/tools/index.js';

const SPACE = 'space-permreq';

describe('request_edit_permission defaults', () => {
  it('uses a 60s default wait so channel grants can arrive without indefinite blocking', () => {
    expect(DEFAULT_PERMISSION_REQUEST_TIMEOUT_MS).toBe(60_000);
  });
});

function setup() {
  const db = createSqliteClient(':memory:');
  runAllMigrations(db);
  // Seed a space + members so the per-space cap can compute > 1.
  db.exec(
    `INSERT INTO spaces (id, label, creator_member_id, created_at) VALUES
       ('${SPACE}', 'Test', 'm-alice', '2026-05-01T00:00:00.000Z')`
  );
  db.exec(
    `INSERT INTO members (id, space_id, name, joined_at, is_creator) VALUES
       ('m-alice', '${SPACE}', 'alice', '2026-05-01T00:00:00.000Z', 1),
       ('m-bob',   '${SPACE}', 'bob',   '2026-05-01T00:00:00.000Z', 0)`
  );
  const store = new SqliteEventStore(db);
  const tools = createTeamemTools({ db, store });
  return { db, tools };
}

function aliceClaims(
  tools: ReturnType<typeof createTeamemTools>,
  paths: string[]
): string {
  const r = tools.claimScope({
    space_id: SPACE,
    principal: 'alice',
    actor: 'alice',
    delegation: 'alice->alice',
    scope: { paths },
    intent: 'incumbent claim'
  });
  if (!r.ok) throw new Error('claimScope failed');
  return r.data.claim_id;
}

describe('request_edit_permission → grant', () => {
  it('grants atomically narrows incumbent and mints fresh claim for latter', async () => {
    const { db, tools } = setup();
    const aliceClaimId = aliceClaims(tools, [
      'src/auth/login.ts',
      'src/auth/logout.ts'
    ]);

    // Bob requests permission to login.ts only. Alice grants almost
    // immediately — no actual long-poll wait needed.
    const requestPromise = tools.requestEditPermission({
      space_id: SPACE,
      principal: 'bob',
      actor: 'bob',
      delegation: 'bob->bob',
      blocking_claim_id: aliceClaimId,
      paths: ['src/auth/login.ts'],
      intent: 'fix login bug',
      _long_poll_timeout_ms: 5_000
    });

    // Spin up alice's grant on the next tick so the request promise is
    // already registered in the waker map.
    setTimeout(() => {
      // Locate req_id by querying the projection — only one open request
      // exists at this point.
      const row = db
        .prepare(
          `SELECT req_id FROM permission_requests
            WHERE space_id = ?1 AND status = 'open' LIMIT 1`
        )
        .get(SPACE) as { req_id: string } | null;
      if (!row) throw new Error('no open permission_request found');
      const grant = tools.respondPermissionRequest({
        space_id: SPACE,
        principal: 'alice',
        actor: 'alice',
        delegation: 'alice->alice',
        req_id: row.req_id,
        decision: 'accept'
      });
      if (!grant.ok) throw new Error(`grant failed: ${grant.error.code}`);
    }, 5);

    const r = await requestPromise;
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.action).toBe('allow');
      expect(typeof r.data.claim_id).toBe('string');
      expect(typeof r.data.expires_at).toBe('string');
    }

    // Verify the projection: incumbent's claim row was narrowed to
    // logout.ts, a fresh claim row for bob exists on login.ts.
    const aliceRow = db
      .prepare(`SELECT scope_json FROM claims WHERE claim_id = ?1`)
      .get(aliceClaimId) as { scope_json: string } | null;
    expect(aliceRow).not.toBeNull();
    const aliceScope = JSON.parse(aliceRow!.scope_json) as {
      paths: string[];
    };
    expect(aliceScope.paths).toEqual(['src/auth/logout.ts']);

    const bobRows = db
      .prepare(
        `SELECT claim_id, scope_json FROM claims
          WHERE space_id = ?1 AND principal = 'bob' AND status = 'active'`
      )
      .all(SPACE) as Array<{ claim_id: string; scope_json: string }>;
    expect(bobRows).toHaveLength(1);
    const bobScope = JSON.parse(bobRows[0]!.scope_json) as { paths: string[] };
    expect(bobScope.paths).toEqual(['src/auth/login.ts']);
  });

  it('observes grants through the durable projection when the in-process waker is absent', async () => {
    const { db, tools } = setup();
    const aliceClaimId = aliceClaims(tools, ['src/components/Todo.jsx']);

    const requestPromise = tools.requestEditPermission({
      space_id: SPACE,
      principal: 'bob',
      actor: 'bob',
      delegation: 'bob->bob',
      blocking_claim_id: aliceClaimId,
      paths: ['src/components/Todo.jsx'],
      intent: 'edit todo row',
      _long_poll_timeout_ms: 5_000,
      _disable_waker_for_test: true
    });

    setTimeout(() => {
      const row = db
        .prepare(
          `SELECT req_id FROM permission_requests
            WHERE space_id = ?1 AND status = 'open' LIMIT 1`
        )
        .get(SPACE) as { req_id: string } | null;
      if (!row) throw new Error('no open permission_request found');
      const grant = tools.respondPermissionRequest({
        space_id: SPACE,
        principal: 'alice',
        actor: 'alice',
        delegation: 'alice->alice',
        req_id: row.req_id,
        decision: 'accept'
      });
      if (!grant.ok) throw new Error(`grant failed: ${grant.error.code}`);
    }, 5);

    const r = await requestPromise;
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.action).toBe('allow');
      expect(typeof r.data.claim_id).toBe('string');
      expect(typeof r.data.expires_at).toBe('string');
    }
  });

  it('supports create-only polling so hooks do not depend on one long request', async () => {
    const { tools } = setup();
    const aliceClaimId = aliceClaims(tools, ['src/components/Todo.jsx']);
    const reqId = 'req-create-only-poll-1';

    const pending = await tools.requestEditPermission({
      space_id: SPACE,
      principal: 'bob',
      actor: 'bob',
      delegation: 'bob->bob',
      req_id: reqId,
      blocking_claim_id: aliceClaimId,
      paths: ['src/components/Todo.jsx'],
      intent: 'edit todo row',
      _create_only: true
    });
    expect(pending.ok).toBe(true);
    if (pending.ok) {
      expect(pending.data).toEqual({ req_id: reqId, action: 'pending' });
    }

    const grant = tools.respondPermissionRequest({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      req_id: reqId,
      decision: 'accept'
    });
    expect(grant.ok).toBe(true);

    const allowed = await tools.requestEditPermission({
      space_id: SPACE,
      principal: 'bob',
      actor: 'bob',
      delegation: 'bob->bob',
      req_id: reqId,
      blocking_claim_id: aliceClaimId,
      paths: ['src/components/Todo.jsx'],
      _create_only: true
    });
    expect(allowed.ok).toBe(true);
    if (allowed.ok) {
      expect(allowed.data.action).toBe('allow');
      expect(allowed.data.req_id).toBe(reqId);
      expect(typeof allowed.data.claim_id).toBe('string');
    }
  });

  it('expires an existing create-only request when the caller later times out', async () => {
    const { db, tools } = setup();
    const aliceClaimId = aliceClaims(tools, ['src/components/Todo.jsx']);
    const reqId = 'req-create-only-expire-1';

    const pending = await tools.requestEditPermission({
      space_id: SPACE,
      principal: 'bob',
      actor: 'bob',
      delegation: 'bob->bob',
      req_id: reqId,
      blocking_claim_id: aliceClaimId,
      paths: ['src/components/Todo.jsx'],
      _create_only: true
    });
    expect(pending.ok).toBe(true);

    const expired = await tools.requestEditPermission({
      space_id: SPACE,
      principal: 'bob',
      actor: 'bob',
      delegation: 'bob->bob',
      req_id: reqId,
      blocking_claim_id: aliceClaimId,
      paths: ['src/components/Todo.jsx'],
      _long_poll_timeout_ms: 0
    });
    expect(expired.ok).toBe(true);
    if (expired.ok) {
      expect(expired.data).toEqual({
        req_id: reqId,
        action: 'skip',
        reason: 'timeout'
      });
    }

    const row = db
      .prepare(`SELECT status FROM permission_requests WHERE req_id = ?1`)
      .get(reqId) as { status: string } | null;
    expect(row?.status).toBe('expired');
  });
});

describe('request_edit_permission → deny → fallthrough to skip', () => {
  it('deny resolves long-poll with skip(denied_by_incumbent)', async () => {
    const { db, tools } = setup();
    const claimId = aliceClaims(tools, ['src/server/auth.ts']);

    const requestPromise = tools.requestEditPermission({
      space_id: SPACE,
      principal: 'bob',
      actor: 'bob',
      delegation: 'bob->bob',
      blocking_claim_id: claimId,
      paths: ['src/server/auth.ts'],
      _long_poll_timeout_ms: 5_000
    });

    setTimeout(() => {
      const row = db
        .prepare(
          `SELECT req_id FROM permission_requests
            WHERE space_id = ?1 AND status = 'open' LIMIT 1`
        )
        .get(SPACE) as { req_id: string } | null;
      if (!row) throw new Error('no open permission_request found');
      const deny = tools.respondPermissionRequest({
        space_id: SPACE,
        principal: 'alice',
        actor: 'alice',
        delegation: 'alice->alice',
        req_id: row.req_id,
        decision: 'deny'
      });
      if (!deny.ok) throw new Error(`deny failed: ${deny.error.code}`);
    }, 5);

    const r = await requestPromise;
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.action).toBe('skip');
      expect(r.data.reason).toBe('denied_by_incumbent');
    }

    // Incumbent's claim is unchanged.
    const aliceRow = db
      .prepare(`SELECT scope_json FROM claims WHERE claim_id = ?1`)
      .get(claimId) as { scope_json: string } | null;
    const scope = JSON.parse(aliceRow!.scope_json) as { paths: string[] };
    expect(scope.paths).toEqual(['src/server/auth.ts']);
  });
});

describe('request_edit_permission → 60s timeout', () => {
  it('timeout resolves with skip(timeout) and writes permission_expired', async () => {
    const { db, tools } = setup();
    const claimId = aliceClaims(tools, ['src/timeout.ts']);

    const r = await tools.requestEditPermission({
      space_id: SPACE,
      principal: 'bob',
      actor: 'bob',
      delegation: 'bob->bob',
      blocking_claim_id: claimId,
      paths: ['src/timeout.ts'],
      _long_poll_timeout_ms: 0
    });

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.action).toBe('skip');
      expect(r.data.reason).toBe('timeout');
    }

    // permission_expired event was appended and projection flipped status.
    const row = db
      .prepare(
        `SELECT status FROM permission_requests
          WHERE space_id = ?1 ORDER BY created_at DESC LIMIT 1`
      )
      .get(SPACE) as { status: string } | null;
    expect(row?.status).toBe('expired');
  });
});

describe('respond_permission_request — gates', () => {
  it('rejects non-incumbent with not_incumbent', async () => {
    const { db, tools } = setup();
    const claimId = aliceClaims(tools, ['src/gate.ts']);

    // Open a request from bob.
    const requestPromise = tools.requestEditPermission({
      space_id: SPACE,
      principal: 'bob',
      actor: 'bob',
      delegation: 'bob->bob',
      blocking_claim_id: claimId,
      paths: ['src/gate.ts'],
      _long_poll_timeout_ms: 50
    });

    // Wait for the request row to land.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const row = db
      .prepare(
        `SELECT req_id FROM permission_requests
          WHERE space_id = ?1 AND status = 'open' LIMIT 1`
      )
      .get(SPACE) as { req_id: string } | null;
    if (!row) throw new Error('no open permission_request');

    // Bob (not incumbent) tries to grant.
    const r = tools.respondPermissionRequest({
      space_id: SPACE,
      principal: 'bob',
      actor: 'bob',
      delegation: 'bob->bob',
      req_id: row.req_id,
      decision: 'accept'
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('not_incumbent');

    // Drain the long-poll.
    await requestPromise;
  });

  it('rejects no_overlap when requested paths do not match the cited claim', async () => {
    const { tools } = setup();
    const claimId = aliceClaims(tools, ['src/auth/login.ts']);

    const r = await tools.requestEditPermission({
      space_id: SPACE,
      principal: 'bob',
      actor: 'bob',
      delegation: 'bob->bob',
      blocking_claim_id: claimId,
      paths: ['docs/unrelated.md'],
      _long_poll_timeout_ms: 50
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('no_overlap');
  });
});
