/**
 * Slice #12 — Mode 6.C dispute round-trip integration tests.
 *
 * Each test seeds two members (alice = incumbent, bob = opener), seeds an
 * incumbent claim, opens a dispute, drives moves through the state
 * machine, and asserts the final claim/dispute state. Covers each of the
 * 4 proposal types ending in `accept` plus each of the 5 termination
 * conditions.
 */
import { describe, expect, it } from 'bun:test';
import { runAllMigrations } from '../../helpers/migrations.js';
import { createSqliteClient } from '../../../src/infra/db/sqlite-client.js';
import { SqliteEventStore } from '../../../src/infra/db/sqlite-event-store.js';
import { createTeamemTools } from '../../../src/server/tools/index.js';

const SPACE = 'space-disputes';

function setup() {
  const db = createSqliteClient(':memory:');
  runAllMigrations(db);
  const store = new SqliteEventStore(db);
  const tools = createTeamemTools({ db, store });

  // Seed space + members with auto-discuss prefs so disputes are valid.
  db.exec(
    `INSERT INTO spaces (id, label, creator_member_id, created_at)
       VALUES ('${SPACE}', 'test', 'm-alice', '2026-04-01T00:00:00.000Z');
     INSERT INTO members (id, space_id, name, joined_at, is_creator, coord_pref)
       VALUES ('m-alice', '${SPACE}', 'alice', '2026-04-01T00:00:00.000Z', 1, 'auto-discuss'),
              ('m-bob',   '${SPACE}', 'bob',   '2026-04-02T00:00:00.000Z', 0, 'auto-discuss');`
  );

  return { db, tools, store };
}

function aliceClaims(
  tools: ReturnType<typeof createTeamemTools>,
  paths: string[]
): { claim_id: string } {
  const r = tools.claimScope({
    space_id: SPACE,
    principal: 'alice',
    actor: 'alice',
    delegation: 'alice->alice',
    scope: { paths }
  });
  if (!r.ok) throw new Error(`claim_scope failed: ${JSON.stringify(r)}`);
  return { claim_id: r.data.claim_id };
}

function openDispute(
  tools: ReturnType<typeof createTeamemTools>,
  blocking_claim_id: string,
  paths: string[]
): { thread_id: string } {
  const r = tools.openDispute({
    space_id: SPACE,
    principal: 'bob',
    actor: 'bob',
    delegation: 'bob->bob',
    blocking_claim_id,
    paths,
    intent: 'ship oauth refactor'
  });
  if (!r.ok) throw new Error(`open_dispute failed: ${JSON.stringify(r)}`);
  return { thread_id: r.data.thread_id };
}

