import { describe, expect, it } from 'bun:test';
import { setupAuthApp } from '../auth/helpers.js';

// Slice #7: hard-wipe is irreversible. Events + projection rows are deleted
// for the space, and `unwipeSpace` returns 409 not_wiped because there is
// no `space_wiped` event to anchor against. The `spaces` row + members
// survive — the creator can still log in, and the briefing returns a
// well-formed empty response.

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

describe('hard-wipe (irreversible)', () => {
  it('events + projection rows are deleted; unwipe rejected', async () => {
    const { app, db, aliceJwt, spaceId, label } = await bootstrapCreator();

    // Seed: claim_scope writes one row to claims + one to events.
    const claimRes = await post(
      app,
      '/tools/teamem.claim_scope',
      {
        actor: 'alice/agent',
        delegation: 'alice->agent',
        scope: { paths: ['src/foo.ts'] }
      },
      aliceJwt
    );
    expect(claimRes.status).toBe(200);

    const beforeEvents = (
      db
        .query('SELECT COUNT(*) AS n FROM events WHERE space_id = ?1')
        .get(spaceId) as { n: number }
    ).n;
    const beforeClaims = (
      db
        .query('SELECT COUNT(*) AS n FROM claims WHERE space_id = ?1')
        .get(spaceId) as { n: number }
    ).n;
    expect(beforeEvents).toBeGreaterThan(0);
    expect(beforeClaims).toBeGreaterThan(0);

    // Hard-wipe with the typed-label confirmation.
    const wipeRes = await post(
      app,
      '/spaces/wipe',
      { hard: true, label_confirmation: label },
      aliceJwt
    );
    expect(wipeRes.status).toBe(200);

    // Events + claims gone.
    const afterEvents = (
      db
        .query('SELECT COUNT(*) AS n FROM events WHERE space_id = ?1')
        .get(spaceId) as { n: number }
    ).n;
    const afterClaims = (
      db
        .query('SELECT COUNT(*) AS n FROM claims WHERE space_id = ?1')
        .get(spaceId) as { n: number }
    ).n;
    expect(afterEvents).toBe(0);
    expect(afterClaims).toBe(0);

    // Spaces row + members row survive — the creator can still log in.
    const stillSpace = (
      db
        .query('SELECT COUNT(*) AS n FROM spaces WHERE id = ?1')
        .get(spaceId) as { n: number }
    ).n;
    const stillMembers = (
      db
        .query('SELECT COUNT(*) AS n FROM members WHERE space_id = ?1')
        .get(spaceId) as { n: number }
    ).n;
    expect(stillSpace).toBe(1);
    expect(stillMembers).toBeGreaterThan(0);

    // Briefing returns empty but valid.
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

    // Unwipe rejected — there's no space_wiped event to anchor against.
    const unwipe = await post(app, '/spaces/unwipe', {}, aliceJwt);
    expect(unwipe.status).toBe(409);
    const unwipeBody = (await unwipe.json()) as { error: string };
    expect(unwipeBody.error).toBe('not_wiped');
  });

  it('hard-wipe without label_confirmation returns 400', async () => {
    const { app, aliceJwt } = await bootstrapCreator();
    const res = await post(app, '/spaces/wipe', { hard: true }, aliceJwt);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('label_required');
  });

  it('hard-wipe with mismatched label returns 400', async () => {
    const { app, aliceJwt } = await bootstrapCreator();
    const res = await post(
      app,
      '/spaces/wipe',
      { hard: true, label_confirmation: 'wrong-label' },
      aliceJwt
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('label_mismatch');
  });
});
