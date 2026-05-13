/**
 * AC13 — End-to-end adversarial scenario: no Authorization + caller-supplied scope.
 *
 * Mirrors the exact attack curl scenario: POST /mcp tools/call without any
 * Authorization header, with caller-supplied scope keys in arguments.
 * Assert 401 and zero events written.
 */
import { describe, it, expect } from 'bun:test';
import { runAllMigrations } from '../helpers/migrations.js';

import { Hono } from 'hono';
import { createSqliteClient } from '../../src/infra/db/sqlite-client.js';
import { SqliteEventStore } from '../../src/infra/db/sqlite-event-store.js';
import { createTeamemTools } from '../../src/server/tools/index.js';
import { createRouter } from '../../src/server/routes.js';
import { resetRateLimitBuckets } from '../../src/server/rate-limit.js';
import { resetAuthCheckLogBuckets } from '../../src/server/auth.js';
import type { Database } from 'bun:sqlite';

const TEST_JWT_SECRET = 'test-secret-32bytes-padded-xxxxx';

function buildApp() {
  resetRateLimitBuckets();
  resetAuthCheckLogBuckets();
  const db = createSqliteClient(':memory:');
  runAllMigrations(db);
  const store = new SqliteEventStore(db);
  const tools = createTeamemTools({ db, store });
  const router = createRouter(tools, db, TEST_JWT_SECRET);
  const app = new Hono();
  app.route('/', router);
  return { app, db };
}

function countEvents(db: Database): number {
  return (db.prepare('SELECT COUNT(*) as n FROM events').get() as { n: number })
    .n;
}

describe('AC13 — auth bypass regression', () => {
  it('attack scenario: no auth + caller-supplied space_id → 401, zero events', async () => {
    const { app, db } = buildApp();
    const before = countEvents(db);

    // Exact attack: no Authorization, space_id injected in arguments
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'teamem.claim_scope',
          arguments: {
            space_id: 'attacker-controlled-space',
            principal: 'attacker',
            actor: 'attacker/agent',
            delegation: 'attacker->agent',
            scope: { paths: ['src/attack.ts'] },
            intent: 'ATTACK'
          }
        }
      })
    });

    expect(res.status).toBe(401);
    expect(countEvents(db)).toBe(before);
  });

  it('attack scenario: no auth + caller-supplied principal → 401, zero events', async () => {
    const { app, db } = buildApp();
    const before = countEvents(db);

    const res = await app.request('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'teamem.claim_scope',
          arguments: {
            principal: 'victim-principal',
            space_id: 'victim-space',
            scope: { paths: ['src/hijack.ts'] },
            intent: 'steal scope'
          }
        }
      })
    });

    expect(res.status).toBe(401);
    expect(countEvents(db)).toBe(before);
  });

  it('attack scenario: no auth + all five scope keys → 401, zero events', async () => {
    const { app, db } = buildApp();
    const before = countEvents(db);

    const res = await app.request('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'teamem.get_briefing',
          arguments: {
            space_id: 'evil',
            principal: 'evil',
            repo_id: 'evil',
            actor: 'evil',
            delegation: 'evil->evil'
          }
        }
      })
    });

    expect(res.status).toBe(401);
    expect(countEvents(db)).toBe(before);
  });

  it('initialize without auth still returns 200 (allowlisted)', async () => {
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
    expect(res.headers.get('MCP-Session-Id')).toBeTruthy();
  });
});
