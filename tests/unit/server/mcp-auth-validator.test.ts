/**
 * AC1-AC8b, AC15, AC15b — MCP auth validator unit tests.
 *
 * Spins up an in-process Hono server with a real SQLite DB and JWT secret
 * to verify the auth gate behaviour at /mcp.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { runAllMigrations } from '../../helpers/migrations.js';

import { Hono } from 'hono';
import { createSqliteClient } from '../../../src/infra/db/sqlite-client.js';
import { SqliteEventStore } from '../../../src/infra/db/sqlite-event-store.js';
import { createTeamemTools } from '../../../src/server/tools/index.js';
import { createRouter } from '../../../src/server/routes.js';
import { resetRateLimitBuckets } from '../../../src/server/rate-limit.js';
import { resetAuthCheckLogBuckets } from '../../../src/server/auth.js';
import type { Database } from 'bun:sqlite';

const TEST_JWT_SECRET = 'test-secret-32bytes-padded-xxxxx';

function buildApp(opts?: { jwtSecret?: string; allowNoAuth?: boolean }) {
  resetRateLimitBuckets();
  resetAuthCheckLogBuckets();
  const db = createSqliteClient(':memory:');
  runAllMigrations(db);
  const store = new SqliteEventStore(db);
  const tools = createTeamemTools({ db, store });
  const secret = opts?.jwtSecret ?? TEST_JWT_SECRET;
  const router = createRouter(tools, db, secret);
  const app = new Hono();
  app.route('/', router);
  return { app, db };
}

function buildAppNoSecret(allowNoAuth = false) {
  resetRateLimitBuckets();
  resetAuthCheckLogBuckets();
  const db = createSqliteClient(':memory:');
  runAllMigrations(db);
  const store = new SqliteEventStore(db);
  const tools = createTeamemTools({ db, store });
  // Pass db but NO jwtSecret — simulates "db but no jwtSecret" scenario (AC8b)
  const router = createRouter(tools, db, undefined);
  const app = new Hono();
  app.route('/', router);
  return { app, db, allowNoAuth };
}

async function bootstrapMember(
  app: Hono,
  name = 'alice'
): Promise<{ jwt: string; space_id: string }> {
  const res = await app.request('/spaces', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ member_name: name })
  });
  return res.json() as Promise<{ jwt: string; space_id: string }>;
}

function countEvents(db: Database): number {
  const row = db.prepare('SELECT COUNT(*) as n FROM events').get() as {
    n: number;
  };
  return row.n;
}

async function mcpToolsCall(
  app: Hono,
  toolName: string,
  args: Record<string, unknown>,
  headers: Record<string, string> = {}
): Promise<Response> {
  return app.request('/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: toolName, arguments: args }
    })
  });
}

beforeEach(() => {
  resetRateLimitBuckets();
  resetAuthCheckLogBuckets();
});

// AC1: POST /mcp tools/call without Authorization → 401, no events written
describe('AC1 — missing Authorization → 401', () => {
  it('returns 401 and writes no events', async () => {
    const { app, db } = buildApp();
    const before = countEvents(db);

    const res = await mcpToolsCall(app, 'teamem.get_briefing', {});

    expect(res.status).toBe(401);
    expect(countEvents(db)).toBe(before);
  });
});

// AC2: malformed Bearer → 401, no events
describe('AC2 — malformed Bearer → 401', () => {
  it('returns 401 for a non-JWT bearer token', async () => {
    const { app, db } = buildApp();
    const before = countEvents(db);

    const res = await mcpToolsCall(
      app,
      'teamem.get_briefing',
      {},
      {
        Authorization: 'Bearer xxx-not-a-jwt'
      }
    );

    expect(res.status).toBe(401);
    expect(countEvents(db)).toBe(before);
  });
});

// AC3: valid Bearer + arguments.space_id → 400, code -32602, message contains 'space_id'
describe('AC3 — caller-supplied space_id → 400', () => {
  it('returns 400 with -32602 mentioning space_id', async () => {
    const { app, db } = buildApp();
    const { jwt } = await bootstrapMember(app);
    const before = countEvents(db);

    const res = await mcpToolsCall(
      app,
      'teamem.get_briefing',
      { space_id: 'evil' },
      { Authorization: `Bearer ${jwt}` }
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: number; message: string };
    };
    expect(body.error.code).toBe(-32602);
    expect(body.error.message).toContain('space_id');
    expect(countEvents(db)).toBe(before);
  });
});

// AC4: caller-supplied principal → 400
describe('AC4 — caller-supplied principal → 400', () => {
  it('returns 400 with -32602 mentioning principal', async () => {
    const { app, db } = buildApp();
    const { jwt } = await bootstrapMember(app);
    const before = countEvents(db);

    const res = await mcpToolsCall(
      app,
      'teamem.get_briefing',
      { principal: 'hacker' },
      { Authorization: `Bearer ${jwt}` }
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: number; message: string };
    };
    expect(body.error.code).toBe(-32602);
    expect(body.error.message).toContain('principal');
    expect(countEvents(db)).toBe(before);
  });
});

// AC4b: actor, delegation, repo_id each → 400
describe('AC4b — caller-supplied actor/delegation/repo_id → 400', () => {
  for (const key of ['actor', 'delegation', 'repo_id'] as const) {
    it(`rejects caller-supplied ${key}`, async () => {
      const { app, db } = buildApp();
      const { jwt } = await bootstrapMember(app);
      const before = countEvents(db);

      const res = await mcpToolsCall(
        app,
        'teamem.get_briefing',
        { [key]: 'injected' },
        { Authorization: `Bearer ${jwt}` }
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        error: { code: number; message: string };
      };
      expect(body.error.code).toBe(-32602);
      expect(body.error.message).toContain(key);
      expect(countEvents(db)).toBe(before);
    });
  }
});

// AC5: valid Bearer + clean args → 200, stored event uses jwt.space_id
describe('AC5 — valid Bearer + clean args → 200, scope from JWT', () => {
  it('event uses space_id from JWT, not from body', async () => {
    const { app, db } = buildApp();
    const { jwt, space_id } = await bootstrapMember(app);

    // actor/delegation are in SCOPE_REJECT_KEYS — do not supply; server injects from JWT.
    const res = await mcpToolsCall(
      app,
      'teamem.claim_scope',
      {
        scope: { paths: ['src/ac5.ts'] },
        intent: 'AC5 stored-event check'
      },
      { Authorization: `Bearer ${jwt}` }
    );

    expect(res.status).toBe(200);
    const row = db
      .prepare('SELECT space_id FROM events ORDER BY rowid DESC LIMIT 1')
      .get() as { space_id: string } | null;
    expect(row).not.toBeNull();
    expect(row!.space_id).toBe(space_id);
  });
});

// AC6: success response matches golden shape
describe('AC6 — success response matches golden shape', () => {
  it('response body has jsonrpc/id/result keys', async () => {
    const { app } = buildApp();
    const { jwt } = await bootstrapMember(app);

    const res = await mcpToolsCall(
      app,
      'teamem.get_briefing',
      {},
      {
        Authorization: `Bearer ${jwt}`
      }
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      jsonrpc: string;
      id: number | null;
      result: unknown;
    };
    expect(body.jsonrpc).toBe('2.0');
    expect(body.id).toBe(1);
    expect(body.result).toBeDefined();
  });
});

// AC7: POST initialize without Authorization → 200 + MCP-Session-Id header
describe('AC7 — initialize without auth → 200 + MCP-Session-Id', () => {
  it('initialize is unauthenticated and returns session id', async () => {
    const { app } = buildApp();

    const res = await app.request('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {}
      })
    });

    expect(res.status).toBe(200);
    const sessionId = res.headers.get('MCP-Session-Id');
    expect(sessionId).toBeTruthy();
    expect(typeof sessionId).toBe('string');
  });
});

// AC8: DELETE /mcp with mismatched principal → 403
describe('AC8 — DELETE /mcp mismatched principal → 403', () => {
  it('returns 403 when session principal does not match JWT', async () => {
    const { app } = buildApp();
    // Create two members in the same space
    const { jwt: aliceJwt } = await bootstrapMember(app, 'alice');

    // Get room code and have bob join
    const rotateRes = await app.request('/spaces/rotate-code', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${aliceJwt}`
      },
      body: JSON.stringify({})
    });
    const { room_code } = (await rotateRes.json()) as { room_code: string };

    const joinRes = await app.request('/spaces/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ room_code, member_name: 'bob' })
    });
    const { jwt: bobJwt } = (await joinRes.json()) as { jwt: string };

    // Alice initializes and gets a session
    const initRes = await app.request('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {}
      })
    });
    const sessionId = initRes.headers.get('MCP-Session-Id')!;

    // Alice does a tools/call to bind her principal to the session
    await mcpToolsCall(
      app,
      'teamem.get_briefing',
      {},
      { 'MCP-Session-Id': sessionId, Authorization: `Bearer ${aliceJwt}` }
    );

    // Bob tries to DELETE alice's session → 403
    const deleteRes = await app.request('/mcp', {
      method: 'DELETE',
      headers: {
        'MCP-Session-Id': sessionId,
        Authorization: `Bearer ${bobJwt}`
      }
    });
    expect(deleteRes.status).toBe(403);
  });
});

// AC8b: server with db but no jwtSecret
describe('AC8b — db but no jwtSecret', () => {
  it('(a) without TEAMEM_ALLOW_NO_AUTH → 503 auth_unavailable', async () => {
    const origEnv = process.env.TEAMEM_ALLOW_NO_AUTH;
    delete process.env.TEAMEM_ALLOW_NO_AUTH;

    const { app } = buildAppNoSecret(false);

    const res = await mcpToolsCall(app, 'teamem.get_briefing', {});

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('auth_unavailable');

    if (origEnv !== undefined) process.env.TEAMEM_ALLOW_NO_AUTH = origEnv;
  });

  it('(b) with TEAMEM_ALLOW_NO_AUTH=1 → tool call succeeds, body scope keys scrubbed', async () => {
    process.env.TEAMEM_ALLOW_NO_AUTH = '1';

    try {
      const { app, db } = buildAppNoSecret(true);

      // Caller tries to supply space_id in arguments → should get 400 scope-scrub rejection
      const res = await mcpToolsCall(app, 'teamem.get_briefing', {
        space_id: 'caller-injected'
      });

      // Body scrub still applies even in no-auth mode
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: { code: number } };
      expect(body.error?.code).toBe(-32602);
      void db;
    } finally {
      delete process.env.TEAMEM_ALLOW_NO_AUTH;
    }
  });
});

// AC15: registry NOT consulted before auth check
describe('AC15 — registry not consulted before auth', () => {
  it('unauthenticated tools/call for non-existent tool → 401, not 404', async () => {
    const { app } = buildApp();

    // No Authorization header — should get 401, not 404
    // This verifies auth runs BEFORE tool-registry lookup (security invariant)
    const res = await mcpToolsCall(app, 'teamem.does_not_exist', {});

    expect(res.status).toBe(401);
    // Must NOT be 404 (which would imply registry was consulted)
    expect(res.status).not.toBe(404);
  });
});

// AC15b: non-allowlisted method without auth → 401
describe('AC15b — resources/list without auth → 401', () => {
  it('returns 401 for resources/list (not in UNAUTH allowlist)', async () => {
    const { app } = buildApp();

    const res = await app.request('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'resources/list',
        params: {}
      })
    });

    expect(res.status).toBe(401);
  });
});
