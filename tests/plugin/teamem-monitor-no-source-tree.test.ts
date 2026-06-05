/**
 * Codex F6 regression — `plugin/bin/teamem-monitor` must work without
 * `CLAUDE_PLUGIN_OPTION_TEAMEM_ROOT` and without `src/bridge/index.ts`.
 *
 * Original bug: the monitor read `CLAUDE_PLUGIN_OPTION_TEAMEM_ROOT` and
 * exited 1 when unset, then shelled out to `${TEAMEM_ROOT}/src/bridge/index.ts`.
 * The plugin manifest no longer exposes `teamem_root`, so a marketplace
 * install activated via teamem-flag but never streamed peer notifications.
 *
 * Fix: resolve `${CLAUDE_PLUGIN_ROOT}/lib/bridge.js` exactly like
 * `plugin/bin/teamem-call`. No `CLAUDE_PLUGIN_OPTION_TEAMEM_ROOT`
 * reference. No `src/bridge/index.ts` reference.
 */
import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  unlinkSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dir, '../..');
const PROJECT_KEY = createHash('sha1')
  .update('monitor-test-project')
  .digest('hex');

describe('teamem-monitor works without source-tree config (Codex F6)', () => {
  it('declares the monitor as always-on so persisted sessions receive peer events', () => {
    const monitors = JSON.parse(
      readFileSync(join(REPO_ROOT, 'plugin/monitors/monitors.json'), 'utf-8')
    ) as Array<{ name: string; when?: string }>;
    expect(
      monitors.some((m) => m.name === 'teamem-events' && m.when === 'always')
    ).toBe(true);
  });

  it('functional code has no CLAUDE_PLUGIN_OPTION_TEAMEM_ROOT reads or src/bridge/index.ts joins', () => {
    const src = readFileSync(
      join(REPO_ROOT, 'plugin/bin/teamem-monitor'),
      'utf-8'
    );
    // Strip line comments + block comments so "Codex F6" rationale text
    // (which legitimately mentions the removed names) doesn't fail the
    // assertion. Functional references are what we care about.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    expect(code).not.toContain('CLAUDE_PLUGIN_OPTION_TEAMEM_ROOT');
    expect(code).not.toContain('src/bridge/index.ts');
    // Positive: the bundled bridge path must be referenced in code.
    expect(code).toContain('lib');
    expect(code).toContain('bridge.js');
  });

  it('exits with bridge_bundle_missing when lib/bridge.js is absent (does NOT require TEAMEM_ROOT)', () => {
    const plugin = mkdtempSync(join(tmpdir(), 'teamem-monitor-no-bundle-'));
    try {
      mkdirSync(join(plugin, 'bin'));
      // Intentionally omit lib/.
      copyFileSync(
        join(REPO_ROOT, 'plugin/bin/teamem-monitor'),
        join(plugin, 'bin/teamem-monitor')
      );
      chmodSync(join(plugin, 'bin/teamem-monitor'), 0o755);

      const env: Record<string, string | undefined> = {
        ...process.env,
        CLAUDE_PLUGIN_ROOT: plugin,
        CLAUDE_PLUGIN_DATA: join(plugin, 'data'),
        CLAUDE_SESSION_ID: 'test-session'
      };
      delete env.CLAUDE_PLUGIN_OPTION_TEAMEM_ROOT;
      delete env.TEAMEM_ROOT;

      const result = spawnSync(
        'bun',
        ['run', join(plugin, 'bin/teamem-monitor')],
        { env, encoding: 'utf-8', timeout: 10_000 }
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('bridge_bundle_missing');
      // Negative: never asks for TEAMEM_ROOT.
      expect(result.stderr).not.toContain('CLAUDE_PLUGIN_OPTION_TEAMEM_ROOT');
    } finally {
      rmSync(plugin, { recursive: true, force: true });
    }
  }, 30_000);

  it('spawns the bundled bridge with `call teamem.get_updates` when invoked (one poll, then exit)', () => {
    const plugin = mkdtempSync(join(tmpdir(), 'teamem-monitor-poll-'));
    try {
      mkdirSync(join(plugin, 'bin'));
      mkdirSync(join(plugin, 'lib'));

      copyFileSync(
        join(REPO_ROOT, 'plugin/bin/teamem-monitor'),
        join(plugin, 'bin/teamem-monitor')
      );
      chmodSync(join(plugin, 'bin/teamem-monitor'), 0o755);

      // Marker bundle: instead of running the real bridge, write the argv
      // we received to a sentinel file so the test can assert what got
      // spawned. Returns a valid `{ ok: true, data: { events: [] } }`
      // payload so the monitor's parser is happy.
      const sentinel = join(plugin, 'data', 'spawned.json');
      mkdirSync(join(plugin, 'data'), { recursive: true });
      writeFileSync(
        join(plugin, 'lib/bridge.js'),
        `#!/usr/bin/env bun
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
const sentinel = ${JSON.stringify(sentinel)};
const prior = existsSync(sentinel) ? JSON.parse(readFileSync(sentinel, 'utf-8')) : [];
prior.push(process.argv.slice(2));
writeFileSync(sentinel, JSON.stringify(prior));
process.stdout.write(JSON.stringify({ ok: true, data: { events: [] } }));
process.exit(0);
`,
        { mode: 0o755 }
      );

      const env: Record<string, string | undefined> = {
        ...process.env,
        CLAUDE_PLUGIN_ROOT: plugin,
        CLAUDE_PLUGIN_DATA: join(plugin, 'data'),
        CLAUDE_SESSION_ID: 'test-session',
        TEAMEM_PROJECT_ID: 'monitor-test-project',
        // Speed up so we exit promptly after one poll.
        TEAMEM_MONITOR_POLL_MS: '1000'
      };
      delete env.CLAUDE_PLUGIN_OPTION_TEAMEM_ROOT;
      delete env.TEAMEM_ROOT;

      mkdirSync(join(plugin, 'data/sessions/test-session'), {
        recursive: true
      });
      writeFileSync(join(plugin, 'data/sessions/test-session/active'), 'now');

      // Spawn detached, kill after a short window so the polling loop runs ≥1 cycle.
      const child = require('node:child_process').spawn(
        'bun',
        ['run', join(plugin, 'bin/teamem-monitor')],
        { env, stdio: ['ignore', 'pipe', 'pipe'] }
      );
      // Give the monitor 1.5s to fire its first poll.
      const timer = setTimeout(() => {
        try {
          child.kill('SIGTERM');
        } catch {
          /* ignore */
        }
      }, 1500);

      const exitPromise = new Promise<void>((resolveFn) => {
        child.on('close', () => {
          clearTimeout(timer);
          resolveFn();
        });
      });
      // Bun:test doesn't await Promise from sync callbacks elegantly; spin a tight wait.
      const start = Date.now();
      while (!existsSync(sentinel) && Date.now() - start < 5000) {
        Bun.sleepSync(50);
      }
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      void exitPromise;

      expect(existsSync(sentinel)).toBe(true);
      const argvLog = JSON.parse(readFileSync(sentinel, 'utf-8')) as string[][];
      expect(argvLog.length).toBeGreaterThan(0);
      // First poll: monitor passes `call teamem.get_updates --json …`.
      const firstPoll = argvLog[0];
      expect(firstPoll).toContain('call');
      expect(firstPoll).toContain('teamem.get_updates');
      expect(firstPoll).toContain('--json');
      // Negative: never references the source-tree path.
      const argvJoined = firstPoll.join(' ');
      expect(argvJoined).not.toContain('src/bridge/index.ts');
    } finally {
      rmSync(plugin, { recursive: true, force: true });
    }
  }, 30_000);

  it('renders Sprint-wide discussion summaries as Sprint-scoped, not Space-wide', async () => {
    const plugin = mkdtempSync(join(tmpdir(), 'teamem-monitor-sprint-label-'));
    try {
      mkdirSync(join(plugin, 'bin'));
      mkdirSync(join(plugin, 'lib'));

      copyFileSync(
        join(REPO_ROOT, 'plugin/bin/teamem-monitor'),
        join(plugin, 'bin/teamem-monitor')
      );
      chmodSync(join(plugin, 'bin/teamem-monitor'), 0o755);

      writeFileSync(
        join(plugin, 'lib/bridge.js'),
        `#!/usr/bin/env bun
process.stdout.write(JSON.stringify({
  ok: true,
  data: {
    events: [
      {
        event_id: 'evt-direct',
        event_type: 'discussion_posted',
        principal: 'bob',
        sprint_id: 'sprint-plugin-release',
        delivery_scope: 'direct',
        payload: { recipient_principal: 'alice', body: 'direct ping' }
      },
      {
        event_id: 'evt-sprint',
        event_type: 'discussion_posted',
        principal: 'bob',
        sprint_id: 'sprint-plugin-release',
        delivery_scope: 'sprint',
        payload: { recipient_principal: null, body: 'sprint broadcast' }
      },
      {
        event_id: 'evt-space',
        event_type: 'discussion_posted',
        principal: 'bob',
        sprint_id: null,
        delivery_scope: 'space',
        payload: { recipient_principal: null, body: 'space broadcast' }
      }
    ],
    next_cursor: 'done'
  }
}));
process.exit(0);
`,
        { mode: 0o755 }
      );

      const sessionId = 'test-session';
      const env: Record<string, string | undefined> = {
        ...process.env,
        CLAUDE_PLUGIN_ROOT: plugin,
        CLAUDE_PLUGIN_DATA: join(plugin, 'data'),
        CLAUDE_SESSION_ID: sessionId,
        TEAMEM_PROJECT_ID: 'monitor-test-project',
        TEAMEM_MONITOR_POLL_MS: '1000'
      };

      mkdirSync(join(plugin, 'data/sessions', sessionId), {
        recursive: true
      });
      writeFileSync(join(plugin, 'data/sessions', sessionId, 'active'), 'now');

      const child = require('node:child_process').spawn(
        'bun',
        ['run', join(plugin, 'bin/teamem-monitor')],
        { env, stdio: ['ignore', 'pipe', 'pipe'] }
      );
      let stdout = '';
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
      const exitPromise = new Promise<void>((resolveFn) => {
        child.on('close', () => resolveFn());
      });

      const deadline = Date.now() + 5000;
      while (
        !stdout.includes('"event_id":"evt-space"') &&
        Date.now() < deadline
      ) {
        Bun.sleepSync(50);
      }
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      await Promise.race([
        exitPromise,
        new Promise<void>((resolveFn) => setTimeout(resolveFn, 500))
      ]);

      const lines = stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(
          (line) => JSON.parse(line) as { event_id: string; summary: string }
        );
      const summaries = new Map(
        lines.map((line) => [line.event_id, line.summary])
      );

      expect(summaries.get('evt-direct')).toContain('bob → alice');
      expect(summaries.get('evt-sprint')).toContain(
        'bob → sprint:sprint-plugin-release'
      );
      expect(summaries.get('evt-sprint')).not.toContain('bob → space');
      expect(summaries.get('evt-space')).toContain('bob → space');
    } finally {
      rmSync(plugin, { recursive: true, force: true });
    }
  }, 30_000);

  it('persists next_cursor from empty visible pages and uses it on the next poll', async () => {
    const plugin = mkdtempSync(join(tmpdir(), 'teamem-monitor-cursor-'));
    try {
      mkdirSync(join(plugin, 'bin'));
      mkdirSync(join(plugin, 'lib'));

      copyFileSync(
        join(REPO_ROOT, 'plugin/bin/teamem-monitor'),
        join(plugin, 'bin/teamem-monitor')
      );
      chmodSync(join(plugin, 'bin/teamem-monitor'), 0o755);

      const callLog = join(plugin, 'data', 'calls.json');
      mkdirSync(join(plugin, 'data'), { recursive: true });
      writeFileSync(
        join(plugin, 'lib/bridge.js'),
        `#!/usr/bin/env bun
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
const callLog = ${JSON.stringify(callLog)};
const prior = existsSync(callLog) ? JSON.parse(readFileSync(callLog, 'utf-8')) : [];
const argv = process.argv.slice(2);
const jsonArg = argv[argv.indexOf('--json') + 1];
const body = jsonArg ? JSON.parse(jsonArg) : {};
prior.push({ argv, body });
writeFileSync(callLog, JSON.stringify(prior));
if (prior.length === 1) {
  process.stdout.write(JSON.stringify({ ok: true, data: { events: [], next_cursor: 'hidden-end' } }));
} else if (body.since === 'hidden-end') {
  process.stdout.write(JSON.stringify({
    ok: true,
    data: {
      events: [
        { event_id: 'visible-1', event_type: 'discussion_posted', principal: 'bob', payload: { body: 'visible after hidden page' } }
      ],
      next_cursor: 'visible-end'
    }
  }));
} else {
  process.stdout.write(JSON.stringify({ ok: true, data: { events: [] } }));
}
process.exit(0);
`,
        { mode: 0o755 }
      );

      const sessionId = 'test-session';
      const env: Record<string, string | undefined> = {
        ...process.env,
        CLAUDE_PLUGIN_ROOT: plugin,
        CLAUDE_PLUGIN_DATA: join(plugin, 'data'),
        CLAUDE_SESSION_ID: sessionId,
        TEAMEM_PROJECT_ID: 'monitor-test-project',
        TEAMEM_MONITOR_POLL_MS: '1000'
      };

      mkdirSync(join(plugin, 'data/sessions', sessionId), {
        recursive: true
      });
      writeFileSync(join(plugin, 'data/sessions', sessionId, 'active'), 'now');

      const child = require('node:child_process').spawn(
        'bun',
        ['run', join(plugin, 'bin/teamem-monitor')],
        { env, stdio: ['ignore', 'pipe', 'pipe'] }
      );
      let stdout = '';
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
      const exitPromise = new Promise<void>((resolveFn) => {
        child.on('close', () => resolveFn());
      });

      const deadline = Date.now() + 7000;
      while (
        !stdout.includes('"event_id":"visible-1"') &&
        Date.now() < deadline
      ) {
        Bun.sleepSync(50);
      }
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      await Promise.race([
        exitPromise,
        new Promise<void>((resolveFn) => setTimeout(resolveFn, 500))
      ]);

      expect(stdout).toContain('"event_id":"visible-1"');
      const calls = JSON.parse(readFileSync(callLog, 'utf-8')) as Array<{
        argv: string[];
        body: { since?: string; limit?: number };
      }>;
      expect(calls.length).toBeGreaterThanOrEqual(2);
      expect(calls[0]?.body).toEqual({ limit: 20 });
      expect(calls[1]?.body).toEqual({ since: 'hidden-end', limit: 50 });
      expect(
        readFileSync(
          join(plugin, 'data/sessions', sessionId, 'monitor-cursor'),
          'utf-8'
        )
      ).toBe('visible-end');
    } finally {
      rmSync(plugin, { recursive: true, force: true });
    }
  }, 30_000);

  it('idles until Teamem is active, respects disabled override, then polls using project auto-on', () => {
    const plugin = mkdtempSync(join(tmpdir(), 'teamem-monitor-auto-on-'));
    try {
      mkdirSync(join(plugin, 'bin'));
      mkdirSync(join(plugin, 'lib'));

      copyFileSync(
        join(REPO_ROOT, 'plugin/bin/teamem-monitor'),
        join(plugin, 'bin/teamem-monitor')
      );
      chmodSync(join(plugin, 'bin/teamem-monitor'), 0o755);

      const sentinel = join(plugin, 'data', 'spawned.json');
      mkdirSync(join(plugin, 'data'), { recursive: true });
      writeFileSync(
        join(plugin, 'lib/bridge.js'),
        `#!/usr/bin/env bun
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
const sentinel = ${JSON.stringify(sentinel)};
const prior = existsSync(sentinel) ? JSON.parse(readFileSync(sentinel, 'utf-8')) : [];
prior.push(process.argv.slice(2));
writeFileSync(sentinel, JSON.stringify(prior));
process.stdout.write(JSON.stringify({ ok: true, data: { events: [] } }));
process.exit(0);
`,
        { mode: 0o755 }
      );

      const env: Record<string, string | undefined> = {
        ...process.env,
        CLAUDE_PLUGIN_ROOT: plugin,
        CLAUDE_PLUGIN_DATA: join(plugin, 'data'),
        CLAUDE_SESSION_ID: 'test-session',
        TEAMEM_PROJECT_ID: 'monitor-test-project',
        TEAMEM_MONITOR_POLL_MS: '1000'
      };

      const child = require('node:child_process').spawn(
        'bun',
        ['run', join(plugin, 'bin/teamem-monitor')],
        { env, stdio: ['ignore', 'pipe', 'pipe'] }
      );

      Bun.sleepSync(1300);
      expect(existsSync(sentinel)).toBe(false);

      const disabledFile = join(plugin, 'data/sessions/test-session/disabled');
      mkdirSync(dirname(disabledFile), { recursive: true });
      writeFileSync(disabledFile, 'now');

      const persistFile = join(
        plugin,
        'data',
        'projects',
        PROJECT_KEY,
        'auto-on'
      );
      mkdirSync(dirname(persistFile), { recursive: true });
      writeFileSync(persistFile, 'now');

      Bun.sleepSync(1300);
      expect(existsSync(sentinel)).toBe(false);
      unlinkSync(disabledFile);

      const start = Date.now();
      while (!existsSync(sentinel) && Date.now() - start < 5000) {
        Bun.sleepSync(50);
      }
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }

      expect(existsSync(sentinel)).toBe(true);
    } finally {
      rmSync(plugin, { recursive: true, force: true });
    }
  }, 30_000);
});
