import { describe, expect, it } from 'bun:test';
import { setupAuthApp } from './auth/helpers.js';

/**
 * Phase 1 server-routes test: covers /health and /tools dispatch under JWT
 * auth. Auth-only behaviors (401/410/403/space_mismatch) are exhaustively
 * covered by tests/integration/auth/spaces.test.ts; this file focuses on
 * tool-dispatch round-trip behavior that the auth suite does not exercise.
 */

async function bootstrapAlice(app: ReturnType<typeof setupAuthApp>['app']) {
  const res = await app.request('/spaces', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ member_name: 'alice' })
  });
  const body = (await res.json()) as {
    space_id: string;
    jwt: string;
    member_id: string;
  };
  return body;
}

async function bootstrapBob(
  app: ReturnType<typeof setupAuthApp>['app'],
  db: ReturnType<typeof setupAuthApp>['db'],
  spaceId: string
) {
  const room = db
    .prepare('SELECT code FROM room_codes WHERE space_id = ?1 LIMIT 1')
    .get(spaceId) as { code: string };
  const res = await app.request('/spaces/join', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ room_code: room.code, member_name: 'bob' })
  });
  return (await res.json()) as {
    space_id: string;
    jwt: string;
    member_id: string;
  };
}

describe('GET /health', () => {
  it('returns ok without auth', async () => {
    const { app } = setupAuthApp();
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});

describe('POST /tools/:name — happy path', () => {
  it('claims a scope and reads the resulting event back', async () => {
    const { app } = setupAuthApp();
    const { space_id, jwt } = await bootstrapAlice(app);

    const claimRes = await app.request('/tools/teamem.claim_scope', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwt}`
      },
      body: JSON.stringify({
        actor: 'alice/agent',
        delegation: 'alice->agent',
        scope: { paths: ['src/server/index.ts'] },
        intent: 'route-test'
      })
    });
    expect(claimRes.status).toBe(200);
    const claimBody = (await claimRes.json()) as {
      ok: boolean;
      data: { claim_id: string };
    };
    expect(claimBody.ok).toBe(true);
    expect(claimBody.data.claim_id).toBeTruthy();
    void space_id;

    const updatesRes = await app.request('/tools/teamem.get_updates', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwt}`
      },
      body: JSON.stringify({})
    });
    expect(updatesRes.status).toBe(200);
    const updatesBody = (await updatesRes.json()) as {
      ok: boolean;
      data: { events: unknown[] };
    };
    expect(updatesBody.ok).toBe(true);
    expect(updatesBody.data.events.length).toBeGreaterThan(0);
  });

  it('returns the authenticated Space Rules snapshot payload', async () => {
    const { app, db } = setupAuthApp();
    const { space_id, jwt, member_id } = await bootstrapAlice(app);

    db.exec(
      `INSERT INTO space_rules_snapshots (space_id, rules_markdown, rules_version, source_event_id, updated_at, updated_by_member_id)
       VALUES (
         '${space_id}',
         'Prefer focused diffs.\nRefresh the Teamem-managed block only.',
         3,
         'evt-rules-route',
         '2026-05-10T02:03:04.000Z',
         '${member_id}'
       )`
    );

    const res = await app.request('/tools/teamem.export_space_rules_snapshot', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwt}`
      },
      body: JSON.stringify({})
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      data: {
        has_server_rules: boolean;
        rendered_rules_body: string;
        metadata: {
          rules_version: number;
          rules_hash: string;
          source_event_id: string | null;
          snapshot_updated_by: string | null;
        };
      };
    };
    expect(body.ok).toBe(true);
    expect(body.data.has_server_rules).toBe(true);
    expect(body.data.rendered_rules_body).toContain('Prefer focused diffs.');
    expect(body.data.metadata.rules_version).toBe(3);
    expect(body.data.metadata.rules_hash).toBeTruthy();
    expect(body.data.metadata.source_event_id).toBe('evt-rules-route');
    expect(body.data.metadata.snapshot_updated_by).toBe('alice');
  });

  it('returns session_sync with the dedicated Space Rules snapshot surface', async () => {
    const { app, db } = setupAuthApp();
    const { space_id, jwt, member_id } = await bootstrapAlice(app);

    db.exec(
      `INSERT INTO space_rules_snapshots (space_id, rules_markdown, rules_version, source_event_id, updated_at, updated_by_member_id)
       VALUES (
         '${space_id}',
         'Prefer focused diffs.\nSync from the dedicated SessionStart path.',
         4,
         'evt-rules-sync',
         '2026-05-10T02:03:04.000Z',
         '${member_id}'
       )`
    );

    const res = await app.request('/tools/teamem.session_sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwt}`
      },
      body: JSON.stringify({})
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      data: {
        space_rules_snapshot: {
          has_server_rules: boolean;
          rendered_rules_body: string;
          metadata: { rules_version: number; source_event_id: string | null };
        };
        decision_replays: unknown[];
        gotcha_notices: unknown[];
      };
    };
    expect(body.ok).toBe(true);
    expect(body.data.space_rules_snapshot.has_server_rules).toBe(true);
    expect(body.data.space_rules_snapshot.rendered_rules_body).toContain(
      'Sync from the dedicated SessionStart path.'
    );
    expect(body.data.space_rules_snapshot.metadata.rules_version).toBe(4);
    expect(body.data.space_rules_snapshot.metadata.source_event_id).toBe(
      'evt-rules-sync'
    );
    expect(body.data.decision_replays).toEqual([]);
    expect(body.data.gotcha_notices).toEqual([]);
  });

  it('returns SessionStart decision replay payloads exactly once for the authenticated principal', async () => {
    const { app, db } = setupAuthApp();
    const { space_id, jwt } = await bootstrapAlice(app);
    const { jwt: bobJwt } = await bootstrapBob(app, db, space_id);

    const publishRes = await app.request('/tools/teamem.publish_decision', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwt}`
      },
      body: JSON.stringify({
        actor: 'alice/agent',
        delegation: 'alice->agent',
        decision_id: 'dec-route-sync',
        title: 'Route-level replay',
        summary: 'Bob should see this once through session_sync.',
        body: 'Full route-level decision body.',
        kind: 'process'
      })
    });
    expect(publishRes.status).toBe(200);

    const first = await app.request('/tools/teamem.session_sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bobJwt}`
      },
      body: JSON.stringify({})
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      ok: boolean;
      data: {
        decisions: Array<{
          event_type: string;
          payload: { decision_id: string; body: string };
        }>;
      };
    };
    expect(firstBody.ok).toBe(true);
    expect(firstBody.data.decisions).toHaveLength(1);
    expect(firstBody.data.decisions[0]).toMatchObject({
      event_type: 'decision_published',
      payload: {
        decision_id: 'dec-route-sync',
        body: 'Full route-level decision body.'
      }
    });

    const second = await app.request('/tools/teamem.session_sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bobJwt}`
      },
      body: JSON.stringify({})
    });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as {
      ok: boolean;
      data: { decisions: unknown[] };
    };
    expect(secondBody.ok).toBe(true);
    expect(secondBody.data.decisions).toEqual([]);
  });

  it('acknowledges a gotcha through the authenticated tool route', async () => {
    const { app } = setupAuthApp();
    const { jwt } = await bootstrapAlice(app);

    const sharedRes = await app.request('/tools/teamem.share_finding', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwt}`
      },
      body: JSON.stringify({
        actor: 'alice/agent',
        delegation: 'alice->agent',
        kind: 'gotcha',
        summary: 'Refresh TEAMEM.md only from server snapshots',
        body: 'Do not infer Space Rules from briefing output.'
      })
    });
    expect(sharedRes.status).toBe(200);
    const sharedBody = (await sharedRes.json()) as {
      ok: boolean;
      data: { finding_id: string; version: number };
    };
    expect(sharedBody.ok).toBe(true);

    const ackRes = await app.request('/tools/teamem.acknowledge_finding', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwt}`
      },
      body: JSON.stringify({
        actor: 'alice/agent',
        delegation: 'alice->agent',
        finding_id: sharedBody.data.finding_id,
        version: sharedBody.data.version
      })
    });
    expect(ackRes.status).toBe(200);
    const ackBody = (await ackRes.json()) as {
      ok: boolean;
      data: { finding_id: string; version: number; meaning: string };
    };
    expect(ackBody.ok).toBe(true);
    expect(ackBody.data.finding_id).toBe(sharedBody.data.finding_id);
    expect(ackBody.data.version).toBe(sharedBody.data.version);
    expect(ackBody.data.meaning).toBe('seen');
  });

  it('returns 409 for stale Space Rules publishes and 200 not_creator for non-creator raw tool calls', async () => {
    const { app, db } = setupAuthApp();
    const { space_id, jwt } = await bootstrapAlice(app);
    const { jwt: bobJwt } = await bootstrapBob(app, db, space_id);

    const first = await app.request('/tools/teamem.update_space_rules', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwt}`
      },
      body: JSON.stringify({
        actor: 'alice/agent',
        delegation: 'alice->agent',
        rules_markdown: 'Prefer focused diffs.',
        base_version: 0,
        base_hash:
          'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
      })
    });
    expect(first.status).toBe(200);

    const stale = await app.request('/tools/teamem.update_space_rules', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwt}`
      },
      body: JSON.stringify({
        actor: 'alice/agent',
        delegation: 'alice->agent',
        rules_markdown: 'Overwrite stale draft.',
        base_version: 0,
        base_hash:
          'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
      })
    });
    expect(stale.status).toBe(409);
    const staleBody = (await stale.json()) as {
      ok: boolean;
      error: { code: string; details: { current_version: number } };
    };
    expect(staleBody.ok).toBe(false);
    expect(staleBody.error.code).toBe('space_rules_conflict');
    expect(staleBody.error.details.current_version).toBe(1);

    const beforeBob = (
      db
        .query(
          `SELECT COUNT(*) AS c
             FROM events
            WHERE space_id = ?1
              AND event_type IN ('space_rule_added', 'space_rule_amended', 'space_rule_disabled')`
        )
        .get(space_id) as { c: number }
    ).c;

    const bobRes = await app.request('/tools/teamem.update_space_rules', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bobJwt}`
      },
      body: JSON.stringify({
        actor: 'bob/agent',
        delegation: 'bob->agent',
        rules_markdown: 'Bob should not be allowed.',
        base_version: 1,
        base_hash:
          '2a33b36266ae01c7781be15a110564b9efeeb188fff4ab580455e4f1378f6758'
      })
    });
    expect(bobRes.status).toBe(200);
    const bobBody = (await bobRes.json()) as {
      ok: boolean;
      error: { code: string };
    };
    expect(bobBody.ok).toBe(false);
    expect(bobBody.error.code).toBe('not_creator');

    const afterBob = (
      db
        .query(
          `SELECT COUNT(*) AS c
             FROM events
            WHERE space_id = ?1
              AND event_type IN ('space_rule_added', 'space_rule_amended', 'space_rule_disabled')`
        )
        .get(space_id) as { c: number }
    ).c;
    expect(afterBob).toBe(beforeBob);
  });
});

describe('POST /tools/:name — unknown tool', () => {
  it('returns 404 tool_not_found for an unregistered tool name', async () => {
    const { app } = setupAuthApp();
    const { jwt } = await bootstrapAlice(app);

    const res = await app.request('/tools/teamem.does_not_exist', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwt}`
      },
      body: JSON.stringify({})
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; tool: string };
    expect(body.error).toBe('tool_not_found');
    expect(body.tool).toBe('teamem.does_not_exist');
  });
});

