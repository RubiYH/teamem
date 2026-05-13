import { join } from 'node:path';
import { Hono } from 'hono';
import { createSqliteClient } from '../../../src/infra/db/sqlite-client.js';
import { SqliteEventStore } from '../../../src/infra/db/sqlite-event-store.js';
import { createTeamemTools } from '../../../src/server/tools/index.js';
import { createRouter } from '../../../src/server/routes.js';
import { createRequireMemberMiddleware } from '../../../src/server/auth.js';
import { resetRateLimitBuckets } from '../../../src/server/rate-limit.js';

export const TEST_JWT_SECRET = 'test-secret-32bytes-padded-xxxxx';

export function setupAuthApp() {
  resetRateLimitBuckets();

  const db = createSqliteClient(':memory:');
  // Apply all migrations (matches production migration runner: read every
  // .sql file in src/infra/db/migrations sorted by name).
  const { readFileSync, readdirSync } = require('node:fs');
  const migDir = join(process.cwd(), 'src/infra/db/migrations');
  const files = (readdirSync(migDir) as string[])
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const f of files) {
    const sql = readFileSync(join(migDir, f), 'utf-8');
    db.exec(sql);
  }

  const store = new SqliteEventStore(db);
  const tools = createTeamemTools({ db, store });
  const router = createRouter(tools, db, TEST_JWT_SECRET);
  const requireMember = createRequireMemberMiddleware(TEST_JWT_SECRET, db);

  const app = new Hono();
  app.get('/health', (c) => c.json({ ok: true }));
  app.use('/tools/*', requireMember);
  app.route('/', router);

  return { app, db };
}
