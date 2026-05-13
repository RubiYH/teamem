/**
 * Issue #11 Pre-mortem F1 — per-space concurrency cap on
 * `request_edit_permission`. Floor is `max(20, 2 × active_members)`. With
 * 2 members the cap is 20; the 21st in-flight request should immediately
 * receive `429 too_many_pending_requests` without consuming a long-poll
 * slot (no FD allocated, no row inserted).
 */
import { describe, expect, it } from 'bun:test';
import { runAllMigrations } from '../helpers/migrations.js';
import { createSqliteClient } from '../../src/infra/db/sqlite-client.js';
import { SqliteEventStore } from '../../src/infra/db/sqlite-event-store.js';
import { createTeamemTools } from '../../src/server/tools/index.js';

const SPACE = 'space-cap';

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

  // Alice claims a wide scope so multiple distinct requested paths can
  // overlap.
  const claim = tools.claimScope({
    space_id: SPACE,
    principal: 'alice',
    actor: 'alice',
    delegation: 'alice->alice',
    scope: { paths: ['src/**'] }
  });
  if (!claim.ok) throw new Error('claimScope failed');
  return { db, tools, claimId: claim.data.claim_id };
}

describe('AC11-F1 — per-space cap engages at max(20, 2×members)', () => {
  it('21st concurrent request returns 429 too_many_pending_requests, no row inserted', async () => {
    const { db, tools, claimId } = setup();

    // Fire 20 long-poll requests; let them sit in their wakers — we only
    // need them to occupy `status='open'` rows.
    const inflight: Promise<unknown>[] = [];
    for (let i = 0; i < 20; i++) {
      inflight.push(
        tools.requestEditPermission({
          space_id: SPACE,
          principal: 'bob',
          actor: 'bob',
          delegation: 'bob->bob',
          blocking_claim_id: claimId,
          paths: [`src/cap-${i}.ts`],
          _long_poll_timeout_ms: 30_000
        })
      );
    }

    // Wait briefly for projections to land.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const openCount = (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM permission_requests
            WHERE space_id = ?1 AND status = 'open'`
        )
        .get(SPACE) as { c: number }
    ).c;
    expect(openCount).toBe(20);

    // 21st request must reject with `too_many_pending_requests`.
    const overflow = await tools.requestEditPermission({
      space_id: SPACE,
      principal: 'bob',
      actor: 'bob',
      delegation: 'bob->bob',
      blocking_claim_id: claimId,
      paths: ['src/cap-overflow.ts'],
      _long_poll_timeout_ms: 5_000
    });
    expect(overflow.ok).toBe(false);
    if (!overflow.ok) {
      expect(overflow.error.code).toBe('too_many_pending_requests');
    }

    // No new row was inserted on the rejected request.
    const finalOpenCount = (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM permission_requests
            WHERE space_id = ?1 AND status = 'open'`
        )
        .get(SPACE) as { c: number }
    ).c;
    expect(finalOpenCount).toBe(20);

    // Drain the in-flight long-polls by denying them one by one to let
    // the test exit cleanly.
    const rows = db
      .prepare(
        `SELECT req_id FROM permission_requests
          WHERE space_id = ?1 AND status = 'open'`
      )
      .all(SPACE) as Array<{ req_id: string }>;
    for (const r of rows) {
      tools.respondPermissionRequest({
        space_id: SPACE,
        principal: 'alice',
        actor: 'alice',
        delegation: 'alice->alice',
        req_id: r.req_id,
        decision: 'deny'
      });
    }
    await Promise.all(inflight);
  }, 60_000);
});
