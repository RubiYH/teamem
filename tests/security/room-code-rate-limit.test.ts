import {
  describe,
  expect,
  it,
  beforeEach,
  beforeAll,
  afterAll
} from 'bun:test';
import { setupAuthApp } from '../integration/auth/helpers.js';
import { resetRateLimitBuckets } from '../../src/server/rate-limit.js';

// This suite simulates a proxy-trusted deployment so X-Forwarded-For values
// drive per-IP bucketing. Production server defaults to ignoring forwarded
// headers (security review P1#2); operators behind Caddy/nginx/Fly.io etc.
// must set TEAMEM_TRUST_PROXY=1 to opt in.
const ORIG_TRUST_PROXY = process.env.TEAMEM_TRUST_PROXY;
beforeAll(() => {
  process.env.TEAMEM_TRUST_PROXY = '1';
});
afterAll(() => {
  if (ORIG_TRUST_PROXY === undefined) delete process.env.TEAMEM_TRUST_PROXY;
  else process.env.TEAMEM_TRUST_PROXY = ORIG_TRUST_PROXY;
});

async function post(
  app: ReturnType<typeof setupAuthApp>['app'],
  path: string,
  body: unknown,
  ip = '1.2.3.4'
) {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
    body: JSON.stringify(body)
  });
}

async function createSpaceAndGetCode(
  app: ReturnType<typeof setupAuthApp>['app']
): Promise<string> {
  const res = await post(app, '/spaces', { member_name: 'creator' }, '9.9.9.9');
  const body = (await res.json()) as { room_code: string };
  return body.room_code;
}

describe('AC18 — rate limit on /spaces/join (10/min per IP)', () => {
  beforeEach(() => {
    resetRateLimitBuckets();
  });

  it('allows 10 join attempts and blocks the 11th with 429 rate_limited + Retry-After', async () => {
    const { app } = setupAuthApp();
    const roomCode = await createSpaceAndGetCode(app);

    // First 10 attempts: some succeed (first join), rest fail with invalid name or 409,
    // but rate limit should not kick in yet
    for (let i = 0; i < 10; i++) {
      const res = await post(
        app,
        '/spaces/join',
        {
          room_code: roomCode,
          member_name: `attacker-${i}`
        },
        '1.2.3.4'
      );
      // Should not be 429
      expect(res.status).not.toBe(429);
    }

    // 11th attempt must be 429 with Retry-After
    const res = await post(
      app,
      '/spaces/join',
      {
        room_code: roomCode,
        member_name: 'attacker-10'
      },
      '1.2.3.4'
    );
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('rate_limited');
    const retryAfter = res.headers.get('Retry-After');
    expect(retryAfter).not.toBeNull();
    const retrySec = Number(retryAfter);
    expect(retrySec).toBeGreaterThan(0);
    // 60-second window; Retry-After should be ≤ 60 seconds
    expect(retrySec).toBeLessThanOrEqual(60);
  });

  it('per-IP isolation: different IP gets fresh quota after first IP is blocked', async () => {
    const { app } = setupAuthApp();
    const roomCode = await createSpaceAndGetCode(app);

    // Exhaust quota for IP A
    for (let i = 0; i < 11; i++) {
      await post(
        app,
        '/spaces/join',
        { room_code: roomCode, member_name: `ipA-${i}` },
        '10.0.0.1'
      );
    }
    const blockedRes = await post(
      app,
      '/spaces/join',
      { room_code: roomCode, member_name: 'ipA-final' },
      '10.0.0.1'
    );
    expect(blockedRes.status).toBe(429);

    // IP B should still be allowed
    const ipBRes = await post(
      app,
      '/spaces/join',
      { room_code: roomCode, member_name: 'ipB-first' },
      '10.0.0.2'
    );
    expect(ipBRes.status).not.toBe(429);
  });

  it('rate limit on /spaces (create) blocks after threshold', async () => {
    const { app } = setupAuthApp();

    for (let i = 0; i < 10; i++) {
      const res = await post(
        app,
        '/spaces',
        { member_name: `creator-${i}` },
        '5.5.5.5'
      );
      expect(res.status).not.toBe(429);
    }

    const res = await post(
      app,
      '/spaces',
      { member_name: 'creator-overflow' },
      '5.5.5.5'
    );
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('rate_limited');
  });
});
