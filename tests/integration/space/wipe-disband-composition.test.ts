import { describe, expect, it } from 'bun:test';
import { setupAuthApp } from '../auth/helpers.js';

// Slice #7: wipe × disband composition rules.
//
// Scenarios (spec):
//   1. wipe → disband → restore (within 7d) — tombstones intact, briefing empty.
//   2. wipe → unwipe → disband → restore                — briefing populated.
//   3. disband-then-wipe — auth gate already 410s before wipe runs.
//   4. hard-wipe → disband → restore                    — events gone, briefing empty.

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

async function bootstrap() {
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

async function seedClaim(
  app: ReturnType<typeof setupAuthApp>['app'],
  jwt: string
) {
  const res = await post(
    app,
    '/tools/teamem.claim_scope',
    {
      actor: 'alice/agent',
      delegation: 'alice->agent',
      scope: { paths: ['src/foo.ts'] }
    },
    jwt
  );
  expect(res.status).toBe(200);
}

describe('wipe × disband composition rules', () => {
  it('1. wipe → disband → restore — tombstones intact, briefing empty', async () => {
    const { app, aliceJwt, label } = await bootstrap();
    await seedClaim(app, aliceJwt);

    // Soft-wipe.
    const wipe = await post(app, '/spaces/wipe', {}, aliceJwt);
    expect(wipe.status).toBe(200);

    // Disband (soft, slice #6).
    const disband = await post(
      app,
      '/spaces/disband',
      { label_confirmation: label },
      aliceJwt
    );
    expect(disband.status).toBe(200);

    // Auth on the now-disbanded space rejects with 410.
    const blockedBriefing = await post(
      app,
      '/tools/teamem.get_briefing',
      {},
      aliceJwt
    );
    expect(blockedBriefing.status).toBe(410);

    // Restore — bypasses auth gate (verifies JWT directly + is_creator).
    const restore = await post(app, '/spaces/restore', {}, aliceJwt);
    expect(restore.status).toBe(200);

    // Briefing post-restore is empty (tombstones survived disband).
    const briefing = await post(
      app,
      '/tools/teamem.get_briefing',
      {},
      aliceJwt
    );
    expect(briefing.status).toBe(200);
    const body = (await briefing.json()) as {
      data: { active_claims: unknown[]; recent_decisions: unknown[] };
    };
    expect(body.data.active_claims).toEqual([]);
  });

  it('2. wipe → unwipe → disband → restore — briefing populated', async () => {
    const { app, aliceJwt, label } = await bootstrap();
    await seedClaim(app, aliceJwt);

    await post(app, '/spaces/wipe', {}, aliceJwt);
    await post(app, '/spaces/unwipe', {}, aliceJwt);

    // Disband + restore (within grace).
    const disband = await post(
      app,
      '/spaces/disband',
      { label_confirmation: label },
      aliceJwt
    );
    expect(disband.status).toBe(200);
    const restore = await post(app, '/spaces/restore', {}, aliceJwt);
    expect(restore.status).toBe(200);

    // Briefing populated: tombstones cleared by unwipe, disband doesn't
    // tombstone projection rows, so the seed claim re-surfaces.
    const briefing = await post(
      app,
      '/tools/teamem.get_briefing',
      {},
      aliceJwt
    );
    const body = (await briefing.json()) as {
      data: { active_claims: unknown[] };
    };
    expect(body.data.active_claims.length).toBeGreaterThan(0);
  });

  it('3. disband-then-wipe — auth gate rejects wipe with 410', async () => {
    const { app, aliceJwt, label } = await bootstrap();
    await seedClaim(app, aliceJwt);

    const disband = await post(
      app,
      '/spaces/disband',
      { label_confirmation: label },
      aliceJwt
    );
    expect(disband.status).toBe(200);

    // Wipe call on the disbanded space — auth gate (requireCreator JOIN
    // filters `s.disbanded_at IS NULL`) returns 410 before wipeSpace runs.
    const wipe = await post(app, '/spaces/wipe', {}, aliceJwt);
    expect(wipe.status).toBe(410);
    const body = (await wipe.json()) as { error: string };
    expect(body.error).toBe('space_disbanded');

    // Sanity: restore the space, briefing still has the seed claim.
    await post(app, '/spaces/restore', {}, aliceJwt);
    const briefing = await post(
      app,
      '/tools/teamem.get_briefing',
      {},
      aliceJwt
    );
    const briefingBody = (await briefing.json()) as {
      data: { active_claims: unknown[] };
    };
    expect(briefingBody.data.active_claims.length).toBeGreaterThan(0);
  });

  it('4. hard-wipe → disband → restore — events gone, briefing empty', async () => {
    const { app, db, aliceJwt, spaceId, label } = await bootstrap();
    await seedClaim(app, aliceJwt);

    // Hard wipe.
    const hard = await post(
      app,
      '/spaces/wipe',
      { hard: true, label_confirmation: label },
      aliceJwt
    );
    expect(hard.status).toBe(200);

    // Disband.
    const disband = await post(
      app,
      '/spaces/disband',
      { label_confirmation: label },
      aliceJwt
    );
    expect(disband.status).toBe(200);

    // Restore.
    const restore = await post(app, '/spaces/restore', {}, aliceJwt);
    expect(restore.status).toBe(200);

    // Events table is empty for this space.
    const evCount = (
      db
        .query('SELECT COUNT(*) AS n FROM events WHERE space_id = ?1')
        .get(spaceId) as { n: number }
    ).n;
    expect(evCount).toBe(0);

    // Briefing is empty but well-formed.
    const briefing = await post(
      app,
      '/tools/teamem.get_briefing',
      {},
      aliceJwt
    );
    expect(briefing.status).toBe(200);
    const body = (await briefing.json()) as {
      data: { active_claims: unknown[]; recent_decisions: unknown[] };
    };
    expect(body.data.active_claims).toEqual([]);
    expect(body.data.recent_decisions).toEqual([]);
  });
});
