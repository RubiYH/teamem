import { describe, expect, it } from 'bun:test';
import { setupAuthApp } from '../auth/helpers.js';

// Issue #10 — end-to-end Mode 6.A: enqueue → release → conflict_resolved
// emitted with correct payload → projection cleaned. Uses the Hono test
// app from `setupAuthApp` so JWT auth and route-layer scope injection are
// in the loop.

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

async function bootstrapTwo() {
  const { app, db } = setupAuthApp();
  const create = await post(app, '/spaces', { member_name: 'alice' });
  const {
    room_code,
    jwt: aliceJwt,
    space_id
  } = (await create.json()) as {
    room_code: string;
    jwt: string;
    space_id: string;
  };
  const join = await post(app, '/spaces/join', {
    room_code,
    member_name: 'bob'
  });
  const { jwt: bobJwt } = (await join.json()) as { jwt: string };
  return { app, db, aliceJwt, bobJwt, spaceId: space_id };
}

async function aliceClaims(
  app: ReturnType<typeof setupAuthApp>['app'],
  aliceJwt: string,
  paths: string[] = ['src/auth/login.ts']
): Promise<string> {
  const res = await post(
    app,
    '/tools/teamem.claim_scope',
    { scope: { paths }, intent: 'alice owns auth' },
    aliceJwt
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    ok: boolean;
    data: { claim_id: string };
  };
  expect(body.ok).toBe(true);
  return body.data.claim_id;
}

describe('teamem.queue_pending_edit — happy path', () => {
  it('inserts a pending_edits row and appends a conflict_queued event', async () => {
    const { app, db, aliceJwt, bobJwt } = await bootstrapTwo();
    const claimId = await aliceClaims(app, aliceJwt);

    const queueRes = await post(
      app,
      '/tools/teamem.queue_pending_edit',
      {
        blocking_claim_id: claimId,
        paths: ['src/auth/login.ts'],
        intent: 'fix the redirect on logout'
      },
      bobJwt
    );
    expect(queueRes.status).toBe(200);
    const body = (await queueRes.json()) as {
      ok: boolean;
      data: { pending_id: string; event_id: string; expires_at: string };
    };
    expect(body.ok).toBe(true);
    expect(body.data.pending_id).toBeTruthy();

    const row = db
      .prepare(
        `SELECT blocked_principal, blocking_claim_id, paths_json, intent
           FROM pending_edits WHERE pending_id = ?1`
      )
      .get(body.data.pending_id) as {
      blocked_principal: string;
      blocking_claim_id: string;
      paths_json: string;
      intent: string;
    };
    expect(row.blocked_principal).toBe('bob');
    expect(row.blocking_claim_id).toBe(claimId);
    expect(JSON.parse(row.paths_json)).toEqual(['src/auth/login.ts']);
    expect(row.intent).toBe('fix the redirect on logout');

    const evt = db
      .prepare(`SELECT event_type FROM events WHERE event_id = ?1`)
      .get(body.data.event_id) as { event_type: string };
    expect(evt.event_type).toBe('conflict_queued');
  });

  it('rejects empty paths with paths_required', async () => {
    const { app, aliceJwt, bobJwt } = await bootstrapTwo();
    const claimId = await aliceClaims(app, aliceJwt);
    const res = await post(
      app,
      '/tools/teamem.queue_pending_edit',
      { blocking_claim_id: claimId, paths: [] },
      bobJwt
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      error?: { code: string };
    };
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe('paths_required');
  });

  it('rejects missing blocking_claim_id', async () => {
    const { app, bobJwt } = await bootstrapTwo();
    const res = await post(
      app,
      '/tools/teamem.queue_pending_edit',
      { paths: ['x'] },
      bobJwt
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      error?: { code: string };
    };
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe('blocking_claim_id_required');
  });
});

