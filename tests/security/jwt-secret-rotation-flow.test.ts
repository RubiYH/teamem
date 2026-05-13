import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { Hono } from 'hono';
import {
  createSqliteClient,
  runMigration
} from '../../src/infra/db/sqlite-client.js';
import { SqliteEventStore } from '../../src/infra/db/sqlite-event-store.js';
import { createTeamemTools } from '../../src/server/tools/index.js';
import { createRouter } from '../../src/server/routes.js';
import { createRequireMemberMiddleware } from '../../src/server/auth.js';
import { signJwt } from '../../src/server/jwt.js';
import { resetRateLimitBuckets } from '../../src/server/rate-limit.js';

const SECRET_V1 = 'old-jwt-secret-32bytes-padded-xx';
const SECRET_V2 = 'new-jwt-secret-32bytes-padded-xx';

function setupApp(
  jwtSecret: string,
  db: ReturnType<typeof createSqliteClient>
) {
  resetRateLimitBuckets();
  const store = new SqliteEventStore(db);
  const tools = createTeamemTools({ db, store });
  const router = createRouter(tools, db, jwtSecret);
  const requireMember = createRequireMemberMiddleware(jwtSecret, db);

  const app = new Hono();
  app.use('/tools/*', requireMember);
  app.route('/', router);
  return app;
}

async function post(app: Hono, path: string, body: unknown, token?: string) {
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

describe('JWT secret rotation flow', () => {
  it('existing JWT becomes invalid after secret rotation; new JWT from new secret works', async () => {
    const db = createSqliteClient(':memory:');
    const migrationsDir = join(process.cwd(), 'src/infra/db/migrations');
    runMigration(db, join(migrationsDir, '001_init.sql'));
    runMigration(db, join(migrationsDir, '002_decisions_kind_and_indexes.sql'));
    runMigration(db, join(migrationsDir, '003_room_codes_and_members.sql'));

    const SPACE_ID = 'rotation-space-001';
    const MEMBER_NAME = 'alice';
    db.run(
      `INSERT INTO spaces (id, label, creator_member_id, created_at) VALUES (?, ?, ?, ?)`,
      [SPACE_ID, 'test', 'm001', new Date().toISOString()]
    );
    db.run(
      `INSERT INTO members (id, space_id, name, joined_at, is_creator) VALUES (?, ?, ?, ?, ?)`,
      ['m001', SPACE_ID, MEMBER_NAME, new Date().toISOString(), 1]
    );

    // Issue JWT with old secret
    const oldJwt = await signJwt(
      { sub: MEMBER_NAME, space_id: SPACE_ID },
      SECRET_V1
    );

    // Old server accepts old JWT (space_id is injected from JWT, not body)
    const appV1 = setupApp(SECRET_V1, db);
    const resOk = await post(appV1, '/tools/teamem.get_updates', {}, oldJwt);
    expect(resOk.status).toBe(200);

    // Rotate secret — simulate server restart with new secret
    const appV2 = setupApp(SECRET_V2, db);

    // Old JWT rejected by new server
    const resRejected = await post(
      appV2,
      '/tools/teamem.get_updates',
      {},
      oldJwt
    );
    expect(resRejected.status).toBe(401);

    // Re-setup: issue new JWT with new secret (simulates member running setup again)
    const newJwt = await signJwt(
      { sub: MEMBER_NAME, space_id: SPACE_ID },
      SECRET_V2
    );
    const resNew = await post(appV2, '/tools/teamem.get_updates', {}, newJwt);
    expect(resNew.status).toBe(200);
  });
});
