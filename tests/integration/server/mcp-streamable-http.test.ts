/**
 * AC32 + AC34 — MCP Streamable HTTP transport: session lifecycle, origin allowlist,
 * protocol version negotiation, DELETE termination.
 */
import { describe, expect, it, beforeEach } from 'bun:test';
import { runAllMigrations } from '../../helpers/migrations.js';

import { Hono } from 'hono';
import { createSqliteClient } from '../../../src/infra/db/sqlite-client.js';
import { SqliteEventStore } from '../../../src/infra/db/sqlite-event-store.js';
import { createTeamemTools } from '../../../src/server/tools/index.js';
import { createRouter } from '../../../src/server/routes.js';
import { resetRateLimitBuckets } from '../../../src/server/rate-limit.js';

const TEST_JWT_SECRET = 'test-secret-32bytes-padded-xxxxx';

function buildApp(opts?: { trustedOrigins?: string[] }) {
  resetRateLimitBuckets();
  const db = createSqliteClient(':memory:');
  runAllMigrations(db);
  const store = new SqliteEventStore(db);
  const tools = createTeamemTools({ db, store });
  const router = createRouter(tools, db, TEST_JWT_SECRET, opts?.trustedOrigins);
  const app = new Hono();
  app.route('/', router);
  return { app, db };
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

async function postMcp(
  app: Hono,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<Response> {
  return app.request('/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });
}

async function initialize(app: Hono, extraHeaders?: Record<string, string>) {
  const res = await postMcp(
    app,
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    extraHeaders
  );
  const sessionId = res.headers.get('MCP-Session-Id');
  const body = (await res.json()) as {
    jsonrpc: string;
    id: number;
    result: {
      protocolVersion: string;
      capabilities: unknown;
      serverInfo: { name: string; version: string };
    };
  };
  return { res, sessionId, body };
}

beforeEach(() => {
  resetRateLimitBuckets();
});

describe('AC32 — MCP session bring-up', () => {
  it('POST /mcp initialize returns 200, MCP-Session-Id header, and InitializeResponse body', async () => {
    const { app } = buildApp();
    const { res, sessionId, body } = await initialize(app);

    expect(res.status).toBe(200);
    expect(sessionId).toBeTruthy();
    expect(typeof sessionId).toBe('string');
    expect(sessionId!.length).toBeGreaterThan(0);

    expect(body.jsonrpc).toBe('2.0');
    expect(body.id).toBe(1);
    expect(body.result.protocolVersion).toBeTruthy();
    expect(body.result.serverInfo.name).toBe('teamem-bridge');
    expect(body.result.capabilities).toBeTruthy();
  });

  it('subsequent tools/call POST with MCP-Session-Id succeeds (200, not 404)', async () => {
    const { app } = buildApp();
    const { jwt } = await bootstrapMember(app);
    const { sessionId } = await initialize(app);

    const res = await postMcp(
      app,
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'teamem.get_updates', arguments: {} }
      },
      { 'MCP-Session-Id': sessionId!, Authorization: `Bearer ${jwt}` }
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { jsonrpc: string; result: unknown };
    expect(body.jsonrpc).toBe('2.0');
  });

  it('tools/call awaits async registry handlers before serializing JSON-RPC results', async () => {
    const { app } = buildApp();
    const { jwt } = await bootstrapMember(app);
    const { sessionId } = await initialize(app);

    const res = await postMcp(
      app,
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'teamem.request_edit_permission',
          arguments: {
            blocking_claim_id: 'missing-claim',
            paths: ['src/server/routes.ts']
          }
        }
      },
      { 'MCP-Session-Id': sessionId!, Authorization: `Bearer ${jwt}` }
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      jsonrpc: string;
      id: number;
      result: { ok: false; error: { code: string } };
    };
    expect(body.jsonrpc).toBe('2.0');
    expect(body.id).toBe(3);
    expect(body.result.ok).toBe(false);
    expect(body.result.error.code).toBe('blocking_claim_not_active');
  });

  it('tools/call preserves sync registry handler response shape', async () => {
    const { app } = buildApp();
    const { jwt } = await bootstrapMember(app);
    const { sessionId } = await initialize(app);

    const res = await postMcp(
      app,
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'teamem.space_rotate_code', arguments: {} }
      },
      { 'MCP-Session-Id': sessionId!, Authorization: `Bearer ${jwt}` }
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      jsonrpc: string;
      id: number;
      result: { ok: true; data: { room_code: string; rotated_at: string } };
    };
    expect(body.jsonrpc).toBe('2.0');
    expect(body.id).toBe(4);
    expect(body.result.ok).toBe(true);
    expect(body.result.data.room_code).toMatch(/^[A-Za-z0-9_-]{8}$/);
    expect(Date.parse(body.result.data.rotated_at)).not.toBeNaN();
  });

  it('tools/call returns a JSON-RPC invalid-params error for malformed tool arguments', async () => {
    const { app } = buildApp();
    const { jwt } = await bootstrapMember(app);
    const { sessionId } = await initialize(app);

    const res = await postMcp(
      app,
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'teamem.claim_scope', arguments: {} }
      },
      { 'MCP-Session-Id': sessionId!, Authorization: `Bearer ${jwt}` }
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      jsonrpc: string;
      id: number;
      error: { code: number; data: { code: string } };
    };
    expect(body.jsonrpc).toBe('2.0');
    expect(body.id).toBe(5);
    expect(body.error.code).toBe(-32602);
    expect(body.error.data.code).toBe('invalid_tool_arguments');
  });

  it('notifications/initialized with valid session returns 202', async () => {
    const { app } = buildApp();
    const { sessionId } = await initialize(app);

    const res = await postMcp(
      app,
      { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
      { 'MCP-Session-Id': sessionId! }
    );

    expect(res.status).toBe(202);
  });
});

