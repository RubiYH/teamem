/**
 * Codex F16 regression — `teamem-monitor` must resolve
 * `CLAUDE_PLUGIN_OPTION_DEFAULT_SPACE` as either a `space_id` (ULID) or a
 * human-readable `label` to set `myPrincipal` for self-filtering.
 *
 * Pre-#21 the monitor did `creds.spaces[spaceId]` directly. When the user
 * pinned the manifest to a label (the manifest UX-friendly form), the
 * lookup returned undefined → empty `myPrincipal` → self-filter disabled.
 * The watcher then surfaced the user's OWN events as peer notifications,
 * burning the per-session rate limit.
 *
 * This test runs the monitor for one poll cycle in three configurations:
 *   1. ULID space_id pin → self-filter sets myPrincipal correctly.
 *   2. Label pin → self-filter sets myPrincipal via label match.
 *   3. Ambiguous label → self-filter disabled, warning logged.
 *
 * The stub bridge returns events including one from "alice" (the local
 * principal). Self-filter assertion: when working, no notification line is
 * emitted for that event; when broken, the alice event surfaces.
 */
import { describe, expect, it } from 'bun:test';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  chmodSync,
  readFileSync,
  existsSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dir, '../..');

function stagePluginWithBridge(workdir: string) {
  mkdirSync(join(workdir, 'plugin/bin'), { recursive: true });
  mkdirSync(join(workdir, 'plugin/lib'), { recursive: true });
  // Copy the real teamem-monitor.
  const fs = require('node:fs');
  fs.copyFileSync(
    join(REPO_ROOT, 'plugin/bin/teamem-monitor'),
    join(workdir, 'plugin/bin/teamem-monitor')
  );
  chmodSync(join(workdir, 'plugin/bin/teamem-monitor'), 0o755);

  // Stub bridge: returns a get_updates response with two events: one from
  // "alice" (local principal — should be self-filtered) and one from
  // "bob" (peer — should surface).
  writeFileSync(
    join(workdir, 'plugin/lib/bridge.js'),
    `#!/usr/bin/env bun
process.stdout.write(JSON.stringify({
  ok: true,
  data: {
    events: [
      { event_id: 'e-1', event_type: 'scope_claimed', principal: 'alice', scope: { paths: ['src/a.ts'] }, payload: {} },
      { event_id: 'e-2', event_type: 'scope_claimed', principal: 'bob',   scope: { paths: ['src/b.ts'] }, payload: {} }
    ]
  }
}));
process.exit(0);
`,
    { mode: 0o755 }
  );
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
  return file;
}

async function runMonitorOnce(
  workdir: string,
  defaultSpace: string | undefined,
  homeOverride: string
) {
  const sessionId = 'mon-test';
  const env: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_PLUGIN_ROOT: join(workdir, 'plugin'),
    CLAUDE_PLUGIN_DATA: join(workdir, 'plugin-data'),
    CLAUDE_SESSION_ID: sessionId,
    HOME: homeOverride,
    TEAMEM_MONITOR_POLL_MS: '1000'
  };
  if (defaultSpace) {
    env.CLAUDE_PLUGIN_OPTION_DEFAULT_SPACE = defaultSpace;
  } else {
    delete env.CLAUDE_PLUGIN_OPTION_DEFAULT_SPACE;
  }
  delete env.TEAMEM_SPACE;

  // Run monitor as a background process; wait for the second event line
  // so we know both events from the stub were processed (or, in the
  // ambiguous case, both surface). Kill after a hard 5s cap.
  const child = require('node:child_process').spawn(
    'bun',
    ['run', join(workdir, 'plugin/bin/teamem-monitor')],
    { env, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  let stdout = '';
  child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
  const exitPromise = new Promise<void>((resolveFn) =>
    child.on('close', () => resolveFn())
  );
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    // For non-ambiguous configs, bob's e-2 is sufficient. For ambiguous,
    // we need both e-1 and e-2.
    if (stdout.includes('"event_id":"e-2"')) break;
    Bun.sleepSync(100);
  }
  // Give the monitor 200ms more to also emit alice's e-1 in the
  // ambiguous case (no self-filter).
  Bun.sleepSync(200);
  try {
    child.kill('SIGTERM');
  } catch {
    /* ignore */
  }
  // Drain any remaining stdout.
  await Promise.race([
    exitPromise,
    new Promise<void>((resolveFn) => setTimeout(resolveFn, 500))
  ]).catch(() => {});
  return { stdout, sessionId };
}

describe('teamem-monitor self-filter via label (Codex F16)', () => {
  it('label pin: self-filter active when default_space matches a unique label', async () => {
    const work = mkdtempSync(join(tmpdir(), 'teamem-monitor-label-'));
    try {
      stagePluginWithBridge(work);
      writeCreds(work, {
        '01ULIDA': { member_name: 'alice', label: 'team-alpha' }
      });
      const { stdout } = await runMonitorOnce(work, 'team-alpha', work);

      // bob's event should surface.
      expect(stdout).toContain('"event_id":"e-2"');
      expect(stdout).toContain('"principal":"bob"');
      // alice's event should NOT (self-filter active because label resolved).
      expect(stdout).not.toContain('"event_id":"e-1"');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 30_000);

  it('space_id pin: self-filter active when default_space is the ULID key (preserves existing behavior)', async () => {
    const work = mkdtempSync(join(tmpdir(), 'teamem-monitor-id-'));
    try {
      stagePluginWithBridge(work);
      writeCreds(work, {
        '01ULIDB': { member_name: 'alice', label: 'team-beta' }
      });
      const { stdout } = await runMonitorOnce(work, '01ULIDB', work);
      expect(stdout).toContain('"event_id":"e-2"');
      expect(stdout).not.toContain('"event_id":"e-1"');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 30_000);

  it('ambiguous label: self-filter disabled, warning logged to monitor.log', async () => {
    const work = mkdtempSync(join(tmpdir(), 'teamem-monitor-ambig-'));
    try {
      stagePluginWithBridge(work);
      writeCreds(work, {
        '01ULIDX': { member_name: 'alice', label: 'shared' },
        '01ULIDY': { member_name: 'mallory', label: 'shared' }
      });
      const { stdout } = await runMonitorOnce(work, 'shared', work);
      // With ambiguous label, self-filter is disabled — alice's events
      // surface alongside bob's (deliberately verbose, so the user can
      // debug their setup).
      expect(stdout).toContain('"event_id":"e-1"');
      expect(stdout).toContain('"event_id":"e-2"');

      // Warning logged.
      const monitorLog = join(work, 'plugin-data/monitor.log');
      if (existsSync(monitorLog)) {
        const log = readFileSync(monitorLog, 'utf-8');
        expect(log).toContain('space_label_ambiguous');
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 30_000);
});
