/**
 * Issue #11 Pre-mortem F5 — two concurrent grants of the same `req_id`:
 * exactly one wins, the other receives `409 already_resolved`.
 *
 * The atomicity comes from the `BEGIN IMMEDIATE TRANSACTION` SELECT-then-
 * UPDATE inside `respondPermissionRequest` — the first transaction takes
 * the row reservation; the second sees `status != 'open'` and returns
 * `already_resolved`.
 */
import { describe, expect, it } from 'bun:test';
import { runAllMigrations } from '../../helpers/migrations.js';
import { createSqliteClient } from '../../../src/infra/db/sqlite-client.js';
import { SqliteEventStore } from '../../../src/infra/db/sqlite-event-store.js';
import { createTeamemTools } from '../../../src/server/tools/index.js';

const SPACE = 'space-concgrant';

function setup() {
  const db = createSqliteClient(':memory:');
  runAllMigrations(db);
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

  // Alice incumbent claim.
  const claim = tools.claimScope({
    space_id: SPACE,
    principal: 'alice',
    actor: 'alice',
    delegation: 'alice->alice',
    scope: { paths: ['src/concurrent.ts'] }
  });
  if (!claim.ok) throw new Error('claimScope failed');

  return { db, tools, claimId: claim.data.claim_id };
}

describe('respond_permission_request — concurrent grants', () => {
  it('exactly one of two concurrent grants succeeds, the other gets already_resolved', async () => {
    const { db, tools, claimId } = setup();

    // Open a long-poll request from bob (don't await yet).
    const requestPromise = tools.requestEditPermission({
      space_id: SPACE,
      principal: 'bob',
      actor: 'bob',
      delegation: 'bob->bob',
      blocking_claim_id: claimId,
      paths: ['src/concurrent.ts'],
      _long_poll_timeout_ms: 5_000
    });

    // Wait for the request row to land in the projection.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const row = db
      .prepare(
        `SELECT req_id FROM permission_requests
          WHERE space_id = ?1 AND status = 'open' LIMIT 1`
      )
      .get(SPACE) as { req_id: string } | null;
    if (!row) throw new Error('no open permission_request');

    // Two concurrent grants of the same req_id. SQLite serializes them via
    // IMMEDIATE; whichever runs first wins, the other sees status != 'open'.
    const grant1 = tools.respondPermissionRequest({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      req_id: row.req_id,
      decision: 'accept'
    });
    const grant2 = tools.respondPermissionRequest({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      req_id: row.req_id,
      decision: 'accept'
    });

    const okCount = [grant1, grant2].filter((r) => r.ok).length;
    const errorCount = [grant1, grant2].filter((r) => !r.ok).length;
    expect(okCount).toBe(1);
    expect(errorCount).toBe(1);

    const errored = !grant1.ok ? grant1 : !grant2.ok ? grant2 : null;
    if (errored && !errored.ok) {
      expect(errored.error.code).toBe('already_resolved');
    }

    // Drain the long-poll — the winning grant fired the waker.
    const r = await requestPromise;
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.action).toBe('allow');
  });
});
