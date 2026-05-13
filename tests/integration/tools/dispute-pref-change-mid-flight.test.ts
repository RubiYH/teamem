/**
 * Slice #12 — `pref_changed` termination condition.
 *
 * If either party flips their `coord_pref` away from `auto-discuss` while
 * a dispute is open, the dispute terminates immediately on the next move
 * post (with `concede_skip` semantics). This test exercises that flow:
 * alice opens with auto-discuss, dispute opens, alice flips to
 * `auto-skip` between turns 1 and 2, and bob's next move triggers the
 * pref_changed termination.
 */
import { describe, expect, it } from 'bun:test';
import { runAllMigrations } from '../../helpers/migrations.js';
import { createSqliteClient } from '../../../src/infra/db/sqlite-client.js';
import { SqliteEventStore } from '../../../src/infra/db/sqlite-event-store.js';
import { createTeamemTools } from '../../../src/server/tools/index.js';

const SPACE = 'space-pref-change';

function setup() {
  const db = createSqliteClient(':memory:');
  runAllMigrations(db);
  const store = new SqliteEventStore(db);
  const tools = createTeamemTools({ db, store });
  db.exec(
    `INSERT INTO spaces (id, label, creator_member_id, created_at)
       VALUES ('${SPACE}', 'test', 'm-alice', '2026-04-01T00:00:00.000Z');
     INSERT INTO members (id, space_id, name, joined_at, is_creator, coord_pref)
       VALUES ('m-alice', '${SPACE}', 'alice', '2026-04-01T00:00:00.000Z', 1, 'auto-discuss'),
              ('m-bob',   '${SPACE}', 'bob',   '2026-04-02T00:00:00.000Z', 0, 'auto-discuss');`
  );
  return { db, tools, store };
}

describe('dispute pref_changed mid-flight', () => {
  it('alice flips to auto-skip between turns → bobs next move terminates with pref_changed', () => {
    const { db, tools } = setup();

    // Alice claims, bob opens dispute.
    const claim = tools.claimScope({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      scope: { paths: ['src/auth/login.ts'] }
    });
    if (!claim.ok) throw new Error('claim failed');
    const open = tools.openDispute({
      space_id: SPACE,
      principal: 'bob',
      actor: 'bob',
      delegation: 'bob->bob',
      blocking_claim_id: claim.data.claim_id,
      paths: ['src/auth/login.ts'],
      intent: 'ship'
    });
    if (!open.ok) throw new Error('open_dispute failed');

    // Bob's opening proposal — legal, succeeds.
    const m1 = tools.disputePostMove({
      space_id: SPACE,
      principal: 'bob',
      actor: 'bob',
      delegation: 'bob->bob',
      thread_id: open.data.thread_id,
      move_type: 'propose_release_subset',
      payload: { paths: ['src/auth/login.ts'] }
    });
    if (!m1.ok) throw new Error('m1 failed');
    expect(m1.data.status).toBe('open');

    // Alice flips coord_pref away from auto-discuss BEFORE her next move.
    db.prepare(
      `UPDATE members SET coord_pref = 'auto-skip'
        WHERE space_id = ?1 AND name = 'alice'`
    ).run(SPACE);

    // Alice's attempt to reject — pref_changed termination fires first
    // and short-circuits the move. Status flips to terminated with reason
    // pref_changed before her move is recorded.
    const m2 = tools.disputePostMove({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      thread_id: open.data.thread_id,
      move_type: 'reject',
      payload: { reason: 'busy' },
      target_proposal_id: m1.data.move_id
    });
    expect(m2.ok).toBe(true);

    const dispute = db
      .query(
        'SELECT status, termination_reason FROM disputes WHERE thread_id = ?1'
      )
      .get(open.data.thread_id) as {
      status: string;
      termination_reason: string;
    };
    expect(dispute.status).toBe('terminated');
    expect(dispute.termination_reason).toBe('pref_changed');
  });
});
