/**
 * Codex F19 regression — `teamem-monitor` must read
 * `${SESSION_DIR}/space` first when resolving the polling space, then
 * fall back to `TEAMEM_SPACE`, `CLAUDE_PLUGIN_OPTION_DEFAULT_SPACE`, and
 * `creds.default_space_id`. The resolved space MUST be passed as `--space`
 * to every `teamem.get_updates` call so the bridge polls the same space
 * the hooks are claiming in.
 *
 * Pre-#22 the monitor only read the env var chain. After
 * `/teamem-on space-B` pinned hooks to space-B, the monitor kept polling
 * space-A and self-filtered against the wrong principal — peer events
 * leaked from a space the user wasn't working in.
 *
 * Test pins `${SESSION_DIR}/space` to space-B and sets the manifest
 * default to space-A. Asserts the monitor's bridge subprocess argv
 * contains `--space space-B` and `myPrincipal` resolves to space-B's
 * member (visible via stdout: alice's events from space-B are filtered;
 * bob's are not).
 */
import { describe, expect, it } from 'bun:test';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  chmodSync,
  copyFileSync,
  existsSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { marketplaceEnv } from '../helpers/marketplace-env.js';

const REPO_ROOT = resolve(import.meta.dir, '../..');

function stagePlugin(workdir: string) {
  mkdirSync(join(workdir, 'plugin/bin'), { recursive: true });
  mkdirSync(join(workdir, 'plugin/lib'), { recursive: true });
  copyFileSync(
    join(REPO_ROOT, 'plugin/bin/teamem-monitor'),
    join(workdir, 'plugin/bin/teamem-monitor')
  );
  chmodSync(join(workdir, 'plugin/bin/teamem-monitor'), 0o755);

  // Stub bridge: log argv to a sentinel and return a get_updates payload
  // including events from BOTH alice (space-B's local member) and bob.
  const sentinel = join(workdir, 'argv.log');
  const stub = `#!/usr/bin/env bun
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(sentinel)}, JSON.stringify(process.argv.slice(2)) + '\\n');
process.stdout.write(JSON.stringify({
  ok: true,
  data: {
    events: [
      { event_id: 'e-alice', event_type: 'scope_claimed', principal: 'alice-in-B', scope: { paths: ['x'] }, payload: {} },
      { event_id: 'e-bob',   event_type: 'scope_claimed', principal: 'bob',        scope: { paths: ['y'] }, payload: {} }
    ]
  }
}));
process.exit(0);
`;
  writeFileSync(join(workdir, 'plugin/lib/bridge.js'), stub, { mode: 0o755 });
  return { sentinel };
}

function writeCreds(
  workdir: string,
  spaces: Record<string, { member_name: string; label?: string }>
) {
  const credDir = join(workdir, '.teamem');
  mkdirSync(credDir, { recursive: true });
  const file = join(credDir, 'credentials.json');
  const ids = Object.keys(spaces);
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      default_space_id: ids[0] ?? null,
      spaces
    }),
    { mode: 0o600 }
  );
}

async function runMonitorOnce(
  workdir: string,
  defaultSpace: string | undefined,
  sessionPin: string | undefined,
  homeOverride: string
): Promise<{ stdout: string; sessionId: string }> {
  const sessionId = 'sess-monitor-pin';
  const sd = join(workdir, 'plugin-data/sessions', sessionId);
  mkdirSync(sd, { recursive: true });
  if (sessionPin) {
    writeFileSync(join(sd, 'space'), sessionPin);
  }

  const env = marketplaceEnv({
    CLAUDE_PLUGIN_ROOT: join(workdir, 'plugin'),
    CLAUDE_PLUGIN_DATA: join(workdir, 'plugin-data'),
    CLAUDE_SESSION_ID: sessionId,
    HOME: homeOverride,
    TEAMEM_MONITOR_POLL_MS: '500',
    CLAUDE_PLUGIN_OPTION_DEFAULT_SPACE: defaultSpace
  });

  const child = spawn(
    'bun',
    ['run', join(workdir, 'plugin/bin/teamem-monitor')],
    { env: env as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  let stdout = '';
  child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
  const exitPromise = new Promise<void>((resolveFn) =>
    child.on('close', () => resolveFn())
  );
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (stdout.includes('"event_id":"e-bob"')) break;
    Bun.sleepSync(100);
  }
  Bun.sleepSync(200);
  try {
    child.kill('SIGTERM');
  } catch {
    /* ignore */
  }
  await Promise.race([
    exitPromise,
    new Promise<void>((resolveFn) => setTimeout(resolveFn, 500))
  ]).catch(() => {});
  return { stdout, sessionId };
}

describe('teamem-monitor honors session-pinned space (Codex F19)', () => {
  it('with ${SESSION_DIR}/space=space-B AND manifest default=space-A, monitor polls space-B and filters space-B principal', async () => {
    const work = mkdtempSync(join(tmpdir(), 'teamem-f19-'));
    try {
      const { sentinel } = stagePlugin(work);
      // Two spaces in credentials. Session pin is space-B; manifest
      // default points to space-A. Pre-#22 the monitor would pick A.
      writeCreds(work, {
        'space-A': { member_name: 'alice-in-A', label: 'team-alpha' },
        'space-B': { member_name: 'alice-in-B', label: 'team-beta' }
      });

      const { stdout } = await runMonitorOnce(work, 'space-A', 'space-B', work);

      // F19: bob's event surfaces (not the local principal of space-B).
      expect(stdout).toContain('"event_id":"e-bob"');
      // alice-in-B's event must be self-filtered. If the monitor were
      // resolving against space-A, myPrincipal would be alice-in-A and
      // alice-in-B's event would surface incorrectly.
      expect(stdout).not.toContain('"event_id":"e-alice"');

      // Bridge argv must include `--space space-B` (the session pin),
      // not space-A (the manifest default).
      expect(existsSync(sentinel)).toBe(true);
      const calls = readFileSync(sentinel, 'utf-8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as string[]);
      expect(calls.length).toBeGreaterThan(0);
      const first = calls[0];
      const sIdx = first.indexOf('--space');
      expect(sIdx).toBeGreaterThan(-1);
      expect(first[sIdx + 1]).toBe('space-B');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 30_000);

  it('with no session pin and manifest default=space-A, monitor polls space-A (fallback preserves prior behavior)', async () => {
    const work = mkdtempSync(join(tmpdir(), 'teamem-f19-fallback-'));
    try {
      const { sentinel } = stagePlugin(work);
      writeCreds(work, {
        'space-A': { member_name: 'alice-in-A', label: 'team-alpha' },
        'space-B': { member_name: 'alice-in-B', label: 'team-beta' }
      });

      const { stdout } = await runMonitorOnce(work, 'space-A', undefined, work);

      expect(stdout).toContain('"event_id":"e-bob"');
      // alice-in-B is NOT the local principal of space-A; her event
      // should surface (no self-filter applies for a different space's
      // member name).
      expect(stdout).toContain('"event_id":"e-alice"');

      const calls = readFileSync(sentinel, 'utf-8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as string[]);
      const first = calls[0];
      const sIdx = first.indexOf('--space');
      expect(first[sIdx + 1]).toBe('space-A');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 30_000);
});