describe('Mode 6.C — dispute round-trips', () => {
  it('propose_release_subset → accept narrows incumbent and grants opener', () => {
    const { db, tools } = setup();
    const { claim_id } = aliceClaims(tools, [
      'src/auth/login.ts',
      'src/auth/middleware.ts'
    ]);
    const { thread_id } = openDispute(tools, claim_id, ['src/auth/login.ts']);

    const proposal = tools.disputePostMove({
      space_id: SPACE,
      principal: 'bob',
      actor: 'bob',
      delegation: 'bob->bob',
      thread_id,
      move_type: 'propose_release_subset',
      payload: { paths: ['src/auth/login.ts'] }
    });
    expect(proposal.ok).toBe(true);
    if (!proposal.ok) throw new Error('move 1 failed');

    const accept = tools.disputePostMove({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      thread_id,
      move_type: 'accept',
      target_proposal_id: proposal.data.move_id
    });
    expect(accept.ok).toBe(true);
    if (!accept.ok) throw new Error('accept failed');
    expect(accept.data.status).toBe('resolved');
    expect(accept.data.outcome).toBe('release_subset');

    // Alice's claim narrowed to middleware.ts only.
    const aliceRow = db
      .query('SELECT scope_json FROM claims WHERE claim_id = ?1')
      .get(claim_id) as { scope_json: string };
    expect(JSON.parse(aliceRow.scope_json).paths).toEqual([
      'src/auth/middleware.ts'
    ]);

    // Bob now owns a fresh active claim on login.ts.
    const bobClaim = db
      .query(
        `SELECT scope_json FROM claims
          WHERE space_id = ?1 AND principal = 'bob' AND status = 'active'`
      )
      .get(SPACE) as { scope_json: string };
    expect(JSON.parse(bobClaim.scope_json).paths).toEqual([
      'src/auth/login.ts'
    ]);

    // Disputes row is resolved.
    const dispute = db
      .query(
        'SELECT status, termination_reason FROM disputes WHERE thread_id = ?1'
      )
      .get(thread_id) as { status: string; termination_reason: string };
    expect(dispute.status).toBe('resolved');
    expect(dispute.termination_reason).toBe('explicit');
  });

  it('propose_release_full → accept releases entire incumbent claim', () => {
    const { db, tools } = setup();
    const { claim_id } = aliceClaims(tools, ['src/auth/login.ts']);
    const { thread_id } = openDispute(tools, claim_id, ['src/auth/login.ts']);

    const proposal = tools.disputePostMove({
      space_id: SPACE,
      principal: 'bob',
      actor: 'bob',
      delegation: 'bob->bob',
      thread_id,
      move_type: 'propose_release_full',
      payload: {}
    });
    if (!proposal.ok) throw new Error('proposal failed');

    const accept = tools.disputePostMove({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      thread_id,
      move_type: 'accept',
      target_proposal_id: proposal.data.move_id
    });
    if (!accept.ok) throw new Error('accept failed');
    expect(accept.data.outcome).toBe('release_full');

    // Alice's claim is fully released.
    const aliceRow = db
      .query('SELECT status FROM claims WHERE claim_id = ?1')
      .get(claim_id) as { status: string };
    expect(aliceRow.status).toBe('released');
  });

  it('propose_release_after_task → accept emits dispute_resolved with outcome=wait, no scope change', () => {
    const { db, tools } = setup();
    const { claim_id } = aliceClaims(tools, ['src/auth/login.ts']);
    const { thread_id } = openDispute(tools, claim_id, ['src/auth/login.ts']);

    // Bob opens with a subset proposal so it's alice's turn next.
    const propBob = tools.disputePostMove({
      space_id: SPACE,
      principal: 'bob',
      actor: 'bob',
      delegation: 'bob->bob',
      thread_id,
      move_type: 'propose_release_subset',
      payload: { paths: ['src/auth/login.ts'] }
    });
    if (!propBob.ok) throw new Error('bob move failed');

    // Alice counter-proposes "wait 600s then I release" — that's
    // informational, but bob accepting it is an explicit agreement.
    const propAlice = tools.disputePostMove({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      thread_id,
      move_type: 'propose_release_after_task',
      payload: { wait_seconds: 600 }
    });
    if (!propAlice.ok) throw new Error('alice move failed');

    const accept = tools.disputePostMove({
      space_id: SPACE,
      principal: 'bob',
      actor: 'bob',
      delegation: 'bob->bob',
      thread_id,
      move_type: 'accept',
      target_proposal_id: propAlice.data.move_id
    });
    if (!accept.ok)
      throw new Error(`bob accept failed: ${JSON.stringify(accept)}`);
    expect(accept.data.outcome).toBe('wait');

    // Alice's claim is unchanged — wait is informational only.
    const aliceRow = db
      .query('SELECT status, scope_json FROM claims WHERE claim_id = ?1')
      .get(claim_id) as { status: string; scope_json: string };
    expect(aliceRow.status).toBe('active');
    expect(JSON.parse(aliceRow.scope_json).paths).toEqual([
      'src/auth/login.ts'
    ]);
  });

  it('propose_swap → accept narrows incumbent and grants opener', () => {
    const { db, tools } = setup();
    const { claim_id } = aliceClaims(tools, [
      'src/api/login.ts',
      'src/api/users.ts'
    ]);
    const { thread_id } = openDispute(tools, claim_id, ['src/api/login.ts']);

    const proposal = tools.disputePostMove({
      space_id: SPACE,
      principal: 'bob',
      actor: 'bob',
      delegation: 'bob->bob',
      thread_id,
      move_type: 'propose_swap',
      payload: {
        i_release: ['src/ui/Login.tsx'],
        you_release: ['src/api/login.ts']
      }
    });
    if (!proposal.ok) throw new Error('swap proposal failed');

    const accept = tools.disputePostMove({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      thread_id,
      move_type: 'accept',
      target_proposal_id: proposal.data.move_id
    });
    if (!accept.ok) throw new Error('swap accept failed');
    expect(accept.data.outcome).toBe('swap');

    // Alice's claim narrowed to users.ts only.
    const aliceRow = db
      .query('SELECT scope_json FROM claims WHERE claim_id = ?1')
      .get(claim_id) as { scope_json: string };
    expect(JSON.parse(aliceRow.scope_json).paths).toEqual(['src/api/users.ts']);

    // Bob has fresh claim on login.ts.
    const bobClaim = db
      .query(
        `SELECT scope_json FROM claims
          WHERE space_id = ?1 AND principal = 'bob' AND status = 'active'`
      )
      .get(SPACE) as { scope_json: string };
    expect(JSON.parse(bobClaim.scope_json).paths).toEqual(['src/api/login.ts']);
  });
});