describe('POST /tools/:name — invalid JSON', () => {
  it('returns 400 invalid_json for a non-JSON body', async () => {
    const { app } = setupAuthApp();
    const { jwt } = await bootstrapAlice(app);

    const res = await app.request('/tools/teamem.get_updates', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwt}`
      },
      body: 'not-json'
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_json');
  });
});

describe('POST /tools/:name — AC22 repo_id rejection', () => {
  it('rejects top-level repo_id with 400 repo_id_unsupported', async () => {
    const { app } = setupAuthApp();
    const { jwt } = await bootstrapAlice(app);

    const res = await app.request('/tools/teamem.get_briefing', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwt}`
      },
      body: JSON.stringify({ repo_id: 'x' })
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('repo_id_unsupported');
  });

  it('rejects top-level space_id with 400 scope_in_body_unsupported', async () => {
    const { app } = setupAuthApp();
    const { jwt } = await bootstrapAlice(app);

    const res = await app.request('/tools/teamem.get_briefing', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwt}`
      },
      body: JSON.stringify({ space_id: 'x' })
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('scope_in_body_unsupported');
  });

  it('rejects top-level principal with 400 scope_in_body_unsupported', async () => {
    const { app } = setupAuthApp();
    const { jwt } = await bootstrapAlice(app);

    const res = await app.request('/tools/teamem.get_briefing', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwt}`
      },
      body: JSON.stringify({ principal: 'eve' })
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('scope_in_body_unsupported');
  });
});
