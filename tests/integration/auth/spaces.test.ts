import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import { setupAuthApp, TEST_JWT_SECRET } from './helpers.js';
import { signJwt } from '../../../src/server/jwt.js';
import {} from '../../../src/server/rate-limit.js';
import { resetAuthCheckLogBuckets } from '../../../src/server/auth.js';

// ── helpers ──────────────────────────────────────────────────────────────────

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

// ── AC2: POST /spaces creates space + returns jwt ────────────────────────────

describe('AC2 — POST /spaces', () => {
  it('creates a space and returns space_id, room_code, jwt', async () => {
    const { app } = setupAuthApp();
    const res = await post(app, '/spaces', { member_name: 'alice' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      space_id: string;
      room_code: string;
      member_id: string;
      jwt: string;
    };
    expect(body.space_id).toBeTruthy();
    expect(body.room_code).toHaveLength(8);
    expect(body.jwt).toBeTruthy();
  });

  it('returned jwt decodes to correct claims (AC9)', async () => {
    const { app } = setupAuthApp();
    const res = await post(app, '/spaces', { member_name: 'alice' });
    const { jwt, space_id } = (await res.json()) as {
      jwt: string;
      space_id: string;
    };

    const parts = jwt.split('.');
    expect(parts).toHaveLength(3);

    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    expect(header.alg).toBe('HS256');
    expect(header.typ).toBe('JWT');

    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    expect(payload.sub).toBe('alice');
    expect(payload.space_id).toBe(space_id);
    expect(payload.iss).toBeTruthy();
    expect(payload.jti).toBeTruthy();
    expect(payload.iat).toBeTruthy();
    const now = Math.floor(Date.now() / 1000);
    expect(payload.exp).toBeGreaterThan(now + 29 * 24 * 3600); // ~30d future
  });

  it('returns 400 when member_name is missing', async () => {
    const { app } = setupAuthApp();
    const res = await post(app, '/spaces', {});
    expect(res.status).toBe(400);
  });
});

// ── AC3: POST /spaces/join ───────────────────────────────────────────────────

describe('AC3 — POST /spaces/join', () => {
  it('joins with valid room_code and returns space_id + jwt', async () => {
    const { app } = setupAuthApp();
    const createRes = await post(app, '/spaces', { member_name: 'alice' });
    const { room_code, space_id } = (await createRes.json()) as {
      room_code: string;
      space_id: string;
    };

    const joinRes = await post(app, '/spaces/join', {
      room_code,
      member_name: 'bob'
    });
    expect(joinRes.status).toBe(200);
    const joinBody = (await joinRes.json()) as {
      space_id: string;
      jwt: string;
    };
    expect(joinBody.space_id).toBe(space_id);
    expect(joinBody.jwt).toBeTruthy();
  });

  it('returns 404 invalid_code for unknown code', async () => {
    const { app } = setupAuthApp();
    const res = await post(app, '/spaces/join', {
      room_code: 'BADCODE1',
      member_name: 'bob'
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_code');
  });

  it('returns 410 code_expired for expired code', async () => {
    const { app, db } = setupAuthApp();
    const createRes = await post(app, '/spaces', { member_name: 'alice' });
    const { room_code } = (await createRes.json()) as { room_code: string };

    // Expire the code
    db.prepare(
      `UPDATE room_codes SET expires_at = datetime('now', '-1 second') WHERE code = ?`
    ).run(room_code);

    const joinRes = await post(app, '/spaces/join', {
      room_code,
      member_name: 'bob'
    });
    expect(joinRes.status).toBe(410);
    expect(((await joinRes.json()) as { error: string }).error).toBe(
      'code_expired'
    );
  });

  it('returns 409 name_taken for duplicate active member name', async () => {
    const { app } = setupAuthApp();
    const createRes = await post(app, '/spaces', { member_name: 'alice' });
    const { room_code } = (await createRes.json()) as { room_code: string };

    const joinRes = await post(app, '/spaces/join', {
      room_code,
      member_name: 'alice'
    });
    expect(joinRes.status).toBe(409);
    expect(((await joinRes.json()) as { error: string }).error).toBe(
      'name_taken'
    );
  });
});

// ── AC4: POST /spaces/rotate-code ────────────────────────────────────────────

describe('AC4 — POST /spaces/rotate-code', () => {
  it('rotates code and old code is rejected', async () => {
    const { app } = setupAuthApp();
    const createRes = await post(app, '/spaces', { member_name: 'alice' });
    const { room_code: oldCode, jwt } = (await createRes.json()) as {
      room_code: string;
      jwt: string;
    };

    const rotateRes = await post(app, '/spaces/rotate-code', {}, jwt);
    expect(rotateRes.status).toBe(200);
    const rotateBody = (await rotateRes.json()) as {
      room_code: string;
      rotated_at: string;
    };
    expect(rotateBody.room_code).not.toBe(oldCode);
    expect(rotateBody.room_code).toHaveLength(8);
    expect(typeof rotateBody.rotated_at).toBe('string');
    expect(new Date(rotateBody.rotated_at).toString()).not.toBe('Invalid Date');

    // Old code rejected (404 invalid_code per plan §2 req 1)
    const joinOld = await post(app, '/spaces/join', {
      room_code: oldCode,
      member_name: 'bob'
    });
    expect(joinOld.status).toBe(404);
    expect(((await joinOld.json()) as { error: string }).error).toBe(
      'invalid_code'
    );

    // New code works
    const joinNew = await post(app, '/spaces/join', {
      room_code: rotateBody.room_code,
      member_name: 'bob'
    });
    expect(joinNew.status).toBe(200);
  });

  it('non-creator member cannot rotate (403 not_creator)', async () => {
    const { app } = setupAuthApp();
    const createRes = await post(app, '/spaces', { member_name: 'alice' });
    const { room_code } = (await createRes.json()) as { room_code: string };

    const joinRes = await post(app, '/spaces/join', {
      room_code,
      member_name: 'bob'
    });
    expect(joinRes.status).toBe(200);
    const { jwt: bobJwt } = (await joinRes.json()) as { jwt: string };

    // Rotation invalidates the standing invite code for everyone, so it is
    // creator-only like disband/wipe/kick.
    const rotateRes = await post(app, '/spaces/rotate-code', {}, bobJwt);
    expect(rotateRes.status).toBe(403);
    expect(((await rotateRes.json()) as { error: string }).error).toBe(
      'not_creator'
    );
  });
});

// ── AC5: POST /spaces/leave ──────────────────────────────────────────────────

describe('AC5 — POST /spaces/leave', () => {
  it('non-creator can leave; subsequent requests return 401 member_left', async () => {
    const { app } = setupAuthApp();
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

    const leaveRes = await post(app, '/spaces/leave', {}, bobJwt);
    expect(leaveRes.status).toBe(200);

    // Bob's JWT is now invalid (member_left)
    const rotateRes = await post(app, '/spaces/rotate-code', {}, bobJwt);
    expect(rotateRes.status).toBe(401);
    expect(((await rotateRes.json()) as { error: string }).error).toBe(
      'member_left'
    );

    void aliceJwt;
  });

  it('creator leave returns 409 creator_must_disband', async () => {
    const { app } = setupAuthApp();
    const createRes = await post(app, '/spaces', { member_name: 'alice' });
    const { jwt } = (await createRes.json()) as { jwt: string };
    const leaveRes = await post(app, '/spaces/leave', {}, jwt);
    expect(leaveRes.status).toBe(409);
    expect(((await leaveRes.json()) as { error: string }).error).toBe(
      'creator_must_disband'
    );
  });
});

// ── AC6: POST /spaces/kick ───────────────────────────────────────────────────

describe('AC6 — POST /spaces/kick', () => {
  it('creator can kick a member; kicked member JWT becomes invalid', async () => {
    const { app } = setupAuthApp();
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

    const kickRes = await post(
      app,
      '/spaces/kick',
      { member_name: 'bob' },
      aliceJwt
    );
    expect(kickRes.status).toBe(200);

    // Bob's JWT is now invalid
    const rotateRes = await post(app, '/spaces/rotate-code', {}, bobJwt);
    expect(rotateRes.status).toBe(401);
    expect(((await rotateRes.json()) as { error: string }).error).toBe(
      'member_left'
    );
  });

  it('non-creator kick returns 403 not_creator', async () => {
    const { app } = setupAuthApp();
    const createRes = await post(app, '/spaces', { member_name: 'alice' });
    const { room_code } = (await createRes.json()) as { room_code: string };
    const joinRes = await post(app, '/spaces/join', {
      room_code,
      member_name: 'bob'
    });
    const { jwt: bobJwt } = (await joinRes.json()) as { jwt: string };

    const kickRes = await post(
      app,
      '/spaces/kick',
      { member_name: 'alice' },
      bobJwt
    );
    expect(kickRes.status).toBe(403);
    expect(((await kickRes.json()) as { error: string }).error).toBe(
      'not_creator'
    );
  });

  it('creator self-kick returns 409 cannot_self_kick', async () => {
    const { app } = setupAuthApp();
    const createRes = await post(app, '/spaces', { member_name: 'alice' });
    const { jwt } = (await createRes.json()) as { jwt: string };
    const kickRes = await post(
      app,
      '/spaces/kick',
      { member_name: 'alice' },
      jwt
    );
    expect(kickRes.status).toBe(409);
    expect(((await kickRes.json()) as { error: string }).error).toBe(
      'cannot_self_kick'
    );
  });

  it('same-name rejoin after kick succeeds (AC6 same-name-after-kick contract)', async () => {
    const { app } = setupAuthApp();
    const createRes = await post(app, '/spaces', { member_name: 'alice' });
    const { room_code, jwt: aliceJwt } = (await createRes.json()) as {
      room_code: string;
      jwt: string;
    };
    await post(app, '/spaces/join', { room_code, member_name: 'bob' });

    await post(app, '/spaces/kick', { member_name: 'bob' }, aliceJwt);

    // Bob rejoins with same name — should succeed
    const rejoin = await post(app, '/spaces/join', {
      room_code,
      member_name: 'bob'
    });
    expect(rejoin.status).toBe(200);
  });
});

// ── AC7: POST /spaces/disband ────────────────────────────────────────────────

describe('AC7 — POST /spaces/disband', () => {
  it('creator can disband with label_confirmation; subsequent requests return 410 space_disbanded', async () => {
    const { app } = setupAuthApp();
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

    // Default label is `${member_name}'s space`
    const disbandRes = await post(
      app,
      '/spaces/disband',
      { label_confirmation: "alice's space" },
      aliceJwt
    );
    expect(disbandRes.status).toBe(200);

    // Alice's subsequent request
    const rotateRes = await post(app, '/spaces/rotate-code', {}, aliceJwt);
    expect(rotateRes.status).toBe(410);
    expect(((await rotateRes.json()) as { error: string }).error).toBe(
      'space_disbanded'
    );

    // Bob's subsequent request
    const leaveRes = await post(app, '/spaces/leave', {}, bobJwt);
    expect(leaveRes.status).toBe(410);
  });

  it('non-creator disband returns 403 not_creator', async () => {
    const { app } = setupAuthApp();
    const createRes = await post(app, '/spaces', { member_name: 'alice' });
    const { room_code } = (await createRes.json()) as { room_code: string };
    const joinRes = await post(app, '/spaces/join', {
      room_code,
      member_name: 'bob'
    });
    const { jwt: bobJwt } = (await joinRes.json()) as { jwt: string };

    const res = await post(
      app,
      '/spaces/disband',
      { label_confirmation: "alice's space" },
      bobJwt
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('not_creator');
  });

  it('missing label_confirmation returns 400 label_required', async () => {
    const { app } = setupAuthApp();
    const createRes = await post(app, '/spaces', { member_name: 'alice' });
    const { jwt } = (await createRes.json()) as { jwt: string };
    const res = await post(app, '/spaces/disband', {}, jwt);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      'label_required'
    );
  });

  it('wrong label_confirmation returns 400 label_mismatch', async () => {
    const { app } = setupAuthApp();
    const createRes = await post(app, '/spaces', {
      member_name: 'alice',
      label: 'team-alpha'
    });
    const { jwt } = (await createRes.json()) as { jwt: string };
    const res = await post(
      app,
      '/spaces/disband',
      { label_confirmation: 'wrong-label' },
      jwt
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      'label_mismatch'
    );
  });
});

// ── AC8: Auth middleware reject codes ────────────────────────────────────────

describe('AC8 — auth middleware reject codes', () => {
  it('returns 401 token_expired for an expired JWT', async () => {
    const { app } = setupAuthApp();
    // Mint a JWT already expired
    const expiredToken = await signJwt(
      { sub: 'alice', space_id: 'sp-x' },
      TEST_JWT_SECRET
    );
    // Manually craft expired JWT payload
    const parts = expiredToken.split('.');
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    payload.exp = Math.floor(Date.now() / 1000) - 3600;
    const modPart = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const badToken = `${parts[0]}.${modPart}.${parts[2]}`;

    const res = await post(app, '/spaces/rotate-code', {}, badToken);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe(
      'token_expired'
    );
  });

  it('returns 401 invalid_signature for a tampered JWT', async () => {
    const { app } = setupAuthApp();
    const res = await post(app, '/spaces/rotate-code', {}, 'invalid.jwt.token');
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(['invalid_signature', 'jwt_invalid']).toContain(body.error);
  });

  it('returns 401 member_left after leave', async () => {
    const { app } = setupAuthApp();
    const createRes = await post(app, '/spaces', { member_name: 'alice' });
    const { room_code } = (await createRes.json()) as { room_code: string };
    const joinRes = await post(app, '/spaces/join', {
      room_code,
      member_name: 'bob'
    });
    const { jwt: bobJwt } = (await joinRes.json()) as { jwt: string };
    await post(app, '/spaces/leave', {}, bobJwt);

    const res = await post(app, '/spaces/rotate-code', {}, bobJwt);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe('member_left');
  });

  it('returns 410 space_disbanded after disband', async () => {
    const { app } = setupAuthApp();
    const createRes = await post(app, '/spaces', { member_name: 'alice' });
    const { jwt } = (await createRes.json()) as { jwt: string };
    await post(
      app,
      '/spaces/disband',
      { label_confirmation: "alice's space" },
      jwt
    );

    const res = await post(app, '/spaces/rotate-code', {}, jwt);
    expect(res.status).toBe(410);
    expect(((await res.json()) as { error: string }).error).toBe(
      'space_disbanded'
    );
  });
});

// ── AC14: scope-in-body rejection ─────────────────────────────────────────────
// Updated post-remediation: top-level `space_id` and `principal` in body
// are rejected outright with 400 scope_in_body_unsupported (replaces the
// older silent-injection / mismatch model). See plan §2 req 6 and reviewer
// finding CRITICAL #3.

describe('AC14 — scope_in_body_unsupported on /tools', () => {
  it('returns 400 scope_in_body_unsupported when body contains space_id', async () => {
    const { app } = setupAuthApp();
    const createRes = await post(app, '/spaces', { member_name: 'alice' });
    const { jwt } = (await createRes.json()) as { jwt: string };

    const res = await post(
      app,
      '/tools/teamem.get_updates',
      { space_id: 'wrong-space' },
      jwt
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      'scope_in_body_unsupported'
    );
  });
});

// ── AC19: is_creator read from DB on every privileged request ────────────────

describe('AC19 — creator check reads from DB', () => {
  it('JWT with is_creator flipped in DB → 403 not_creator on kick', async () => {
    const { app, db } = setupAuthApp();
    const createRes = await post(app, '/spaces', { member_name: 'alice' });
    const { jwt, space_id } = (await createRes.json()) as {
      jwt: string;
      space_id: string;
    };
    await post(app, '/spaces/join', {
      room_code: (
        (await (await post(app, '/spaces/rotate-code', {}, jwt)).json()) as {
          room_code: string;
        }
      ).room_code,
      member_name: 'bob'
    });

    // Manually flip is_creator to 0
    db.prepare(
      `UPDATE members SET is_creator = 0 WHERE space_id = ? AND name = 'alice'`
    ).run(space_id);

    const kickRes = await post(
      app,
      '/spaces/kick',
      { member_name: 'bob' },
      jwt
    );
    expect(kickRes.status).toBe(403);
    expect(((await kickRes.json()) as { error: string }).error).toBe(
      'not_creator'
    );
  });
});

// ── AC20: structured log line per auth check ─────────────────────────────────

describe('AC20 — structured auth log', () => {
  it('emits auth_check log with result=ok on successful auth', async () => {
    resetAuthCheckLogBuckets();
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));

    const { app } = setupAuthApp();
    const createRes = await post(app, '/spaces', { member_name: 'alice' });
    const { jwt } = (await createRes.json()) as { jwt: string };
    await post(app, '/spaces/rotate-code', {}, jwt);

    console.log = origLog;

    const authLogs = logs.filter((l) => l.includes('"auth_check"'));
    expect(authLogs.length).toBeGreaterThan(0);
    const parsed = JSON.parse(authLogs[authLogs.length - 1]);
    expect(parsed.event).toBe('auth_check');
    expect(parsed.result).toBe('ok');
    expect(typeof parsed.latency_ms).toBe('number');
  });
});

// ── AC21: rate-limit on bootstrap endpoints ───────────────────────────────────

describe('AC21 — rate-limit 10min per IP', () => {
  // Production server defaults to ignoring client-supplied X-Forwarded-For
  // (security review P1#2). This suite simulates a proxy-trusted deployment
  // so the test's per-request X-Forwarded-For values drive per-IP buckets.
  const ORIG_TRUST_PROXY = process.env.TEAMEM_TRUST_PROXY;
  beforeAll(() => {
    process.env.TEAMEM_TRUST_PROXY = '1';
  });
  afterAll(() => {
    if (ORIG_TRUST_PROXY === undefined) delete process.env.TEAMEM_TRUST_PROXY;
    else process.env.TEAMEM_TRUST_PROXY = ORIG_TRUST_PROXY;
  });

  it('11th attempt to POST /spaces/join returns 429 rate_limited', async () => {
    const { app } = setupAuthApp();

    for (let i = 0; i < 10; i++) {
      const res = await app.request('/spaces/join', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-forwarded-for': '1.2.3.4'
        },
        body: JSON.stringify({ room_code: 'BADCODE1', member_name: 'user' + i })
      });
      // These all return 401 invalid_code, which is fine
      expect(res.status).not.toBe(429);
    }

    const eleventh = await app.request('/spaces/join', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-forwarded-for': '1.2.3.4'
      },
      body: JSON.stringify({ room_code: 'BADCODE1', member_name: 'user11' })
    });
    expect(eleventh.status).toBe(429);
    const body = (await eleventh.json()) as { error: string };
    expect(body.error).toBe('rate_limited');
  });

  it('different IPs have independent rate-limit buckets', async () => {
    const { app } = setupAuthApp();

    for (let i = 0; i < 11; i++) {
      await app.request('/spaces/join', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-forwarded-for': '10.0.0.1'
        },
        body: JSON.stringify({ room_code: 'BADCODE1', member_name: 'u' + i })
      });
    }

    // Different IP should still get through
    const res = await app.request('/spaces/join', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-forwarded-for': '10.0.0.2'
      },
      body: JSON.stringify({ room_code: 'BADCODE1', member_name: 'other' })
    });
    expect(res.status).not.toBe(429);
  });
});