describe('Mode 6.C — termination conditions', () => {
  it('explicit termination via concede_skip', () => {
    const { db, tools } = setup();
    const { claim_id } = aliceClaims(tools, ['src/auth/login.ts']);
    const { thread_id } = openDispute(tools, claim_id, ['src/auth/login.ts']);

    const concede = tools.disputePostMove({
      space_id: SPACE,
      principal: 'bob',
      actor: 'bob',
      delegation: 'bob->bob',
      thread_id,
      move_type: 'concede_skip',
      payload: {}
    });
    if (!concede.ok) throw new Error('concede failed');
    expect(concede.data.status).toBe('terminated');
    expect(concede.data.outcome).toBe('skip');

    const dispute = db
      .query(
        'SELECT status, termination_reason FROM disputes WHERE thread_id = ?1'
      )
      .get(thread_id) as { status: string; termination_reason: string };
    expect(dispute.status).toBe('terminated');
  });

  it('user_override via end_dispute(deny)', () => {
    const { db, tools } = setup();
    const { claim_id } = aliceClaims(tools, ['src/auth/login.ts']);
    const { thread_id } = openDispute(tools, claim_id, ['src/auth/login.ts']);

    const r = tools.endDispute({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      thread_id,
      action: 'deny'
    });
    if (!r.ok) throw new Error('end_dispute failed');
    expect(r.data.status).toBe('terminated');
    expect(r.data.outcome).toBe('deny');

    const dispute = db
      .query('SELECT termination_reason FROM disputes WHERE thread_id = ?1')
      .get(thread_id) as { termination_reason: string };
    expect(dispute.termination_reason).toBe('user_override');
  });

  it('turns termination at max_turns (default 4)', () => {
    const { db, tools } = setup();
    const { claim_id } = aliceClaims(tools, [
      'src/auth/login.ts',
      'src/auth/middleware.ts'
    ]);
    const { thread_id } = openDispute(tools, claim_id, ['src/auth/login.ts']);

    // 4 alternating proposals without an accept.
    const m1 = tools.disputePostMove({
      space_id: SPACE,
      principal: 'bob',
      actor: 'bob',
      delegation: 'bob->bob',
      thread_id,
      move_type: 'propose_release_subset',
      payload: { paths: ['src/auth/login.ts'] }
    });
    if (!m1.ok) throw new Error('m1 failed');
    const m2 = tools.disputePostMove({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      thread_id,
      move_type: 'reject',
      payload: { reason: 'busy' },
      target_proposal_id: m1.data.move_id
    });
    if (!m2.ok) throw new Error('m2 failed');
    const m3 = tools.disputePostMove({
      space_id: SPACE,
      principal: 'bob',
      actor: 'bob',
      delegation: 'bob->bob',
      thread_id,
      move_type: 'propose_release_subset',
      payload: { paths: ['src/auth/login.ts'] }
    });
    if (!m3.ok) throw new Error(`m3 failed: ${JSON.stringify(m3)}`);
    const m4 = tools.disputePostMove({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      thread_id,
      move_type: 'reject',
      payload: { reason: 'too_costly' },
      target_proposal_id: m3.data.move_id
    });
    if (!m4.ok) throw new Error('m4 failed');
    // After m4, turn_count is 4 — hit `turns` cap.
    expect(m4.data.status).toBe('terminated');
    expect(m4.data.outcome).toBe('skip');

    const dispute = db
      .query('SELECT termination_reason FROM disputes WHERE thread_id = ?1')
      .get(thread_id) as { termination_reason: string };
    expect(dispute.termination_reason).toBe('turns');
  });

  it('wallclock termination — older opened_at + new move past 5min mark', () => {
    const { db, tools } = setup();
    const { claim_id } = aliceClaims(tools, ['src/auth/login.ts']);
    const { thread_id } = openDispute(tools, claim_id, ['src/auth/login.ts']);

    // Backdate the dispute so the wallclock check fires.
    db.prepare(
      `UPDATE disputes SET opened_at = datetime('now', '-10 minutes')
        WHERE thread_id = ?1`
    ).run(thread_id);

    const r = tools.disputePostMove({
      space_id: SPACE,
      principal: 'bob',
      actor: 'bob',
      delegation: 'bob->bob',
      thread_id,
      move_type: 'propose_release_subset',
      payload: { paths: ['src/auth/login.ts'] }
    });
    if (!r.ok) throw new Error('move failed');
    // Termination kicks in BEFORE applying the move (auto-check).
    expect(r.ok).toBe(true);

    const dispute = db
      .query(
        'SELECT status, termination_reason FROM disputes WHERE thread_id = ?1'
      )
      .get(thread_id) as { status: string; termination_reason: string };
    expect(dispute.status).toBe('terminated');
    expect(dispute.termination_reason).toBe('wallclock');
  });

  it('user_override via end_dispute(accept) applies the latest open proposal', () => {
    const { db, tools } = setup();
    const { claim_id } = aliceClaims(tools, [
      'src/auth/login.ts',
      'src/auth/middleware.ts'
    ]);
    const { thread_id } = openDispute(tools, claim_id, ['src/auth/login.ts']);

    const m1 = tools.disputePostMove({
      space_id: SPACE,
      principal: 'bob',
      actor: 'bob',
      delegation: 'bob->bob',
      thread_id,
      move_type: 'propose_release_subset',
      payload: { paths: ['src/auth/login.ts'] }
    });
    if (!m1.ok) throw new Error('m1 failed');

    // The user (alice — the target) overrides via /teamem-end-dispute accept.
    const r = tools.endDispute({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      thread_id,
      action: 'accept'
    });
    if (!r.ok) throw new Error('end_dispute(accept) failed');
    expect(r.data.status).toBe('resolved');
    expect(r.data.outcome).toBe('release_subset');

    // The narrow happened — bob now owns login.ts.
    const bobClaim = db
      .query(
        `SELECT 1 FROM claims
          WHERE space_id = ?1 AND principal = 'bob' AND status = 'active'`
      )
      .get(SPACE);
    expect(bobClaim).not.toBeNull();
  });
});

