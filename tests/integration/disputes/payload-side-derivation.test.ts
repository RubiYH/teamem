/**
 * Codex F22 regression — every dispute event payload (both
 * `dispute_opened` AND each `discussion_posted` move event) must carry
 * `opened_by` and `target_principal` so the auto-negotiator agent can
 * derive its `side` without re-querying the server.
 *
 * Pre-#24 only `dispute_opened` had `target_principal` (no `opened_by`)
 * and the move event had neither. The agent's prompt told it to read
 * `payload.opened_by` / `payload.target_principal`; lookup returned
 * undefined; the emit-nothing guard fired; Mode 6.C stalled after the
 * first move.
 *
 * This test drives the REAL server tools (`tools.openDispute`,
 * `tools.disputePostMove`) against an in-memory SQLite, reads the
 * emitted events, and asserts:
 *
 *   1. `dispute_opened` payload carries both fields.
 *   2. Every `discussion_posted` event with `payload.dispute_move`
 *      carries both fields.
 *   3. The shared `deriveDisputeSide(whoami, payload)` helper returns
 *      a non-null side for both opener (bob) and target (alice) when
 *      called against real production payloads.
 *
 * Runs as a real-server integration test, NOT a stub-event test, per
 * the F21/F22 process note in `tests/helpers/marketplace-env.ts`.
 */
import { describe, expect, it } from 'bun:test';
import { runAllMigrations } from '../../helpers/migrations.js';
import { createSqliteClient } from '../../../src/infra/db/sqlite-client.js';
import { SqliteEventStore } from '../../../src/infra/db/sqlite-event-store.js';
import { createTeamemTools } from '../../../src/server/tools/index.js';
import { deriveDisputeSide } from '../../../src/domain/disputes/derive-side.js';

const SPACE = 'space-f22';

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

