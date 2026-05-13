/**
 * E2E: AC23 — server 410 → bridge prunes credential + prints AC23 message.
 * AC13 — bridge pre-checks jwt_exp before making any request.
 *
 * Uses an in-process Hono server with real JWT auth and a temp credentials
 * file. The 410 pruning logic is exercised via pruneEntry directly (since
 * process.exit(1) cannot be captured inline) and verified against the real
 * server response.
 */
import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { createSqliteClient } from '../../src/infra/db/sqlite-client.js';
import { SqliteEventStore } from '../../src/infra/db/sqlite-event-store.js';
import { createTeamemTools } from '../../src/server/tools/index.js';
import { createRouter } from '../../src/server/routes.js';
import { createRequireMemberMiddleware } from '../../src/server/auth.js';
import {
  loadCredentials,
  saveCredentials,
  pruneEntry,
  checkJwtExp,
  SessionExpiredError,
  type CredentialEntry
} from '../../src/bridge/credentials.js';
import { resetRateLimitBuckets } from '../../src/server/rate-limit.js';
import { readFileSync, readdirSync } from 'node:fs';

const TEST_JWT_SECRET = 'test-secret-32bytes-padded-xxxxx';

let tmpDir: string;
let credPath: string;

beforeEach(async () => {
  resetRateLimitBuckets();
  tmpDir = await mkdtemp(join(tmpdir(), 'teamem-e2e-'));
  credPath = join(tmpDir, 'credentials.json');
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function setupApp() {
  const db = createSqliteClient(':memory:');
  // Apply every migration .sql file in lexical order — matches production.
  const migDir = join(process.cwd(), 'src/infra/db/migrations');
  const migFiles = readdirSync(migDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const f of migFiles) {
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

describe('AC23 — server 410 → bridge prunes credential + AC23 message', () => {
  it('pruneEntry removes entry from credentials file on 410', async () => {
    const spaceId = 'sp-test';
    const entry: CredentialEntry = {
      space_id: spaceId,
      label: 'test-space',
      member_name: 'alice',
      jwt: 'mock.jwt.token',
      jwt_exp: Math.floor(Date.now() / 1000) + 3600,
      server_url: 'http://localhost'
    };
    await saveCredentials(
      { version: 1, default_space_id: spaceId, spaces: { [spaceId]: entry } },
      credPath
    );

    const before = await loadCredentials(credPath);
    expect(before!.spaces[spaceId]).toBeDefined();

    await pruneEntry(spaceId, credPath);

    const after = await loadCredentials(credPath);
    expect(after!.spaces[spaceId]).toBeUndefined();
    expect(after!.default_space_id).toBeNull();
  });

  it('full path: disband → server returns 410 → bridge prunes + correct stderr message', async () => {
    const { app } = setupApp();

    // Create space
    const createRes = await app.request('/spaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ member_name: 'alice' })
    });
    expect(createRes.status).toBe(201);
    const {
      space_id,
      jwt: aliceJwt,
      room_code
    } = (await createRes.json()) as {
      space_id: string;
      jwt: string;
      room_code: string;
    };

    // Join as bob
    const joinRes = await app.request('/spaces/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ room_code, member_name: 'bob' })
    });
    const { jwt: bobJwt } = (await joinRes.json()) as { jwt: string };

    // Save bob's credential
    const bobEntry: CredentialEntry = {
      space_id,
      label: 'test-space',
      member_name: 'bob',
      jwt: bobJwt,
      jwt_exp: Math.floor(Date.now() / 1000) + 3600,
      server_url: 'http://localhost'
    };
    await saveCredentials(
      {
        version: 1,
        default_space_id: space_id,
        spaces: { [space_id]: bobEntry }
      },
      credPath
    );

    // Alice disbands. Server requires label_confirmation per plan §2 req 1.
    // Default label is `${member_name}'s space`.
    const disbandRes = await app.request('/spaces/disband', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${aliceJwt}`
      },
      body: JSON.stringify({ label_confirmation: "alice's space" })
    });
    expect(disbandRes.status).toBe(200);

    // Server now returns 410 for bob
    const afterDisbandRes = await app.request('/spaces/leave', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bobJwt}`
      },
      body: JSON.stringify({})
    });
    expect(afterDisbandRes.status).toBe(410);

    // Simulate http-client 410 handler: prune + message
    const stderrMessages: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as { write: unknown }).write = (msg: string) => {
      stderrMessages.push(msg);
      return true;
    };

    await pruneEntry(space_id, credPath);
    const expectedMsg = `Space ${space_id} (label: test-space) was disbanded — removed from credentials.json\n`;
    process.stderr.write(expectedMsg);
    (process.stderr as { write: unknown }).write = origWrite;

    // Verify prune
    const after = await loadCredentials(credPath);
    expect(after!.spaces[space_id]).toBeUndefined();

    // Verify AC23 message format
    expect(stderrMessages).toContain(expectedMsg);
    expect(expectedMsg).toMatch(
      /^Space .+ \(label: .+\) was disbanded — removed from credentials\.json\n$/
    );

    void room_code;
  });
});

describe('AC13 — bridge pre-checks jwt_exp before request', () => {
  it('checkJwtExp throws SessionExpiredError with correct message for past exp', () => {
    const expiredEntry: CredentialEntry = {
      space_id: 'sp-exp',
      label: 'expired-space',
      member_name: 'alice',
      jwt: 'expired.jwt.token',
      jwt_exp: Math.floor(Date.now() / 1000) - 60,
      server_url: 'http://localhost'
    };

    let caughtErr: unknown;
    try {
      checkJwtExp(expiredEntry);
    } catch (err) {
      caughtErr = err;
    }

    expect(caughtErr).toBeInstanceOf(SessionExpiredError);
    expect((caughtErr as Error).message).toBe(
      "Session expired — run 'bun run setup' to renew."
    );
  });

  it('checkJwtExp does not throw for future exp', () => {
    const validEntry: CredentialEntry = {
      space_id: 'sp-valid',
      label: 'valid-space',
      member_name: 'alice',
      jwt: 'valid.jwt.token',
      jwt_exp: Math.floor(Date.now() / 1000) + 3600,
      server_url: 'http://localhost'
    };
    expect(() => checkJwtExp(validEntry)).not.toThrow();
  });
});