describe('Mode 6.C — invalid moves', () => {
  it('rejects move from a non-party', () => {
    const { tools, db } = setup();
    db.exec(
      `INSERT INTO members (id, space_id, name, joined_at, is_creator, coord_pref)
         VALUES ('m-carol', '${SPACE}', 'carol', '2026-04-03T00:00:00.000Z', 0, 'auto-discuss')`
    );
    const { claim_id } = aliceClaims(tools, ['src/auth/login.ts']);
    const { thread_id } = openDispute(tools, claim_id, ['src/auth/login.ts']);

    const r = tools.disputePostMove({
      space_id: SPACE,
      principal: 'carol',
      actor: 'carol',
      delegation: 'carol->carol',
      thread_id,
      move_type: 'propose_release_subset',
      payload: { paths: ['src/auth/login.ts'] }
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('not_dispute_party');
  });

  it('rejects same-side-twice', () => {
    const { tools } = setup();
    const { claim_id } = aliceClaims(tools, ['src/auth/login.ts']);
    const { thread_id } = openDispute(tools, claim_id, ['src/auth/login.ts']);

    const m1 = tools.disputePostMove({
      space_id: SPACE,
      principal: 'bob',
      actor: 'bob',
      delegation: 'bob->bob',
      thread_id,
      move_type: 'propose_release_subset',
      payload: { paths: ['src/auth/login.ts'] }
    });
    if (!m1.ok) throw new Error('m1 failed');

    const m2 = tools.disputePostMove({
      space_id: SPACE,
      principal: 'bob',
      actor: 'bob',
      delegation: 'bob->bob',
      thread_id,
      move_type: 'propose_release_subset',
      payload: { paths: ['src/auth/login.ts'] }
    });
    expect(m2.ok).toBe(false);
    if (!m2.ok) expect(JSON.stringify(m2.error)).toMatch(/same_side_twice/);
  });
});

describe('Mode 6.C — config validation', () => {
  it('updateDisputeTerminations rejects empty array', () => {
    const { tools } = setup();
    const r = tools.updateDisputeTerminations({
      space_id: SPACE,
      principal: 'alice',
      enabled: []
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalid_enabled');
  });

  it('updateDisputeTerminations accepts a non-empty subset', () => {
    const { tools } = setup();
    const r = tools.updateDisputeTerminations({
      space_id: SPACE,
      principal: 'alice',
      enabled: ['turns', 'wallclock']
    });
    if (!r.ok) throw new Error(`update failed: ${JSON.stringify(r)}`);
    expect(r.data.enabled).toEqual(['turns', 'wallclock']);
  });

  it('updateDisputeTerminations rejects non-creator', () => {
    const { tools } = setup();
    const r = tools.updateDisputeTerminations({
      space_id: SPACE,
      principal: 'bob',
      enabled: ['turns']
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('not_creator');
  });
});
