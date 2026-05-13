/**
 * AC16 — Auth-check log rate-limit: at most 1 `auth_check` log line per IP per 60s.
 *
 * Fires 100 unauthenticated POST /mcp tools/call requests and captures stdout.
 * Asserts at most 1 auth_check line is emitted (per-IP rate-limit, 1/60s).
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
  return app;
}

beforeEach(() => {
  resetRateLimitBuckets();
  resetAuthCheckLogBuckets();
});

describe('AC16 — auth_check log rate-limit (1/IP/60s)', () => {
  it('100 unauthenticated requests emit at most 1 auth_check log line', async () => {
    const app = buildApp();

    const authCheckLines: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      const line = args.map(String).join(' ');
      if (line.includes('auth_check')) {
        authCheckLines.push(line);
      }
      originalLog(...args);
    };

    try {
      // Fire 100 unauthenticated POST /mcp tools/call requests
      const requests = Array.from({ length: 100 }, () =>
        app.request('/mcp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'teamem.get_briefing', arguments: {} }
          })
        })
      );

      const responses = await Promise.all(requests);

      // All should be 401
      for (const res of responses) {
        expect(res.status).toBe(401);
      }

      // At most 1 auth_check log line (per-IP bucket is keyed to 'no-ip' in tests)
      expect(authCheckLines.length).toBeLessThanOrEqual(1);
    } finally {
      console.log = originalLog;
    }
  });

  it('resetAuthCheckLogBuckets clears rate-limit state so next request logs again', async () => {
    const app = buildApp();

    const authCheckLines: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      const line = args.map(String).join(' ');
      if (line.includes('auth_check')) authCheckLines.push(line);
      originalLog(...args);
    };

    try {
      // First request → should log
      await app.request('/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'teamem.get_briefing', arguments: {} }
        })
      });

      const afterFirst = authCheckLines.length;
      expect(afterFirst).toBe(1);

      // Second request without reset → should NOT log (still in window)
      await app.request('/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'teamem.get_briefing', arguments: {} }
        })
      });

      expect(authCheckLines.length).toBe(1); // still 1

      // Reset buckets → next request logs again
      resetAuthCheckLogBuckets();

      await app.request('/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'teamem.get_briefing', arguments: {} }
        })
      });

      expect(authCheckLines.length).toBe(2);
    } finally {
      console.log = originalLog;
    }
  });
});
