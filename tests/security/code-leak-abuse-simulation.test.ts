import { describe, expect, it } from 'bun:test';
import { setupAuthApp } from '../integration/auth/helpers.js';
import { resetRateLimitBuckets } from '../../src/server/rate-limit.js';

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

describe('code-leak abuse simulation — post-leak audit workflow', () => {
  it('leaked room code → mallory joins → creator detects via events → rotate + kick → mallory blocked', async () => {
    resetRateLimitBuckets();
    const { app } = setupAuthApp();

    // 1. Alice creates space
    const createRes = await post(
      app,
      '/spaces',
      { member_name: 'alice', label: 'team-alpha' },
      undefined
    );
    expect(createRes.status).toBe(201);
    const { room_code, jwt: aliceJwt } = (await createRes.json()) as {
      room_code: string;
      jwt: string;
      space_id: string;
    };

    // 2. Bob legitimately joins
    const bobRes = await post(app, '/spaces/join', {
      room_code,
      member_name: 'bob'
    });
    expect(bobRes.status).toBe(200);

    // 3. Room code leaks — Mallory joins
    const malloryRes = await post(app, '/spaces/join', {
      room_code,
      member_name: 'mallory'
    });
    expect(malloryRes.status).toBe(200);
    const { jwt: malloryJwt } = (await malloryRes.json()) as { jwt: string };

    // 4. Mallory can claim scopes (space_id + principal are injected from JWT
    // by the router; sending them in body returns 400 scope_in_body_unsupported).
    const malEventRes = await post(
      app,
      '/tools/teamem.claim_scope',
      {
        actor: 'mallory/agent',
        delegation: 'mallory->agent',
        scope: { paths: ['src/mallory.ts'] },
        intent: 'mallory sneaking in'
      },
      malloryJwt
    );
    expect(malEventRes.status).toBe(200);

    // 5. Alice notices via get_updates (audit: event authored by mallory visible)
    const updatesRes = await post(
      app,
      '/tools/teamem.get_updates',
      {},
      aliceJwt
    );
    expect(updatesRes.status).toBe(200);
    const updates = (await updatesRes.json()) as {
      data: { events: Array<{ principal?: string; actor?: string }> };
    };
    // Events may store principal or actor; check either field
    const malloryEvents = updates.data.events.filter(
      (e) => e.principal === 'mallory' || e.actor?.startsWith('mallory')
    );
    expect(malloryEvents.length).toBeGreaterThan(0);

    // 6. Alice rotates room code (old code immediately invalid)
    const rotateRes = await post(app, '/spaces/rotate-code', {}, aliceJwt);
    expect(rotateRes.status).toBe(200);
    const { room_code: newCode } = (await rotateRes.json()) as {
      room_code: string;
    };
    expect(newCode).not.toBe(room_code);

    // Old code rejected (404 invalid_code per plan §2 req 1)
    const oldCodeRes = await post(app, '/spaces/join', {
      room_code,
      member_name: 'attacker2'
    });
    expect(oldCodeRes.status).toBe(404);

    // 7. Alice kicks mallory
    const kickRes = await post(
      app,
      '/spaces/kick',
      { member_name: 'mallory' },
      aliceJwt
    );
    expect(kickRes.status).toBe(200);

    // 8. Mallory's JWT now returns 401 member_left
    const malloryBlockedRes = await post(
      app,
      '/tools/teamem.get_updates',
      {},
      malloryJwt
    );
    expect(malloryBlockedRes.status).toBe(401);
    const blockedBody = (await malloryBlockedRes.json()) as { error: string };
    expect(blockedBody.error).toBe('member_left');

    // 9. Bob is unaffected
    const { jwt: bobJwt } = (await bobRes.json()) as { jwt: string };
    const bobOkRes = await post(app, '/tools/teamem.get_updates', {}, bobJwt);
    expect(bobOkRes.status).toBe(200);
  });
});
