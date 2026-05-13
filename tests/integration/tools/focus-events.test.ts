import { describe, expect, it } from 'bun:test';
import { setupAuthApp } from '../auth/helpers.js';

// Issue #15 — focus events end-to-end through the MCP HTTP surface.
// Verifies the agent_focus_changed tool, dedup projection, and the
// Mode 6.B grant path firing a fresh focus event with bypass_dedup.

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
  const { room_code, jwt: aliceJwt } = (await create.json()) as {
    room_code: string;
    jwt: string;
  };
  const join = await post(app, '/spaces/join', {
    room_code,
    member_name: 'bob'
  });
  const { jwt: bobJwt } = (await join.json()) as { jwt: string };
  return { app, db, aliceJwt, bobJwt };
}

describe('teamem.agent_focus_changed — happy path', () => {
  it('persists a focus row and surfaces in the briefing recent_progress', async () => {
    const { app, aliceJwt } = await bootstrapTwo();
    const res = await post(
      app,
      '/tools/teamem.agent_focus_changed',
      {
        scope: { paths: ['src/auth/login.ts'] },
        intent: 'wiring SSO callback'
      },
      aliceJwt
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      data: { focus_id: string; scope_hash: string; deduped: boolean };
    };
    expect(body.ok).toBe(true);
    expect(body.data.focus_id).toBeTruthy();
    expect(body.data.scope_hash).toBeTruthy();
    expect(body.data.deduped).toBe(false);

    const briefing = await post(
      app,
      '/tools/teamem.get_briefing',
      {},
      aliceJwt
    );
    const brief = (await briefing.json()) as {
      ok: boolean;
      data: {
        recent_progress: Array<{
          principal: string;
          task_id: string;
          what: string;
          at: string;
        }>;
      };
    };
    expect(brief.ok).toBe(true);
    const aliceRow = brief.data.recent_progress.find(
      (p) => p.principal === 'alice'
    );
    expect(aliceRow).toBeDefined();
    expect(aliceRow!.what).toBe('wiring SSO callback');
  });
});

describe('teamem.agent_focus_changed — dedup', () => {
  it('rapid same-scope events from the same principal collapse (deduped=true)', async () => {
    const { app, db, aliceJwt } = await bootstrapTwo();
    const first = await post(
      app,
      '/tools/teamem.agent_focus_changed',
      { scope: { paths: ['src/auth/login.ts'] } },
      aliceJwt
    );
    const firstBody = (await first.json()) as {
      data: { focus_id: string; deduped: boolean };
    };
    expect(firstBody.data.deduped).toBe(false);

    const second = await post(
      app,
      '/tools/teamem.agent_focus_changed',
      { scope: { paths: ['src/auth/login.ts'] } },
      aliceJwt
    );
    const secondBody = (await second.json()) as {
      data: { focus_id: string; deduped: boolean };
    };
    expect(secondBody.data.deduped).toBe(true);
    // Different focus_id values are returned — but the projection only
    // kept the first.
    expect(secondBody.data.focus_id).not.toBe(firstBody.data.focus_id);

    const count = (
      db
        .prepare("SELECT COUNT(*) AS c FROM focus WHERE principal = 'alice'")
        .get() as { c: number }
    ).c;
    expect(count).toBe(1);
  });

  it('different scope produces a new focus row even within window', async () => {
    const { app, db, aliceJwt } = await bootstrapTwo();
    await post(
      app,
      '/tools/teamem.agent_focus_changed',
      { scope: { paths: ['src/auth/login.ts'] } },
      aliceJwt
    );
    await post(
      app,
      '/tools/teamem.agent_focus_changed',
      { scope: { paths: ['src/auth/session.ts'] } },
      aliceJwt
    );
    const count = (
      db
        .prepare("SELECT COUNT(*) AS c FROM focus WHERE principal = 'alice'")
        .get() as { c: number }
    ).c;
    expect(count).toBe(2);
  });

  it('bypass_dedup forces a fresh row inside the dedup window', async () => {
    const { app, db, aliceJwt } = await bootstrapTwo();
    await post(
      app,
      '/tools/teamem.agent_focus_changed',
      { scope: { paths: ['src/auth/login.ts'] } },
      aliceJwt
    );
    const second = await post(
      app,
      '/tools/teamem.agent_focus_changed',
      {
        scope: { paths: ['src/auth/login.ts'] },
        bypass_dedup: true
      },
      aliceJwt
    );
    const secondBody = (await second.json()) as {
      data: { deduped: boolean };
    };
    expect(secondBody.data.deduped).toBe(false);
    const count = (
      db
        .prepare("SELECT COUNT(*) AS c FROM focus WHERE principal = 'alice'")
        .get() as { c: number }
    ).c;
    expect(count).toBe(2);
  });
});

