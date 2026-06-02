/**
 * E2E: AC11 — setup join flow (non-interactive).
 *
 * Pre-creates a space via the server, then runs setup --json join.
 */
import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { runAllMigrations } from '../helpers/migrations.js';
import { mkdtemp, rm, stat, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Hono } from 'hono';
import { startHonoTestServer } from '../helpers/http-server.js';
import { createSqliteClient } from '../../src/infra/db/sqlite-client.js';
import { SqliteEventStore } from '../../src/infra/db/sqlite-event-store.js';
import { createTeamemTools } from '../../src/server/tools/index.js';
import { createRouter } from '../../src/server/routes.js';
import { resetRateLimitBuckets } from '../../src/server/rate-limit.js';

const TEST_JWT_SECRET = 'test-secret-32bytes-padded-xxxxx';

let tmpDir: string;
let server: Awaited<ReturnType<typeof startHonoTestServer>>['server'];
let serverPort: number;
let roomCode: string;

function buildApp() {
  const db = createSqliteClient(':memory:');
  runAllMigrations(db);
  const store = new SqliteEventStore(db);
  const tools = createTeamemTools({ db, store });
  const router = createRouter(tools, db, TEST_JWT_SECRET);
  const app = new Hono();
  app.route('/', router);
  return app;
}

function buildSetupEnv(envOverrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TEAMEM_BRIDGE_DIR: process.cwd()
  };
  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
  return env;
}

function runSetup(
  jsonArgs: Record<string, unknown>,
  envOverrides: NodeJS.ProcessEnv = {}
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = spawn(
      'bun',
      ['run', 'src/cli/setup.ts', '--json', JSON.stringify(jsonArgs)],
      {
        cwd: process.cwd(),
        env: buildSetupEnv(envOverrides),
        stdio: ['pipe', 'pipe', 'pipe']
      }
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.stdin.end();
    child.on('exit', (code) =>
      resolve({ stdout, stderr, exitCode: code ?? 1 })
    );
  });
}

beforeEach(async () => {
  resetRateLimitBuckets();
  tmpDir = await mkdtemp(join(tmpdir(), 'teamem-join-e2e-'));

  const app = buildApp();
  const started = await startHonoTestServer(app);
  server = started.server;
  serverPort = started.port;

  // Pre-create a space to get a room code
  const res = await fetch(`http://127.0.0.1:${serverPort}/spaces`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ member_name: 'alice', label: 'test-team' })
  });
  const data = (await res.json()) as { room_code: string };
  roomCode = data.room_code;
});

afterEach(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  await rm(tmpDir, { recursive: true, force: true });
});

describe('AC11 — setup join flow', () => {
  it('joins space with valid room code and writes credentials.json', async () => {
    const credPath = join(tmpDir, 'credentials.json');
    const serverUrl = `http://127.0.0.1:${serverPort}`;

    const result = await runSetup({
      serverUrl,
      flow: 'join',
      memberName: 'bob',
      roomCode,
      credPath
    });

    let fileExists = false;
    try {
      await stat(credPath);
      fileExists = true;
    } catch {
      /* */
    }

    if (!fileExists) {
      console.error('stdout:', result.stdout);
      console.error('stderr:', result.stderr);
      console.error('exit:', result.exitCode);
    }

    expect(fileExists).toBe(true);
    expect(result.exitCode).toBe(0);

    // mode 0600
    const { mode } = await stat(credPath);
    expect(mode & 0o777).toBe(0o600);

    // one entry with bob
    const raw = await readFile(credPath, 'utf-8');
    const creds = JSON.parse(raw) as {
      version: number;
      spaces: Record<string, { member_name: string }>;
    };
    expect(creds.version).toBe(1);
    const entries = Object.values(creds.spaces);
    expect(entries).toHaveLength(1);
    expect(entries[0].member_name).toBe('bob');
    expect(result.stdout).toContain(`Credentials saved to ${credPath}.`);
  });

  it('prints the default credentials path when joining without an explicit path', async () => {
    const homeDir = join(tmpDir, 'home');
    const defaultCredPath = join(homeDir, '.teamem', 'credentials.json');
    const serverUrl = `http://127.0.0.1:${serverPort}`;

    const result = await runSetup(
      {
        serverUrl,
        flow: 'join',
        memberName: 'bob',
        roomCode
      },
      { HOME: homeDir, TEAMEM_CREDENTIALS: undefined }
    );

    expect(result.exitCode).toBe(0);
    await expect(stat(defaultCredPath)).resolves.toBeTruthy();
    expect(result.stdout).toContain(`Credentials saved to ${defaultCredPath}.`);
  });

  it('prints the TEAMEM_CREDENTIALS path when joining with profile-scoped credentials', async () => {
    const credPath = join(tmpDir, 'dev-profiles', 'alice', 'credentials.json');
    const serverUrl = `http://127.0.0.1:${serverPort}`;

    const result = await runSetup(
      {
        serverUrl,
        flow: 'join',
        memberName: 'bob',
        roomCode
      },
      { TEAMEM_CREDENTIALS: credPath }
    );

    expect(result.exitCode).toBe(0);
    await expect(stat(credPath)).resolves.toBeTruthy();
    expect(result.stdout).toContain(`Credentials saved to ${credPath}.`);
  });

  it('makes an explicitly joined space the default over stale credentials', async () => {
    const credPath = join(tmpDir, 'credentials.json');
    const serverUrl = `http://127.0.0.1:${serverPort}`;
    await writeFile(
      credPath,
      JSON.stringify(
        {
          version: 1,
          default_space_id: 'stale-space',
          spaces: {
            'stale-space': {
              space_id: 'stale-space',
              label: 'stale-local',
              member_name: 'old-user',
              jwt: 'stale.jwt.value',
              jwt_exp: Math.floor(Date.now() / 1000) + 3600,
              server_url: 'http://localhost:39999'
            }
          }
        },
        null,
        2
      ),
      'utf-8'
    );

    const result = await runSetup({
      serverUrl,
      flow: 'join',
      memberName: 'bob',
      roomCode,
      credPath
    });

    expect(result.exitCode).toBe(0);
    const raw = await readFile(credPath, 'utf-8');
    const creds = JSON.parse(raw) as {
      default_space_id: string;
      spaces: Record<string, { member_name: string; server_url: string }>;
    };
    expect(creds.default_space_id).not.toBe('stale-space');
    expect(creds.spaces[creds.default_space_id]?.member_name).toBe('bob');
    expect(creds.spaces[creds.default_space_id]?.server_url).toBe(serverUrl);
  });

  it('exits with code 1 and clear error message for invalid room code', async () => {
    const credPath = join(tmpDir, 'credentials.json');
    const serverUrl = `http://127.0.0.1:${serverPort}`;

    const result = await runSetup({
      serverUrl,
      flow: 'join',
      memberName: 'bob',
      roomCode: 'BADCODE1',
      credPath
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Invalid room code');
  });

  it('exits with code 1 and clear error message for name_taken', async () => {
    const credPath = join(tmpDir, 'credentials.json');
    const serverUrl = `http://127.0.0.1:${serverPort}`;

    // Try to join as alice (already creator)
    const result = await runSetup({
      serverUrl,
      flow: 'join',
      memberName: 'alice',
      roomCode,
      credPath
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('already taken');
  });
});
