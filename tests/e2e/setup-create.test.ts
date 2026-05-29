/**
 * E2E: AC11 + AC24 — setup create flow (non-interactive).
 *
 * Spins up an in-process Hono server on a real TCP port, then invokes
 * setup.ts via --json flag (non-interactive mode).
 *
 * Asserts:
 *   - credentials.json written with mode 0600 (AC11)
 *   - one space entry present (AC11)
 *   - stdout contains AC24 warning string within output near the code (AC24)
 */
import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { runAllMigrations } from '../helpers/migrations.js';
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises';
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
const AC24_WARNING =
  '(share via SECURE channel only — Signal/1Password/in-person)';

let tmpDir: string;
let server: Awaited<ReturnType<typeof startHonoTestServer>>['server'];
let serverPort: number;

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
  tmpDir = await mkdtemp(join(tmpdir(), 'teamem-setup-e2e-'));
  const started = await startHonoTestServer(buildApp());
  server = started.server;
  serverPort = started.port;
});

afterEach(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  await rm(tmpDir, { recursive: true, force: true });
});

describe('AC11 + AC24 — setup create flow', () => {
  it('creates space, writes credentials.json mode 0600, entry correct, AC24 warning present', async () => {
    const credPath = join(tmpDir, 'credentials.json');
    const serverUrl = `http://127.0.0.1:${serverPort}`;

    const result = await runSetup({
      serverUrl,
      flow: 'create',
      memberName: 'alice',
      spaceLabel: 'my-team',
      credPath
    });

    // AC11: file exists
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

    // AC11: mode 0600
    const { mode } = await stat(credPath);
    expect(mode & 0o777).toBe(0o600);

    // AC11: one space entry with correct member_name
    const raw = await readFile(credPath, 'utf-8');
    const creds = JSON.parse(raw) as {
      version: number;
      default_space_id: string;
      spaces: Record<
        string,
        { member_name: string; label: string; jwt: string; server_url: string }
      >;
    };
    expect(creds.version).toBe(1);
    const entries = Object.values(creds.spaces);
    expect(entries).toHaveLength(1);
    expect(entries[0].member_name).toBe('alice');
    expect(entries[0].label).toBe('my-team');
    expect(entries[0].server_url).toBe(serverUrl);
    expect(entries[0].jwt).toBeTruthy();

    // AC24: warning string present in stdout
    expect(result.stdout).toContain(AC24_WARNING);
    expect(result.stdout).toContain(
      `Space created. Credentials saved to ${credPath}.`
    );

    // AC24: warning within 3 lines of the code line
    const lines = result.stdout.split('\n');
    const codeLineIdx = lines.findIndex((l) => l.includes('Your room code:'));
    const warnLineIdx = lines.findIndex((l) => l.includes(AC24_WARNING));
    expect(codeLineIdx).toBeGreaterThanOrEqual(0);
    expect(warnLineIdx).toBeGreaterThanOrEqual(0);
    expect(Math.abs(warnLineIdx - codeLineIdx)).toBeLessThanOrEqual(3);
  });

  it('prints the default credentials path when no explicit path is provided', async () => {
    const homeDir = join(tmpDir, 'home');
    const defaultCredPath = join(homeDir, '.teamem', 'credentials.json');
    const serverUrl = `http://127.0.0.1:${serverPort}`;

    const result = await runSetup(
      {
        serverUrl,
        flow: 'create',
        memberName: 'alice',
        spaceLabel: 'default-path-team'
      },
      { HOME: homeDir, TEAMEM_CREDENTIALS: undefined }
    );

    expect(result.exitCode).toBe(0);
    await expect(stat(defaultCredPath)).resolves.toBeTruthy();
    expect(result.stdout).toContain(
      `Space created. Credentials saved to ${defaultCredPath}.`
    );
  });

  it('prints the TEAMEM_CREDENTIALS path when creating with profile-scoped credentials', async () => {
    const credPath = join(tmpDir, 'dev-profiles', 'alice', 'credentials.json');
    const serverUrl = `http://127.0.0.1:${serverPort}`;

    const result = await runSetup(
      {
        serverUrl,
        flow: 'create',
        memberName: 'alice',
        spaceLabel: 'profile-path-team'
      },
      { TEAMEM_CREDENTIALS: credPath }
    );

    expect(result.exitCode).toBe(0);
    await expect(stat(credPath)).resolves.toBeTruthy();
    expect(result.stdout).toContain(
      `Space created. Credentials saved to ${credPath}.`
    );
  });

  it('re-running with existing credentials still creates another entry', async () => {
    const credPath = join(tmpDir, 'credentials.json');
    const serverUrl = `http://127.0.0.1:${serverPort}`;

    // First create
    await runSetup({
      serverUrl,
      flow: 'create',
      memberName: 'alice',
      spaceLabel: 'team-a',
      credPath
    });

    // Second create (adds another space)
    const result2 = await runSetup({
      serverUrl,
      flow: 'create',
      memberName: 'alice',
      spaceLabel: 'team-b',
      credPath
    });
    expect(result2.exitCode).toBe(0);

    const raw = await readFile(credPath, 'utf-8');
    const creds = JSON.parse(raw) as { spaces: Record<string, unknown> };
    expect(Object.keys(creds.spaces)).toHaveLength(2);
  });

  // Security review P2#3: when no explicit label is passed, the server stores
  // `<member>'s space` as the label. The CLI must persist that exact server-side
  // value so a later `bun run space disband`'s `label_confirmation` matches.
  // Before the fix the CLI fell back to the ULID, which guaranteed a 400
  // `label_mismatch` and locked the creator out of disband.
  it('default-label flow saves server-side label, not the space_id', async () => {
    const credPath = join(tmpDir, 'credentials.json');
    const serverUrl = `http://127.0.0.1:${serverPort}`;

    const result = await runSetup({
      serverUrl,
      flow: 'create',
      memberName: 'bob',
      // intentionally NO spaceLabel — exercise the server's default
      credPath
    });
    expect(result.exitCode).toBe(0);

    const raw = await readFile(credPath, 'utf-8');
    const creds = JSON.parse(raw) as {
      spaces: Record<string, { label: string; space_id: string }>;
    };
    const entry = Object.values(creds.spaces)[0];
    expect(entry.label).toBe("bob's space");
    expect(entry.label).not.toBe(entry.space_id);
  });
});