describe('Mode 6.B grant path emits agent_focus_changed with bypass_dedup', () => {
  it('produces a fresh focus row for the requester even within the dedup window', async () => {
    const { app, db, aliceJwt, bobJwt } = await bootstrapTwo();

    // 1. Bob fires a focus event for the path he wants to edit.
    await post(
      app,
      '/tools/teamem.agent_focus_changed',
      { scope: { paths: ['src/auth/login.ts'] } },
      bobJwt
    );
    const beforeCount = (
      db
        .prepare("SELECT COUNT(*) AS c FROM focus WHERE principal = 'bob'")
        .get() as { c: number }
    ).c;
    expect(beforeCount).toBe(1);

    // 2. Alice claims the path so bob will hit a conflict.
    const aliceClaim = await post(
      app,
      '/tools/teamem.claim_scope',
      {
        scope: { paths: ['src/auth/login.ts'] },
        intent: 'alice owns auth'
      },
      aliceJwt
    );
    const aliceClaimBody = (await aliceClaim.json()) as {
      data: { claim_id: string };
    };
    const aliceClaimId = aliceClaimBody.data.claim_id;

    // 3. Bob requests permission (run with a tiny long-poll so the test
    // doesn't hang waiting for alice's response — _long_poll_timeout_ms
    // is honored by the tool implementation for tests).
    const reqPromise = post(
      app,
      '/tools/teamem.request_edit_permission',
      {
        blocking_claim_id: aliceClaimId,
        paths: ['src/auth/login.ts'],
        intent: 'fix the redirect bug',
        _long_poll_timeout_ms: 5000
      },
      bobJwt
    );

    // 4. Alice grants the request. The grant tx fires a focus event for
    // bob with bypass_dedup: true so the post-narrow focus is captured
    // even though bob already fired a same-scope-hash event seconds ago.
    //
    // We need to discover the req_id alice should respond to. Since
    // request_edit_permission long-polls, we read it from permission_requests
    // directly while the long-poll is in flight.
    let reqId: string | null = null;
    for (let i = 0; i < 50; i++) {
      const row = db
        .prepare(
          `SELECT req_id FROM permission_requests
            WHERE space_id = (SELECT id FROM spaces LIMIT 1)
              AND status = 'open'
            ORDER BY created_at DESC LIMIT 1`
        )
        .get() as { req_id: string } | null;
      if (row) {
        reqId = row.req_id;
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(reqId).not.toBeNull();

    const grant = await post(
      app,
      '/tools/teamem.respond_permission_request',
      { req_id: reqId, decision: 'accept' },
      aliceJwt
    );
    expect(grant.status).toBe(200);
    const grantBody = (await grant.json()) as {
      ok: boolean;
      data: { status: string };
    };
    expect(grantBody.ok).toBe(true);
    expect(grantBody.data.status).toBe('granted');

    // 5. Wait for the long-poll to resolve.
    const reqRes = await reqPromise;
    expect(reqRes.status).toBe(200);
    const reqBody = (await reqRes.json()) as {
      ok: boolean;
      data: { req_id: string; action: string; claim_id?: string };
    };
    expect(reqBody.ok).toBe(true);
    expect(reqBody.data.req_id).toBe(reqId!);
    expect(reqBody.data.action).toBe('allow');
    expect(reqBody.data.claim_id).toBeTruthy();

    // 6. Verify bob now has TWO focus rows — the original and the
    // grant-narrow event with bypass_dedup that bypassed the 60s
    // collapse against the same scope_hash.
    const afterCount = (
      db
        .prepare("SELECT COUNT(*) AS c FROM focus WHERE principal = 'bob'")
        .get() as { c: number }
    ).c;
    expect(afterCount).toBe(2);

    // 7. The grant-narrow focus event references the req_id in its
    // payload so auditors can correlate the focus shift with the grant.
    const grantFocusEvt = db
      .prepare(
        `SELECT raw_json FROM events
          WHERE event_type = 'agent_focus_changed'
            AND principal = 'bob'
          ORDER BY rowid DESC LIMIT 1`
      )
      .get() as { raw_json: string };
    const parsed = JSON.parse(grantFocusEvt.raw_json) as {
      payload: {
        bypass_dedup?: boolean;
        source?: string;
        req_id?: string;
      };
    };
    expect(parsed.payload.bypass_dedup).toBe(true);
    expect(parsed.payload.source).toBe('mode_6b_grant');
    expect(parsed.payload.req_id).toBe(reqId!);
  });
});
