/**
 * Slice #28 regression — Stop hook must NOT invoke the bridge with
 * release_scope. Claims survive turn end; only explicit MCP release,
 * force-release, or git evidence (post-commit) releases them.
 *
 * Staging mirrors gate-claim-multi-space.test.ts: copy real plugin scripts
 * into a tmpdir, write a stub bridge that records its argv, fire the Stop
 * hook (release-claims.sh), and assert no release_scope call was made.
 */
import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  copyFileSync,
  chmodSync,
  existsSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { marketplaceEnv } from '../helpers/marketplace-env.js';

const REPO_ROOT = resolve(import.meta.dir, '../..');

function stageFakePlugin(workdir: string): { sentinel: string } {
  mkdirSync(join(workdir, 'plugin/scripts'), { recursive: true });
  mkdirSync(join(workdir, 'plugin/lib'), { recursive: true });

  copyFileSync(
    join(REPO_ROOT, 'plugin/scripts/_common.sh'),
    join(workdir, 'plugin/scripts/_common.sh')
  );
  copyFileSync(
    join(REPO_ROOT, 'plugin/scripts/release-claims.sh'),
    join(workdir, 'plugin/scripts/release-claims.sh')
  );
  chmodSync(join(workdir, 'plugin/scripts/release-claims.sh'), 0o755);

  const sentinel = join(workdir, 'argv.log');
  writeFileSync(
    join(workdir, 'plugin/lib/bridge.js'),
    `#!/usr/bin/env bun
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(sentinel)}, JSON.stringify(process.argv.slice(2)) + '\\n');
process.stdout.write(JSON.stringify({ ok: true, data: {} }));
process.exit(0);
`,
    { mode: 0o755 }
  );

  return { sentinel };
}

function activateSession(workdir: string, sessionId: string, space?: string) {
  const sd = join(workdir, 'plugin-data/sessions', sessionId);
  mkdirSync(sd, { recursive: true });
  writeFileSync(join(sd, 'active'), '');
  if (space) writeFileSync(join(sd, 'space'), space);
}

function runStop(
  workdir: string,
  sessionId: string
): { status: number | null } {
  const env = marketplaceEnv({
    CLAUDE_PLUGIN_ROOT: join(workdir, 'plugin'),
    CLAUDE_PLUGIN_DATA: join(workdir, 'plugin-data'),
    CLAUDE_SESSION_ID: sessionId
  });
  const r = spawnSync(
    'bash',
    [join(workdir, 'plugin/scripts/release-claims.sh')],
    {
      env,
      input: JSON.stringify({ session_id: sessionId }),
      encoding: 'utf-8',
      timeout: 15_000
    }
  );
  return { status: r.status };
}

describe('release-claims.sh Stop hook is a no-op (slice #28)', () => {
  it('Stop hook exits 0 and does NOT invoke bridge with release_scope when claims file exists', () => {
    const work = mkdtempSync(join(tmpdir(), 'teamem-stop-noop-'));
    try {
      const { sentinel } = stageFakePlugin(work);
      const sessionId = 'sess-stop-noop-1';
      activateSession(work, sessionId, 'space-A');

      // Plant a claims file as if gate-claim had previously acquired a claim.
      const sessionsDir = join(work, 'plugin-data/.cache/teamem/sessions');
      mkdirSync(sessionsDir, { recursive: true });
      // Also write in the location release-claims.sh resolves to.
      const cacheDir = join(work, 'plugin-data/.cache/teamem/sessions');
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(
        join(cacheDir, `${sessionId}.claims.json`),
        JSON.stringify({
          'src/foo.ts': {
            claim_id: 'claim-abc',
            expires_at: new Date(Date.now() + 600_000).toISOString(),
            space: 'space-A'
          }
        })
      );

      const { status } = runStop(work, sessionId);
      expect(status).toBe(0);

      // Bridge must not have been called at all (no sentinel file), OR if it
      // was called for another reason, it must not contain release_scope.
      if (existsSync(sentinel)) {
        const calls = readFileSync(sentinel, 'utf-8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as string[]);
        const releaseCalls = calls.filter((c) => c.includes('release_scope'));
        expect(releaseCalls.length).toBe(0);
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 30_000);

  it('Stop hook exits 0 and does NOT invoke bridge with release_scope even with no claims file', () => {
    const work = mkdtempSync(join(tmpdir(), 'teamem-stop-noop-empty-'));
    try {
      const { sentinel } = stageFakePlugin(work);
      const sessionId = 'sess-stop-noop-2';
      activateSession(work, sessionId, 'space-A');

      // No claims file — simulates a session where no claims were acquired.
      const { status } = runStop(work, sessionId);
      expect(status).toBe(0);

      if (existsSync(sentinel)) {
        const calls = readFileSync(sentinel, 'utf-8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as string[]);
        const releaseCalls = calls.filter((c) => c.includes('release_scope'));
        expect(releaseCalls.length).toBe(0);
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 30_000);

  it('Stop hook writes stop_hook_fired trace line with released_count:0 and left_count:0', () => {
    const work = mkdtempSync(join(tmpdir(), 'teamem-stop-noop-trace-'));
    try {
      stageFakePlugin(work);
      const sessionId = 'sess-stop-noop-3';
      activateSession(work, sessionId, 'space-A');

      // Override HOME so trace file lands in a controlled location.
      const fakeHome = join(work, 'home');
      mkdirSync(join(fakeHome, '.cache/teamem'), { recursive: true });

      const env = marketplaceEnv({
        CLAUDE_PLUGIN_ROOT: join(work, 'plugin'),
        CLAUDE_PLUGIN_DATA: join(work, 'plugin-data'),
        CLAUDE_SESSION_ID: sessionId,
        HOME: fakeHome
      });
      spawnSync('bash', [join(work, 'plugin/scripts/release-claims.sh')], {
        env,
        input: JSON.stringify({ session_id: sessionId }),
        encoding: 'utf-8',
        timeout: 15_000
      });

      const traceFile = join(fakeHome, '.cache/teamem/hook-trace.log');
      expect(existsSync(traceFile)).toBe(true);
      const lines = readFileSync(traceFile, 'utf-8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>);

      const traceLine = lines.find((l) => l.event === 'stop_hook_fired');
      expect(traceLine).toBeDefined();
      expect(traceLine?.session_id).toBe(sessionId);
      expect(traceLine?.released_count).toBe(0);
      expect(traceLine?.left_count).toBe(0);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 30_000);
});
