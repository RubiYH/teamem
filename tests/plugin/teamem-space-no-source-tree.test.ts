/**
 * Codex F10 regression — `plugin/commands/space.md` must not gate
 * on `CLAUDE_PLUGIN_OPTION_TEAMEM_ROOT`, and the four governance MCP
 * tools (`teamem.space_leave`, `teamem.space_kick`,
 * `teamem.space_rotate_code`, plus the existing `teamem.space_disband`)
 * must surface in `TOOL_BINDINGS`.
 *
 * Plus: end-to-end coverage that the new tools actually work against an
 * in-process server. We don't go through MCP — we hit the underlying HTTP
 * routes directly (those are what the MCP bindings shell to) and assert
 * the responses match what the slash command branches on.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Hono } from 'hono';
import { runAllMigrations } from '../helpers/migrations.js';
import { createSqliteClient } from '../../src/infra/db/sqlite-client.js';
import { SqliteEventStore } from '../../src/infra/db/sqlite-event-store.js';
import { createTeamemTools } from '../../src/server/tools/index.js';
import { createRouter } from '../../src/server/routes.js';
import { createRequireMemberMiddleware } from '../../src/server/auth.js';
import { resetRateLimitBuckets } from '../../src/server/rate-limit.js';
import { TOOL_BINDINGS } from '../../src/bridge/tool-bindings.js';

const TEST_JWT_SECRET = 'test-secret-32bytes-padded-xxxxx';

const SLASH_PATH = resolve(import.meta.dir, '../../plugin/commands/space.md');
const RESET_PATH = resolve(import.meta.dir, '../../plugin/commands/reset.md');

function buildApp() {
  resetRateLimitBuckets();
  const db = createSqliteClient(':memory:');
  runAllMigrations(db);
  const store = new SqliteEventStore(db);
  const tools = createTeamemTools({ db, store });
  const router = createRouter(tools, db, TEST_JWT_SECRET);
  const requireMember = createRequireMemberMiddleware(TEST_JWT_SECRET, db);
  const app = new Hono();
  // Mirror the production wiring in src/server/index.ts: `/tools/*` is
  // gated by the JWT middleware so kick / leave reject subsequent calls.
  app.use('/tools/*', requireMember);
  app.route('/', router);
  return { app, db };
}

async function post(app: Hono, path: string, body: unknown, jwt?: string) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json'
  };
  if (jwt) headers.Authorization = `Bearer ${jwt}`;
  return app.request(path, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
}

async function bootstrap(app: Hono, member_name: string, label: string) {
  const res = await post(app, '/spaces', { member_name, label });
  expect(res.status).toBe(201);
  return (await res.json()) as {
    space_id: string;
    jwt: string;
    label: string;
    room_code: string;
  };
}

describe('teamem-space slash command works without source-tree config (Codex F10a)', () => {
  it('slash command body has no functional CLAUDE_PLUGIN_OPTION_TEAMEM_ROOT precondition', () => {
    const text = readFileSync(SLASH_PATH, 'utf-8');
    // Strip frontmatter + line comments.
    const body = text.replace(/^---\n[\s\S]*?\n---\n/, '');
    expect(body).not.toContain('CLAUDE_PLUGIN_OPTION_TEAMEM_ROOT');
    expect(body).not.toContain('cd "${CLAUDE_PLUGIN_OPTION_TEAMEM_ROOT}"');
    expect(body).not.toContain('bun run space ');
  });

  it('slash command references the new MCP tools', () => {
    const text = readFileSync(SLASH_PATH, 'utf-8');
    expect(text).toContain('mcp__teamem__space_leave');
    expect(text).toContain('mcp__teamem__space_kick');
    expect(text).toContain('mcp__teamem__space_rotate_code');
  });

  it('TOOL_BINDINGS exposes the four new space tools', () => {
    expect(TOOL_BINDINGS['teamem.space_leave']).toBeDefined();
    expect(TOOL_BINDINGS['teamem.space_kick']).toBeDefined();
    expect(TOOL_BINDINGS['teamem.space_rotate_code']).toBeDefined();
    // Pre-existing — sanity-check their continued presence.
    expect(TOOL_BINDINGS['teamem.space_disband']).toBeDefined();
    expect(TOOL_BINDINGS['teamem.space_restore']).toBeDefined();
  });
});

describe('teamem-space MCP tools work end-to-end (Codex F10a)', () => {
  it('rotate-code returns a fresh code', async () => {
    const { app } = buildApp();
    const space = await bootstrap(app, 'alice', 'rotate-test');
    const original = space.room_code;
    const res = await post(app, '/spaces/rotate-code', {}, space.jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { room_code: string };
    expect(body.room_code).toMatch(/^[A-Za-z0-9_-]{8}$/);
    expect(body.room_code).not.toBe(original);
  });

  it('kick returns 200 for creator + valid target; 401 for kicked member after', async () => {
    const { app } = buildApp();
    const alice = await bootstrap(app, 'alice', 'kick-test');
    const join = await post(app, '/spaces/join', {
      room_code: alice.room_code,
      member_name: 'bob'
    });
    expect(join.status).toBe(200);
    const bob = (await join.json()) as { jwt: string };

    const kick = await post(
      app,
      '/spaces/kick',
      { member_name: 'bob' },
      alice.jwt
    );
    expect(kick.status).toBe(200);

    // Bob's next call should reject.
    const probe = await post(app, '/tools/teamem.get_briefing', {}, bob.jwt);
    expect(probe.status).toBe(401);
  });

  it('leave by creator returns 409 creator_must_disband', async () => {
    const { app } = buildApp();
    const alice = await bootstrap(app, 'alice', 'leave-test');
    const res = await post(app, '/spaces/leave', {}, alice.jwt);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('creator_must_disband');
  });

  it('leave by non-creator member returns 200 and rejects subsequent calls', async () => {
    const { app } = buildApp();
    const alice = await bootstrap(app, 'alice', 'leave-success');
    const join = await post(app, '/spaces/join', {
      room_code: alice.room_code,
      member_name: 'bob'
    });
    const bob = (await join.json()) as { jwt: string };

    const leave = await post(app, '/spaces/leave', {}, bob.jwt);
    expect(leave.status).toBe(200);

    const probe = await post(app, '/tools/teamem.get_briefing', {}, bob.jwt);
    expect(probe.status).toBe(401);
  });
});

describe('teamem-reset slash command is documented as source-checkout-only (Codex F10b)', () => {
  it('body explicitly tells marketplace users about the manual fallback', () => {
    const text = readFileSync(RESET_PATH, 'utf-8');
    // Negative — the gate-on-TEAMEM_ROOT path is gone.
    expect(text).not.toContain(
      'cd "${CLAUDE_PLUGIN_OPTION_TEAMEM_ROOT}" && bun run reset'
    );
    // Positive — marketplace fallback is documented.
    expect(text).toContain('Marketplace-installed users');
    expect(text).toContain('rm -f ~/.teamem/credentials.json');
    expect(text).toContain('teamem-flag');
  });
});

// ---------------------------------------------------------------------------
// Codex F13 — server tool registry exposes the new governance tools so MCP
// transport (`POST /mcp` `tools/call`) can invoke them. Pre-#20 the bridge
// bindings were in place but the server registry was missing the entries,
// so MCP-transport users got `Tool not found`.
// ---------------------------------------------------------------------------

async function mcpInit(app: Hono) {
  const init = await app.request('/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {}
    })
  });
  expect(init.status).toBe(200);
  const sessionId = init.headers.get('MCP-Session-Id');
  expect(sessionId).not.toBeNull();
  return sessionId!;
}

async function mcpToolsCall(
  app: Hono,
  sessionId: string,
  jwt: string,
  name: string,
  args: Record<string, unknown> = {}
) {
  return app.request('/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${jwt}`,
      'MCP-Session-Id': sessionId
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name, arguments: args }
    })
  });
}

describe('teamem space MCP tools route through /mcp tools/call (Codex F13)', () => {
  it('teamem.space_rotate_code returns a fresh room code via MCP transport', async () => {
    const { app } = buildApp();
    const space = await bootstrap(app, 'alice', 'mcp-rotate');
    const sid = await mcpInit(app);
    const res = await mcpToolsCall(
      app,
      sid,
      space.jwt,
      'teamem.space_rotate_code',
      {}
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { ok: true; data: { room_code: string; rotated_at: string } };
    };
    expect(body.result.ok).toBe(true);
    expect(body.result.data.room_code).toMatch(/^[A-Za-z0-9_-]{8}$/);
    expect(body.result.data.room_code).not.toBe(space.room_code);
  });

  it('teamem.space_kick removes the named member via MCP transport', async () => {
    const { app } = buildApp();
    const alice = await bootstrap(app, 'alice', 'mcp-kick');
    const join = await post(app, '/spaces/join', {
      room_code: alice.room_code,
      member_name: 'bob'
    });
    expect(join.status).toBe(200);
    const bob = (await join.json()) as { jwt: string };

    const sid = await mcpInit(app);
    const res = await mcpToolsCall(app, sid, alice.jwt, 'teamem.space_kick', {
      member_name: 'bob'
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { ok: boolean } };
    expect(body.result.ok).toBe(true);

    const probe = await post(app, '/tools/teamem.get_briefing', {}, bob.jwt);
    expect(probe.status).toBe(401);
  });

  it('teamem.space_leave by creator returns creator_must_disband via MCP transport', async () => {
    const { app } = buildApp();
    const alice = await bootstrap(app, 'alice', 'mcp-leave-creator');
    const sid = await mcpInit(app);
    const res = await mcpToolsCall(
      app,
      sid,
      alice.jwt,
      'teamem.space_leave',
      {}
    );
    // The MCP envelope returns 200 even for typed `ok:false` errors —
    // the per-tool typed error is in the JSON-RPC `result.error.code`.
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { ok: false; error: { code: string } };
    };
    expect(body.result.ok).toBe(false);
    expect(body.result.error.code).toBe('creator_must_disband');
  });

  it('teamem.space_leave by member succeeds via MCP transport', async () => {
    const { app } = buildApp();
    const alice = await bootstrap(app, 'alice', 'mcp-leave-member');
    const join = await post(app, '/spaces/join', {
      room_code: alice.room_code,
      member_name: 'bob'
    });
    const bob = (await join.json()) as { jwt: string };

    const sid = await mcpInit(app);
    const res = await mcpToolsCall(app, sid, bob.jwt, 'teamem.space_leave', {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { ok: true } };
    expect(body.result.ok).toBe(true);
  });

  it('TOOL_NAMES on the server side includes the three new governance tools', () => {
    // Imported lazily to avoid pulling the registry into the F10 group above.

    const { TOOL_NAMES } = require('../../src/server/tool-registry') as {
      TOOL_NAMES: readonly string[];
    };
    expect(TOOL_NAMES).toContain('teamem.space_leave');
    expect(TOOL_NAMES).toContain('teamem.space_kick');
    expect(TOOL_NAMES).toContain('teamem.space_rotate_code');
  });
});
