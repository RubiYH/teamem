import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupAuthApp } from '../auth/helpers.js';

// Regression test for slice #5: locks in that a kicked member's next MCP
// call is rejected by the auth middleware. The relevant invariant lives in
// `src/server/auth.ts:62-66` — the JOIN must include both
// `s.disbanded_at IS NULL` and `m.left_at IS NULL`. Kick flips
// `members.left_at`, so the JOIN must drop the row on the very next request.
//
// The auth middleware returns `401 member_left` (not `403 member_kicked`) —
// kicked and self-left both flip the same `left_at` column, so the auth
// layer cannot distinguish them and emits one canonical reject code.

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

async function bootstrapTwoMembers() {
  const { app, db } = setupAuthApp();
  const createRes = await post(app, '/spaces', { member_name: 'alice' });
  expect(createRes.status).toBe(201);
  const { room_code, jwt: aliceJwt } = (await createRes.json()) as {
    room_code: string;
    jwt: string;
  };

  const joinRes = await post(app, '/spaces/join', {
    room_code,
    member_name: 'bob'
  });
  expect(joinRes.status).toBe(200);
  const { jwt: bobJwt } = (await joinRes.json()) as { jwt: string };

  return { app, db, aliceJwt, bobJwt, roomCode: room_code };
}

describe('kick-takes-effect (regression for auth.ts:62-66 JOIN)', () => {
  it('positive control: bob can call /tools/teamem.get_updates before kick', async () => {
    const { app, bobJwt } = await bootstrapTwoMembers();

    const res = await post(app, '/tools/teamem.get_updates', {}, bobJwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it('after alice kicks bob, bob`s next /tools/* call is rejected', async () => {
    const { app, aliceJwt, bobJwt } = await bootstrapTwoMembers();

    // Sanity: bob works before the kick.
    const before = await post(app, '/tools/teamem.get_updates', {}, bobJwt);
    expect(before.status).toBe(200);

    // Alice kicks bob.
    const kickRes = await post(
      app,
      '/spaces/kick',
      { member_name: 'bob' },
      aliceJwt
    );
    expect(kickRes.status).toBe(200);

    // Bob's next MCP call must be rejected by the auth middleware.
    const after = await post(app, '/tools/teamem.get_updates', {}, bobJwt);
    expect(after.status).toBe(401);
    const body = (await after.json()) as { error: string };
    expect(body.error).toBe('member_left');
  });

  it('rejoin after kick: bob`s new JWT works (left_at flips back to NULL)', async () => {
    const {
      app,
      aliceJwt,
      bobJwt: oldBobJwt,
      roomCode
    } = await bootstrapTwoMembers();

    await post(app, '/spaces/kick', { member_name: 'bob' }, aliceJwt);

    // Old jwt rejected.
    const stale = await post(app, '/tools/teamem.get_updates', {}, oldBobJwt);
    expect(stale.status).toBe(401);

    // Bob rejoins via the room code.
    const rejoinRes = await post(app, '/spaces/join', {
      room_code: roomCode,
      member_name: 'bob'
    });
    expect(rejoinRes.status).toBe(200);
    const { jwt: newBobJwt } = (await rejoinRes.json()) as { jwt: string };

    // New jwt works.
    const after = await post(app, '/tools/teamem.get_updates', {}, newBobJwt);
    expect(after.status).toBe(200);
  });

  it('auth.ts JOIN includes both `s.disbanded_at IS NULL` and `m.left_at IS NULL`', () => {
    // Source-level guard: if a future refactor weakens the JOIN, this
    // assertion fires before any behavioral test masks the regression.
    const authSource = readFileSync(
      join(process.cwd(), 'src/server/auth.ts'),
      'utf-8'
    );

    // Locate the prepared statement that authorizes each request.
    const stmtMatch = authSource.match(
      /db\.prepare\(\s*`([^`]*FROM spaces[^`]*JOIN members[^`]*)`\s*\)/
    );
    expect(stmtMatch).not.toBeNull();
    const sql = stmtMatch![1];

    expect(sql).toContain('s.disbanded_at IS NULL');
    expect(sql).toContain('m.left_at IS NULL');
    expect(sql).toMatch(/JOIN\s+members\s+m\s+ON\s+m\.space_id\s*=\s*s\.id/);
  });

  it('disbanding a space also rejects the kicked member`s old jwt with 410', async () => {
    // Cross-check: the same JOIN guards both flags. If a future change
    // accidentally drops the disbanded check, this catches it.
    const { app, aliceJwt, bobJwt } = await bootstrapTwoMembers();

    const disbandRes = await post(
      app,
      '/spaces/disband',
      { label_confirmation: "alice's space" },
      aliceJwt
    );
    expect(disbandRes.status).toBe(200);

    const after = await post(app, '/tools/teamem.get_updates', {}, bobJwt);
    expect(after.status).toBe(410);
    const body = (await after.json()) as { error: string };
    expect(body.error).toBe('space_disbanded');
  });
});
