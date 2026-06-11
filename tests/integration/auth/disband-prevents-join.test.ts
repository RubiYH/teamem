/**
 * Codex F27 regression — `POST /spaces/join` must reject leaked room
 * codes for tombstoned spaces during the 7-day grace window.
 *
 * Pre-#26 the route was unauthenticated (the room code IS the auth) and
 * `joinSpace` queried `room_codes` without joining `spaces` to check
 * `disbanded_at`. Attack:
 *   1. Alice creates space-A, shares room code with bob.
 *   2. Alice disbands space-A.
 *   3. Mallory has a leaked copy of the room code.
 *   4. Mallory POSTs `/spaces/join` with the leaked code → join succeeds,
 *      member row inserted (disbanded JWT issued is unusable).
 *   5. Alice realises the disband was a mistake, runs `/teamem:restore`
 *      within grace.
 *   6. Restore flips `disbanded_at = NULL`. Mallory's JWT now works.
 *   7. Mallory has full space access.
 *
 * Fix: `joinSpace` joins `spaces` and refuses on `disbanded_at IS NOT NULL`
 * with typed `space_disbanded` → route returns 410. Restore re-enables
 * legitimate joins; mallory's failed join leaves NO member row, so
 * restore doesn't reactivate her.
 */
import { describe, expect, it } from 'bun:test';
import { setupAuthApp } from './helpers.js';

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

describe('F27 — disbanded spaces refuse room-code joins', () => {
  it('the leaked-code-during-grace attack is blocked with 410 space_disbanded', async () => {
    const { app, db } = setupAuthApp();

    // 1. Alice creates space-A.
    const created = await post(app, '/spaces', {
      label: 'team-a',
      member_name: 'alice'
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as {
      space_id: string;
      label: string;
      room_code: string;
      member_id: string;
      jwt: string;
    };
    const { space_id, room_code: leakedCode, jwt: aliceJwt } = createdBody;

    // 2. Alice disbands. Server flips disbanded_at; subsequent JWT-auth
    //    requests for this space return 410.
    const disbandRes = await post(
      app,
      '/spaces/disband',
      { label_confirmation: 'team-a' },
      aliceJwt
    );
    expect(disbandRes.status).toBe(200);

    // 3. Mallory POSTs with the leaked code. Pre-#26 → 200 success.
    //    Post-#26 → 410 space_disbanded.
    const mallRes = await post(app, '/spaces/join', {
      room_code: leakedCode,
      member_name: 'mallory'
    });
    expect(mallRes.status).toBe(410);
    const mallBody = (await mallRes.json()) as { error?: string };
    expect(mallBody.error).toBe('space_disbanded');

    // 4. CRITICAL: mallory's failed join must NOT have left a member row.
    //    If it did, a subsequent /teamem:restore would activate her access.
    const mallRow = db
      .prepare(
        'SELECT id, left_at FROM members WHERE space_id = ? AND name = ?'
      )
      .get(space_id, 'mallory') as {
      id: string;
      left_at: string | null;
    } | null;
    expect(mallRow).toBeNull();

    // 5. Alice restores within grace. The legitimate-rejoin path then
    //    succeeds.
    const restoreRes = await post(app, '/spaces/restore', {}, aliceJwt);
    expect(restoreRes.status).toBe(200);

    // 6. After restore: mallory's earlier join attempt is still gone (no
    //    silent admission via reactivation).
    const mallRowPostRestore = db
      .prepare('SELECT id FROM members WHERE space_id = ? AND name = ?')
      .get(space_id, 'mallory');
    expect(mallRowPostRestore).toBeNull();

    // 7. Legitimate user (bob) can now join via the same (unchanged) code
    //    — restore re-enables joins for the space.
    const bobRes = await post(app, '/spaces/join', {
      room_code: leakedCode,
      member_name: 'bob'
    });
    expect(bobRes.status).toBe(200);
    const bobBody = (await bobRes.json()) as {
      space_id: string;
      member_id: string;
      jwt: string;
    };
    expect(bobBody.space_id).toBe(space_id);

    // Bob's member row exists and is active.
    const bobRow = db
      .prepare(
        'SELECT id, left_at FROM members WHERE space_id = ? AND name = ? AND left_at IS NULL'
      )
      .get(space_id, 'bob') as
      | { id: string; left_at: string | null }
      | undefined;
    expect(bobRow).toBeDefined();
  });

  it('non-disbanded space accepts joins (regression guard for the new code path)', async () => {
    const { app } = setupAuthApp();

    const created = await post(app, '/spaces', {
      label: 'team-active',
      member_name: 'alice'
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { room_code: string };

    const join = await post(app, '/spaces/join', {
      room_code: createdBody.room_code,
      member_name: 'bob'
    });
    expect(join.status).toBe(200);
  });

  it('expired room code on a non-disbanded space still returns 410 code_expired (existing contract)', async () => {
    const { app, db } = setupAuthApp();

    const created = await post(app, '/spaces', {
      label: 'team-stale',
      member_name: 'alice'
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { room_code: string };

    // Force-expire the room code.
    db.prepare(
      "UPDATE room_codes SET expires_at = '2000-01-01T00:00:00.000Z' WHERE code = ?"
    ).run(createdBody.room_code);

    const join = await post(app, '/spaces/join', {
      room_code: createdBody.room_code,
      member_name: 'bob'
    });
    expect(join.status).toBe(410);
    const body = (await join.json()) as { error?: string };
    expect(body.error).toBe('code_expired');
  });

  it('disbanded space with expired code prefers space_disbanded over code_expired (defense in depth)', async () => {
    // Order matters: F27's guard runs BEFORE the expiration check, so
    // even if both fields trip, the response is `space_disbanded`. This
    // pins the order so future refactors don't accidentally surface the
    // expiration leak.
    const { app, db } = setupAuthApp();

    const created = await post(app, '/spaces', {
      label: 'team-exp-disb',
      member_name: 'alice'
    });
    const createdBody = (await created.json()) as {
      space_id: string;
      room_code: string;
      jwt: string;
    };

    // Disband first.
    await post(
      app,
      '/spaces/disband',
      { label_confirmation: 'team-exp-disb' },
      createdBody.jwt
    );

    // Then expire the code.
    db.prepare(
      "UPDATE room_codes SET expires_at = '2000-01-01T00:00:00.000Z' WHERE code = ?"
    ).run(createdBody.room_code);

    const join = await post(app, '/spaces/join', {
      room_code: createdBody.room_code,
      member_name: 'mallory'
    });
    expect(join.status).toBe(410);
    const body = (await join.json()) as { error?: string };
    expect(body.error).toBe('space_disbanded');
  });
});