describe('release → conflict_resolved emission', () => {
  it("emits conflict_resolved for bob's queued edit when alice releases by claim_id match", async () => {
    const { app, db, aliceJwt, bobJwt } = await bootstrapTwo();
    const claimId = await aliceClaims(app, aliceJwt);

    const queue = await post(
      app,
      '/tools/teamem.queue_pending_edit',
      {
        blocking_claim_id: claimId,
        paths: ['src/auth/login.ts'],
        intent: 'fix redirect'
      },
      bobJwt
    );
    const { data: queueData } = (await queue.json()) as {
      data: { pending_id: string };
    };

    const releaseRes = await post(
      app,
      '/tools/teamem.release_scope',
      { claim_id: claimId },
      aliceJwt
    );
    expect(releaseRes.status).toBe(200);

    // Projection: pending row marked resolved.
    const row = db
      .prepare(`SELECT resolved_at FROM pending_edits WHERE pending_id = ?1`)
      .get(queueData.pending_id) as { resolved_at: string | null };
    expect(row.resolved_at).not.toBeNull();

    // Event log: a conflict_resolved event references this pending_id.
    const evt = db
      .prepare(
        `SELECT raw_json FROM events
          WHERE event_type = 'conflict_resolved'
          ORDER BY rowid DESC LIMIT 1`
      )
      .get() as { raw_json: string } | null;
    expect(evt).not.toBeNull();
    const parsed = JSON.parse(evt!.raw_json) as {
      event_type: string;
      payload: {
        pending_id: string;
        blocked_principal: string;
        blocking_claim_id: string;
        previously_blocked_paths: string[];
        now_free: boolean;
      };
    };
    expect(parsed.event_type).toBe('conflict_resolved');
    expect(parsed.payload.pending_id).toBe(queueData.pending_id);
    expect(parsed.payload.blocked_principal).toBe('bob');
    expect(parsed.payload.blocking_claim_id).toBe(claimId);
    expect(parsed.payload.previously_blocked_paths).toEqual([
      'src/auth/login.ts'
    ]);
    expect(parsed.payload.now_free).toBe(true);
  });

  it('resolves by path overlap even when blocking_claim_id differs', async () => {
    const { app, db, aliceJwt, bobJwt } = await bootstrapTwo();
    const claimId = await aliceClaims(app, aliceJwt, ['src/auth/login.ts']);
    const otherClaimId = await aliceClaims(app, aliceJwt, ['docs/blocker.md']);

    // Bob queues against a real, DIFFERENT claim id — but the paths overlap
    // alice's released scope, so the resolve-on-release should still fire.
    const queue = await post(
      app,
      '/tools/teamem.queue_pending_edit',
      {
        blocking_claim_id: otherClaimId,
        paths: ['src/auth/login.ts']
      },
      bobJwt
    );
    const { data: queueData } = (await queue.json()) as {
      data: { pending_id: string };
    };

    await post(
      app,
      '/tools/teamem.release_scope',
      { claim_id: claimId },
      aliceJwt
    );

    const row = db
      .prepare(`SELECT resolved_at FROM pending_edits WHERE pending_id = ?1`)
      .get(queueData.pending_id) as { resolved_at: string | null };
    expect(row.resolved_at).not.toBeNull();
  });

  it('does NOT resolve unrelated queue rows', async () => {
    const { app, db, aliceJwt, bobJwt } = await bootstrapTwo();
    const claimId = await aliceClaims(app, aliceJwt, ['src/auth/login.ts']);
    const otherClaimId = await aliceClaims(app, aliceJwt, ['docs/blocker.md']);

    const queue = await post(
      app,
      '/tools/teamem.queue_pending_edit',
      {
        blocking_claim_id: otherClaimId,
        paths: ['docs/UNRELATED.md']
      },
      bobJwt
    );
    const { data: queueData } = (await queue.json()) as {
      data: { pending_id: string };
    };

    await post(
      app,
      '/tools/teamem.release_scope',
      { claim_id: claimId },
      aliceJwt
    );

    const row = db
      .prepare(`SELECT resolved_at FROM pending_edits WHERE pending_id = ?1`)
      .get(queueData.pending_id) as { resolved_at: string | null };
    expect(row.resolved_at).toBeNull();
  });

  it('rejects queue requests for missing blocking claims', async () => {
    const { app, bobJwt } = await bootstrapTwo();
    const res = await post(
      app,
      '/tools/teamem.queue_pending_edit',
      {
        blocking_claim_id: 'missing-claim',
        paths: ['src/auth/login.ts']
      },
      bobJwt
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      error?: { code: string };
    };
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe('blocking_claim_not_found');
  });
});

describe('teamem.clear_queue', () => {
  it("clears caller's own rows only", async () => {
    const { app, db, aliceJwt, bobJwt } = await bootstrapTwo();
    const claimId = await aliceClaims(app, aliceJwt, [
      'src/auth/login.ts',
      'src/server/routes.ts'
    ]);

    await post(
      app,
      '/tools/teamem.queue_pending_edit',
      { blocking_claim_id: claimId, paths: ['src/auth/login.ts'] },
      bobJwt
    );

    // alice can't queue against her own claim (claim_scope would 200
    // idempotently), so we insert a synthetic row for a third member to
    // prove `clear_queue` is principal-scoped.
    db.prepare(
      `INSERT INTO pending_edits
         (pending_id, space_id, blocked_principal, blocking_claim_id,
          paths_json, intent, created_at, expires_at, resolved_at,
          source_event_id, tombstoned_at)
        VALUES ('p-other', (SELECT space_id FROM pending_edits LIMIT 1),
                'carol', ?1, '["x"]', 'x',
                datetime('now'), datetime('now','+1 day'), NULL, 'evt-x',
                NULL)`
    ).run(claimId);

    const res = await post(app, '/tools/teamem.clear_queue', {}, bobJwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      data: { cleared: number };
    };
    expect(body.ok).toBe(true);
    expect(body.data.cleared).toBe(1);

    // carol's row survives.
    const remaining = (
      db.prepare('SELECT COUNT(*) AS c FROM pending_edits').get() as {
        c: number;
      }
    ).c;
    expect(remaining).toBe(1);
  });

  it('returns cleared:0 when queue empty', async () => {
    const { app, bobJwt } = await bootstrapTwo();
    const res = await post(app, '/tools/teamem.clear_queue', {}, bobJwt);
    const body = (await res.json()) as {
      ok: boolean;
      data: { cleared: number };
    };
    expect(body.ok).toBe(true);
    expect(body.data.cleared).toBe(0);
  });
});

describe('queue visibility in getBriefing.active_claims', () => {
  it("annotates incumbent's claim with blocking_principals", async () => {
    const { app, aliceJwt, bobJwt } = await bootstrapTwo();
    const claimId = await aliceClaims(app, aliceJwt);

    await post(
      app,
      '/tools/teamem.queue_pending_edit',
      {
        blocking_claim_id: claimId,
        paths: ['src/auth/login.ts']
      },
      bobJwt
    );

    const briefing = await post(
      app,
      '/tools/teamem.get_briefing',
      {},
      aliceJwt
    );
    const body = (await briefing.json()) as {
      ok: boolean;
      data: {
        active_claims: Array<{
          principal: string;
          blocking_principals?: Array<{ principal: string; paths: string[] }>;
        }>;
      };
    };
    expect(body.ok).toBe(true);
    const aliceClaim = body.data.active_claims.find(
      (c) => c.principal === 'alice'
    );
    expect(aliceClaim).toBeDefined();
    expect(aliceClaim!.blocking_principals).toEqual([
      { principal: 'bob', paths: ['src/auth/login.ts'] }
    ]);
  });
});
