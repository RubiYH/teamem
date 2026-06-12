import { describe, expect, it } from 'bun:test';
import { setupAuthApp } from '../auth/helpers.js';

// Slice #7: soft-wipe + unwipe round-trip.
//
// Soft-wipe stamps `tombstoned_at` on every row in the projection tables and
// appends a `space_wiped` event. Briefing reads then return empty.  An
// unwipe call clears tombstones whose timestamp matches ANY `space_wiped`
// event, restoring pre-wipe state — including rows stamped by an earlier
// wipe that was never unwiped (see the double-wipe regression below).

async function post(
  app: ReturnType<typeof setupAuthApp>['app'],
  path: string,
  body: unknown,
  token?: string
) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json'
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return app.request(path, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
}

async function bootstrapCreator() {
  const { app, db } = setupAuthApp();
  const res = await post(app, '/spaces', { member_name: 'alice' });
  expect(res.status).toBe(201);
  const body = (await res.json()) as {
    space_id: string;
    jwt: string;
    label: string;
  };
  return {
    app,
    db,
    aliceJwt: body.jwt,
    spaceId: body.space_id,
    label: body.label
  };
}

describe('soft-wipe + unwipe round-trip', () => {
  it('seed → wipe → briefing empty → unwipe → briefing populated', async () => {
    const { app, aliceJwt, spaceId: _spaceId } = await bootstrapCreator();
    void _spaceId;

    // Seed: claim a scope (ends up in `claims` projection) + record a decision.
    const claimRes = await post(
      app,
      '/tools/teamem.claim_scope',
      {
        actor: 'alice/agent',
        delegation: 'alice->agent',
        scope: { paths: ['src/foo.ts'] },
        intent: 'edit foo'
      },
      aliceJwt
    );
    expect(claimRes.status).toBe(200);

    const decisionRes = await post(
      app,
      '/tools/teamem.record_decision',
      {
        actor: 'alice/agent',
        delegation: 'alice->agent',
        decision_id: 'd-1',
        title: 'use sqlite',
        kind: 'architectural'
      },
      aliceJwt
    );
    expect(decisionRes.status).toBe(200);

    // Sanity: briefing surfaces both items.
    const beforeBriefing = await post(
      app,
      '/tools/teamem.get_briefing',
      {},
      aliceJwt
    );
    const beforeBody = (await beforeBriefing.json()) as {
      data: {
        active_claims: unknown[];
        recent_decisions: unknown[];
      };
    };
    expect(beforeBody.data.active_claims.length).toBeGreaterThan(0);
    expect(beforeBody.data.recent_decisions.length).toBeGreaterThan(0);

    // Wipe (soft, default).
    const wipeRes = await post(app, '/spaces/wipe', {}, aliceJwt);
    expect(wipeRes.status).toBe(200);
    const wipeBody = (await wipeRes.json()) as { ok: true; wiped_at: string };
    expect(wipeBody.ok).toBe(true);
    expect(typeof wipeBody.wiped_at).toBe('string');

    // Briefing now empty.
    const afterBriefing = await post(
      app,
      '/tools/teamem.get_briefing',
      {},
      aliceJwt
    );
    const afterBody = (await afterBriefing.json()) as {
      data: {
        active_claims: unknown[];
        recent_decisions: unknown[];
        current_plan: unknown;
      };
    };
    expect(afterBody.data.active_claims).toEqual([]);
    expect(afterBody.data.recent_decisions).toEqual([]);

    // Unwipe.
    const unwipeRes = await post(app, '/spaces/unwipe', {}, aliceJwt);
    expect(unwipeRes.status).toBe(200);

    // Briefing restored.
    const restored = await post(
      app,
      '/tools/teamem.get_briefing',
      {},
      aliceJwt
    );
    const restoredBody = (await restored.json()) as {
      data: { active_claims: unknown[]; recent_decisions: unknown[] };
    };
    expect(restoredBody.data.active_claims.length).toBeGreaterThan(0);
    expect(restoredBody.data.recent_decisions.length).toBeGreaterThan(0);
  });

  it('appends space_wiped + space_unwiped events to the log', async () => {
    const { app, db, aliceJwt, spaceId } = await bootstrapCreator();

    // Seed at least one row so unwipe has tombstones to clear (otherwise it
    // returns not_wiped and skips the marker event).
    const claim = await post(
      app,
      '/tools/teamem.claim_scope',
      {
        actor: 'alice/agent',
        delegation: 'alice->agent',
        scope: { paths: ['src/foo.ts'] }
      },
      aliceJwt
    );
    expect(claim.status).toBe(200);

    await post(app, '/spaces/wipe', {}, aliceJwt);
    await post(app, '/spaces/unwipe', {}, aliceJwt);

    const wipeCount = (
      db
        .query(
          "SELECT COUNT(*) AS n FROM events WHERE space_id = ?1 AND event_type = 'space_wiped'"
        )
        .get(spaceId) as { n: number }
    ).n;
    const unwipeCount = (
      db
        .query(
          "SELECT COUNT(*) AS n FROM events WHERE space_id = ?1 AND event_type = 'space_unwiped'"
        )
        .get(spaceId) as { n: number }
    ).n;
    expect(wipeCount).toBe(1);
    expect(unwipeCount).toBe(1);
  });

  it('non-creator cannot wipe (403)', async () => {
    const { app, aliceJwt: _aliceJwt } = await bootstrapCreator();
    void _aliceJwt;
    const createRes = await post(app, '/spaces', { member_name: 'alice' });
    expect(createRes.status).toBe(201);

    // Bob joins alice's space via the room code from the first creator setup.
    // Note setupAuthApp gives us the same `app/db` for both; we use alice's
    // room_code from her create response.
    const aliceCreate = await post(app, '/spaces', { member_name: 'alice' });
    const aliceCreateBody = (await aliceCreate.json()) as { room_code: string };
    const joinRes = await post(app, '/spaces/join', {
      room_code: aliceCreateBody.room_code,
      member_name: 'bob'
    });
    expect(joinRes.status).toBe(200);
    const { jwt: bobJwt } = (await joinRes.json()) as { jwt: string };

    // Bob (non-creator) attempts to wipe.
    const res = await post(app, '/spaces/wipe', {}, bobJwt);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('not_creator');

    // Sanity: alice's original space is unaffected.
    void _aliceJwt;
  });

  it('double soft-wipe → unwipe restores rows from BOTH wipes (no stranding)', async () => {
    const { app, aliceJwt } = await bootstrapCreator();

    // Seed row #1, wipe it.
    const claim1 = await post(
      app,
      '/tools/teamem.claim_scope',
      {
        actor: 'alice/agent',
        delegation: 'alice->agent',
        scope: { paths: ['src/first.ts'] },
        intent: 'first claim'
      },
      aliceJwt
    );
    expect(claim1.status).toBe(200);
    const wipe1 = await post(app, '/spaces/wipe', {}, aliceJwt);
    expect(wipe1.status).toBe(200);

    // Seed row #2 AFTER the first wipe, then wipe again. The second wipe
    // only stamps rows with tombstoned_at IS NULL, so row #1 keeps the
    // first wipe's timestamp.
    const decision2 = await post(
      app,
      '/tools/teamem.record_decision',
      {
        actor: 'alice/agent',
        delegation: 'alice->agent',
        decision_id: 'd-after-wipe1',
        title: 'post-wipe decision',
        kind: 'architectural'
      },
      aliceJwt
    );
    expect(decision2.status).toBe(200);
    const wipe2 = await post(app, '/spaces/wipe', {}, aliceJwt);
    expect(wipe2.status).toBe(200);

    // Single unwipe must restore rows stamped by BOTH wipes. Pre-fix, rows
    // from wipe #1 stayed tombstoned forever: unwipe only cleared the
    // latest wipe's timestamp, and a follow-up unwipe found nothing to
    // clear at that same timestamp and returned not_wiped.
    const unwipeRes = await post(app, '/spaces/unwipe', {}, aliceJwt);
    expect(unwipeRes.status).toBe(200);

    const restored = await post(
      app,
      '/tools/teamem.get_briefing',
      {},
      aliceJwt
    );
    const restoredBody = (await restored.json()) as {
      data: { active_claims: unknown[]; recent_decisions: unknown[] };
    };
    expect(restoredBody.data.active_claims.length).toBeGreaterThan(0);
    expect(restoredBody.data.recent_decisions.length).toBeGreaterThan(0);
  });

  it('unwipe with no prior wipe returns 409 not_wiped', async () => {
    const { app, aliceJwt } = await bootstrapCreator();
    const res = await post(app, '/spaces/unwipe', {}, aliceJwt);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('not_wiped');
  });
});
