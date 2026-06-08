/**
 * Codex F5 regression — `bun run setup` must succeed for fresh marketplace
 * users with no `TEAMEM_BRIDGE_DIR` env var, no `bridge_dir` in
 * credentials.json, and no source-checkout markers.
 *
 * Original bug: `enforceBridgeDir` exited 2 unless `bridge_dir` was
 * resolvable, telling the user to run the deleted `bun run hook-install`.
 * A clean plugin user — the supported v1 shape — hit a partial-state
 * nonzero exit after credentials were written.
 *
 * Fix: drop the gate. The plugin owns the hook lifecycle (slice #1).
 *
 * This test invokes setup in non-interactive `--json` mode against an
 * in-process server, with NO `TEAMEM_BRIDGE_DIR` env var and a
 * credentials path that's never written by `hook-install`. Asserts:
 *   - Exit 0.
 *   - No mention of `hook-install` in stderr.
 *   - Credentials file is written.
 */
import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { runAllMigrations } from '../helpers/migrations.js';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
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

let tmpDir = '';
let server:
  | Awaited<ReturnType<typeof startHonoTestServer>>['server']
  | undefined;
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

beforeEach(async () => {
  resetRateLimitBuckets();
  tmpDir = await mkdtemp(join(tmpdir(), 'teamem-setup-no-bridge-'));
  const started = await startHonoTestServer(buildApp());
  server = started.server;
  serverPort = started.port;
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  }
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true });
    tmpDir = '';
  }
});

describe('setup with no bridge_dir (Codex F5)', () => {
  it('create flow exits 0 with no TEAMEM_BRIDGE_DIR and writes credentials', async () => {
    const credPath = join(tmpDir, 'credentials.json');
    const jsonArgs = {
      serverUrl: `http://localhost:${serverPort}`,
      flow: 'create',
      memberName: 'alice',
      spaceLabel: 'no-bridge-dir',
      credPath
    };

    const env: Record<string, string | undefined> = { ...process.env };
    delete env.TEAMEM_BRIDGE_DIR;
    delete env.CLAUDE_PLUGIN_OPTION_TEAMEM_ROOT;
    delete env.TEAMEM_ROOT;

    const child = spawn(
      'bun',
      ['run', 'src/cli/setup.ts', '--json', JSON.stringify(jsonArgs)],
      { env, stdio: ['ignore', 'pipe', 'pipe'] }
    );

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));

    const code = await new Promise<number>((resolve) => {
      child.on('close', (c) => resolve(c ?? -1));
    });

    expect(stderr).not.toContain('hook-install');
    expect(stderr).not.toContain('bridge_dir');
    expect(code).toBe(0);
    expect(stdout).toContain('Space created');

    const written = await readFile(credPath, 'utf-8');
    const parsed = JSON.parse(written) as { spaces: Record<string, unknown> };
    expect(Object.keys(parsed.spaces).length).toBeGreaterThan(0);
  }, 30_000);
});
