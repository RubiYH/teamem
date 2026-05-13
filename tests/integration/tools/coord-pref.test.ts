import { describe, expect, it } from 'bun:test';
import { setupAuthApp } from '../auth/helpers.js';

// Issue #9 — integration coverage for `teamem.update_coord_pref`:
//  - persists to members.coord_pref
//  - reading back via getBriefing.recent_joins reflects the new value
//  - default `auto-skip` applies on member create + join
//  - principal scoping: alice can't change bob's pref

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
  const createRes = await post(app, '/spaces', { member_name: 'alice' });
  const { room_code, jwt: aliceJwt } = (await createRes.json()) as {
    room_code: string;
    jwt: string;
  };
  const joinRes = await post(app, '/spaces/join', {
    room_code,
    member_name: 'bob'
  });
  const { jwt: bobJwt } = (await joinRes.json()) as { jwt: string };
  return { app, db, aliceJwt, bobJwt };
}

type RecentJoin = {
  member_name: string;
  joined_at: string;
  is_creator: boolean;
  coord_pref: 'auto-skip' | 'auto-discuss';
};

async function fetchBriefingJoins(
  app: ReturnType<typeof setupAuthApp>['app'],
  jwt: string
): Promise<RecentJoin[]> {
  const res = await post(app, '/tools/teamem.get_briefing', {}, jwt);
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    ok: boolean;
    data: { recent_joins: RecentJoin[] };
  };
  expect(body.ok).toBe(true);
  return body.data.recent_joins;
}

describe('teamem.update_coord_pref — persistence', () => {
  it('default coord_pref is auto-skip for both creator and joiner', async () => {
    const { app, aliceJwt } = await bootstrap();
    const joins = await fetchBriefingJoins(app, aliceJwt);
    expect(joins.length).toBeGreaterThanOrEqual(2);
    for (const j of joins) {
      expect(j.coord_pref).toBe('auto-skip');
    }
  });

  it('updates own row and getBriefing reflects the new value', async () => {
    const { app, aliceJwt, bobJwt } = await bootstrap();

    const res = await post(
      app,
      '/tools/teamem.update_coord_pref',
      { value: 'auto-discuss' },
      bobJwt
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      data: { coord_pref: string };
    };
    expect(body.ok).toBe(true);
    expect(body.data.coord_pref).toBe('auto-discuss');

    const joins = await fetchBriefingJoins(app, aliceJwt);
    const bobRow = joins.find((j) => j.member_name === 'bob');
    expect(bobRow).toBeDefined();
    expect(bobRow!.coord_pref).toBe('auto-discuss');

    // Alice's row remains the default — update_coord_pref is principal-scoped.
    const aliceRow = joins.find((j) => j.member_name === 'alice');
    expect(aliceRow!.coord_pref).toBe('auto-skip');
  });

  it('accepts both legal values', async () => {
    const { app, aliceJwt } = await bootstrap();
    for (const value of ['auto-skip', 'auto-discuss'] as const) {
      const res = await post(
        app,
        '/tools/teamem.update_coord_pref',
        { value },
        aliceJwt
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        ok: boolean;
        data: { coord_pref: string };
      };
      expect(body.data.coord_pref).toBe(value);
    }
    // Final state is auto-discuss.
    const joins = await fetchBriefingJoins(app, aliceJwt);
    const alice = joins.find((j) => j.member_name === 'alice')!;
    expect(alice.coord_pref).toBe('auto-discuss');
  });

  it('rejects bogus values with invalid_coord_pref', async () => {
    const { app, aliceJwt } = await bootstrap();
    const res = await post(
      app,
      '/tools/teamem.update_coord_pref',
      { value: 'AUTO-SKIP' },
      aliceJwt
    );
    expect(res.status).toBe(200); // tool-level error returns 200 with ok:false
    const body = (await res.json()) as {
      ok: boolean;
      error?: { code: string };
    };
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe('invalid_coord_pref');
  });

  it('rejects legacy ask-claimant as a selectable value', async () => {
    const { app, aliceJwt } = await bootstrap();
    const res = await post(
      app,
      '/tools/teamem.update_coord_pref',
      { value: 'ask-claimant' },
      aliceJwt
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      error?: { code: string; message: string };
    };
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe('invalid_coord_pref');
    expect(body.error?.message).toContain('auto-skip | auto-discuss');
  });

  it('rejects missing value', async () => {
    const { app, aliceJwt } = await bootstrap();
    const res = await post(
      app,
      '/tools/teamem.update_coord_pref',
      {},
      aliceJwt
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      error?: { code: string };
    };
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe('invalid_coord_pref');
  });

  it('persists at the SQL level (defense against silent no-op)', async () => {
    const { app, db, aliceJwt } = await bootstrap();
    await post(
      app,
      '/tools/teamem.update_coord_pref',
      { value: 'auto-discuss' },
      aliceJwt
    );
    const row = db
      .prepare(
        "SELECT coord_pref FROM members WHERE name = 'alice' AND left_at IS NULL LIMIT 1"
      )
      .get() as { coord_pref: string } | null;
    expect(row).not.toBeNull();
    expect(row!.coord_pref).toBe('auto-discuss');
  });

  it('normalizes legacy ask-claimant rows to auto-skip in briefings', async () => {
    const { app, db, aliceJwt } = await bootstrap();
    db.prepare(
      "UPDATE members SET coord_pref = 'ask-claimant' WHERE name = 'bob' AND left_at IS NULL"
    ).run();

    const joins = await fetchBriefingJoins(app, aliceJwt);
    const bob = joins.find((j) => j.member_name === 'bob')!;
    expect(bob.coord_pref).toBe('auto-skip');
  });

  it('attempting scope-in-body injection is blocked by the route layer', async () => {
    // Belt-and-braces: the route's `scope_in_body_unsupported` guard already
    // strips top-level space_id/principal from the body. This test confirms
    // a malicious caller can't override their own principal to mutate
    // someone else's row.
    const { app, bobJwt } = await bootstrap();
    const res = await post(
      app,
      '/tools/teamem.update_coord_pref',
      { value: 'auto-discuss', principal: 'alice' },
      bobJwt
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('scope_in_body_unsupported');
  });
});