describe('AC34 — unknown MCP-Session-Id returns 404', () => {
  it('POST with unknown MCP-Session-Id returns 404 session_not_found', async () => {
    const { app } = buildApp();
    const { jwt } = await bootstrapMember(app);

    const res = await postMcp(
      app,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'teamem.get_updates', arguments: {} }
      },
      {
        'MCP-Session-Id': 'non-existent-session-id-00000000',
        Authorization: `Bearer ${jwt}`
      }
    );

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('session_not_found');
  });

  it('notifications/initialized with unknown session returns 404', async () => {
    const { app } = buildApp();

    const res = await postMcp(
      app,
      { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
      { 'MCP-Session-Id': 'dead-session-id-000000000000000' }
    );

    expect(res.status).toBe(404);
  });
});

describe('AC32 — DELETE /mcp terminates session', () => {
  it('DELETE /mcp with valid session returns 204, subsequent POST returns 404', async () => {
    const { app } = buildApp();
    const { jwt } = await bootstrapMember(app);
    const { sessionId } = await initialize(app);

    const deleteRes = await app.request('/mcp', {
      method: 'DELETE',
      headers: {
        'MCP-Session-Id': sessionId!,
        Authorization: `Bearer ${jwt}`
      }
    });
    expect(deleteRes.status).toBe(204);

    // Subsequent POST with that session should return 404 (auth runs before session check)
    const postRes = await postMcp(
      app,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'teamem.get_updates', arguments: {} }
      },
      { 'MCP-Session-Id': sessionId!, Authorization: `Bearer ${jwt}` }
    );
    expect(postRes.status).toBe(404);
  });

  it('DELETE /mcp without session id returns 400', async () => {
    const { app } = buildApp();
    const res = await app.request('/mcp', { method: 'DELETE' });
    expect(res.status).toBe(400);
  });

  it('DELETE /mcp with unknown session returns 404', async () => {
    const { app } = buildApp();
    const res = await app.request('/mcp', {
      method: 'DELETE',
      headers: { 'MCP-Session-Id': 'ghost-session-0000000000000000' }
    });
    expect(res.status).toBe(404);
  });
});

describe('AC32 — Origin allowlist enforcement', () => {
  it('request with disallowed Origin returns 403 forbidden_origin', async () => {
    const { app } = buildApp({ trustedOrigins: ['https://test.local'] });

    const res = await postMcp(
      app,
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { Origin: 'https://attacker.com' }
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('forbidden_origin');
  });

  it('request with allowed Origin succeeds', async () => {
    const { app } = buildApp({ trustedOrigins: ['https://test.local'] });

    const res = await postMcp(
      app,
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { Origin: 'https://test.local' }
    );

    expect(res.status).toBe(200);
  });

  it('request with no Origin header is allowed when trustedOrigins is empty', async () => {
    const { app } = buildApp();

    const res = await postMcp(app, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {}
    });

    expect(res.status).toBe(200);
  });
});

describe('AC32 — MCP-Protocol-Version header handling', () => {
  it('explicit MCP-Protocol-Version is echoed back in response', async () => {
    const { app } = buildApp();

    const res = await postMcp(
      app,
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { 'MCP-Protocol-Version': '2025-03-26' }
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('MCP-Protocol-Version')).toBe('2025-03-26');
  });

  it('missing MCP-Protocol-Version proceeds with server default (no error)', async () => {
    const { app } = buildApp();

    const res = await postMcp(app, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {}
    });

    expect(res.status).toBe(200);
    // No MCP-Protocol-Version header echoed back when client didn't send one
    expect(res.headers.get('MCP-Protocol-Version')).toBeNull();
  });
});

describe('AC32 — unknown method returns JSON-RPC error', () => {
  it('unknown method returns 404 with JSON-RPC error object', async () => {
    const { app } = buildApp();
    const { jwt } = await bootstrapMember(app);

    const res = await postMcp(
      app,
      {
        jsonrpc: '2.0',
        id: 99,
        method: 'unknown/method',
        params: {}
      },
      { Authorization: `Bearer ${jwt}` }
    );

    expect(res.status).toBe(404);
    const body = (await res.json()) as {
      jsonrpc: string;
      id: number;
      error: { code: number; message: string };
    };
    expect(body.jsonrpc).toBe('2.0');
    expect(body.id).toBe(99);
    expect(body.error.code).toBe(-32601);
  });
});