describe('F22 — dispute event payloads carry opened_by + target_principal', () => {
  it('dispute_opened payload carries opened_by AND target_principal', () => {
    const { tools } = setup();
    const claim = tools.claimScope({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      scope: { paths: ['src/x.ts'] }
    });
    if (!claim.ok) throw new Error('claim_scope failed');

    const opened = tools.openDispute({
      space_id: SPACE,
      principal: 'bob',
      actor: 'bob',
      delegation: 'bob->bob',
      blocking_claim_id: claim.data.claim_id,
      paths: ['src/x.ts'],
      intent: 'F22 payload test'
    });
    if (!opened.ok) throw new Error('open_dispute failed');

    const updates = tools.getUpdates({ space_id: SPACE, actor: 'alice' });
    if (!updates.ok) throw new Error('get_updates failed');

    const openedEvent = updates.data.events.find(
      (e) => e.event_type === 'dispute_opened'
    );
    expect(openedEvent).toBeDefined();
    const payload = openedEvent!.payload as Record<string, unknown>;
    expect(payload.opened_by).toBe('bob');
    expect(payload.target_principal).toBe('alice');
  });

  it('discussion_posted move event payload carries opened_by AND target_principal', () => {
    const { tools } = setup();
    const claim = tools.claimScope({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      scope: { paths: ['src/x.ts', 'src/y.ts'] }
    });
    if (!claim.ok) throw new Error('claim_scope failed');

    const opened = tools.openDispute({
      space_id: SPACE,
      principal: 'bob',
      actor: 'bob',
      delegation: 'bob->bob',
      blocking_claim_id: claim.data.claim_id,
      paths: ['src/x.ts'],
      intent: 'F22 move payload test'
    });
    if (!opened.ok) throw new Error('open_dispute failed');

    const move = tools.disputePostMove({
      space_id: SPACE,
      principal: 'bob',
      actor: 'bob',
      delegation: 'bob->bob',
      thread_id: opened.data.thread_id,
      move_type: 'propose_release_subset',
      payload: { paths: ['src/x.ts'] }
    });
    if (!move.ok) throw new Error('dispute_post_move failed');

    const updates = tools.getUpdates({ space_id: SPACE, actor: 'alice' });
    if (!updates.ok) throw new Error('get_updates failed');

    // Filter to dispute-move events specifically (the seed
    // discussion_posted from openDispute carries dispute_marker, not
    // dispute_move; we only care about real moves here).
    const moveEvents = updates.data.events.filter(
      (e) =>
        e.event_type === 'discussion_posted' &&
        e.payload != null &&
        typeof e.payload === 'object' &&
        (e.payload as Record<string, unknown>).dispute_move != null
    );
    expect(moveEvents.length).toBeGreaterThanOrEqual(1);
    for (const ev of moveEvents) {
      const p = ev.payload as Record<string, unknown>;
      expect(p.opened_by).toBe('bob');
      expect(p.target_principal).toBe('alice');
    }
  });

  it('deriveDisputeSide returns "opener" for opener and "target" for target on real dispute_opened payload', () => {
    const { tools } = setup();
    const claim = tools.claimScope({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      scope: { paths: ['src/x.ts'] }
    });
    if (!claim.ok) throw new Error('claim_scope failed');

    const opened = tools.openDispute({
      space_id: SPACE,
      principal: 'bob',
      actor: 'bob',
      delegation: 'bob->bob',
      blocking_claim_id: claim.data.claim_id,
      paths: ['src/x.ts'],
      intent: 'F22 derive-side test'
    });
    if (!opened.ok) throw new Error('open_dispute failed');

    const updates = tools.getUpdates({ space_id: SPACE, actor: 'alice' });
    if (!updates.ok) throw new Error('get_updates failed');

    const openedEvent = updates.data.events.find(
      (e) => e.event_type === 'dispute_opened'
    );
    expect(openedEvent).toBeDefined();
    const p = openedEvent!.payload as Record<string, unknown>;

    // Production payload → real side derivation, not a synthesized one.
    expect(deriveDisputeSide('bob', p)).toBe('opener');
    expect(deriveDisputeSide('alice', p)).toBe('target');
    expect(deriveDisputeSide('mallory', p)).toBeNull();
    expect(deriveDisputeSide('', p)).toBeNull();
  });

  it('deriveDisputeSide returns "opener"/"target" on real move payload (the F22 regression case)', () => {
    const { tools } = setup();
    const claim = tools.claimScope({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      scope: { paths: ['src/x.ts', 'src/y.ts'] }
    });
    if (!claim.ok) throw new Error('claim_scope failed');

    const opened = tools.openDispute({
      space_id: SPACE,
      principal: 'bob',
      actor: 'bob',
      delegation: 'bob->bob',
      blocking_claim_id: claim.data.claim_id,
      paths: ['src/x.ts'],
      intent: 'F22 derive on move test'
    });
    if (!opened.ok) throw new Error('open_dispute failed');

    const move = tools.disputePostMove({
      space_id: SPACE,
      principal: 'bob',
      actor: 'bob',
      delegation: 'bob->bob',
      thread_id: opened.data.thread_id,
      move_type: 'propose_release_subset',
      payload: { paths: ['src/x.ts'] }
    });
    if (!move.ok) throw new Error('dispute_post_move failed');

    const updates = tools.getUpdates({ space_id: SPACE, actor: 'alice' });
    if (!updates.ok) throw new Error('get_updates failed');

    const moveEvent = updates.data.events.find(
      (e) =>
        e.event_type === 'discussion_posted' &&
        e.payload != null &&
        typeof e.payload === 'object' &&
        (e.payload as Record<string, unknown>).dispute_move != null
    );
    expect(moveEvent).toBeDefined();
    const p = moveEvent!.payload as Record<string, unknown>;

    // The exact F22 regression case: this lookup returned null pre-#24
    // because the move payload didn't carry these fields. Now both
    // fields are present on every move event.
    expect(deriveDisputeSide('bob', p)).toBe('opener');
    expect(deriveDisputeSide('alice', p)).toBe('target');
    expect(deriveDisputeSide('mallory', p)).toBeNull();
  });
});

describe('F22 — deriveDisputeSide pure-function unit tests', () => {
  it('returns "opener" when whoami matches payload.opened_by', () => {
    expect(
      deriveDisputeSide('bob', { opened_by: 'bob', target_principal: 'alice' })
    ).toBe('opener');
  });
  it('returns "target" when whoami matches payload.target_principal', () => {
    expect(
      deriveDisputeSide('alice', {
        opened_by: 'bob',
        target_principal: 'alice'
      })
    ).toBe('target');
  });
  it('returns null when whoami matches neither', () => {
    expect(
      deriveDisputeSide('mallory', {
        opened_by: 'bob',
        target_principal: 'alice'
      })
    ).toBeNull();
  });
  it('returns null on missing fields', () => {
    expect(deriveDisputeSide('bob', {})).toBeNull();
    expect(deriveDisputeSide('bob', { opened_by: 'bob' })).toBe('opener');
    expect(deriveDisputeSide('alice', { target_principal: 'alice' })).toBe(
      'target'
    );
  });
  it('returns null on null/undefined payload', () => {
    expect(deriveDisputeSide('bob', null)).toBeNull();
    expect(deriveDisputeSide('bob', undefined)).toBeNull();
  });
  it('returns null on empty whoami', () => {
    expect(
      deriveDisputeSide('', { opened_by: 'bob', target_principal: 'alice' })
    ).toBeNull();
  });
  it('returns null on non-string field values', () => {
    expect(
      deriveDisputeSide('bob', {
        opened_by: 42 as unknown as string,
        target_principal: null as unknown as string
      })
    ).toBeNull();
  });
});
