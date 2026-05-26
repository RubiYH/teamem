/**
 * Codex F14 regression — gate-claim.sh + release-claims.sh must pass
 * `--space` to the bridge when the session is pinned to a specific space
 * via `${SESSION_DIR}/space` or the manifest's `default_space`.
 *
 * Pre-#21 the hook invoked `bun run "${BRIDGE_JS}" call <tool> --json …`
 * with no `--space` flag. Multi-space users with a session-pinned space had
 * their claims silently land in `credentials.default_space_id` instead of the
 * pinned space.
 *
 * This test stages a fake plugin install with a stub `lib/bridge.js` that
 * records its argv, drives the gate-claim hook with PreToolUse JSON, and
 * asserts the bridge subprocess argv contains `--space <pinned>`.
 */
import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  copyFileSync,
  chmodSync,
  readFileSync,
  existsSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dir, '../..');

function gitInitWorkdir(workdir: string) {
  spawnSync('git', ['init'], { cwd: workdir, encoding: 'utf8' });
  spawnSync('git', ['commit', '--allow-empty', '-m', 'init'], {
    cwd: workdir,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@test.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@test.com'
    }
  });
}

function stageFakePlugin(workdir: string) {
  // Mirror the layout of plugin/ so _common.sh resolves PLUGIN_ROOT.
  mkdirSync(join(workdir, 'plugin/scripts'), { recursive: true });
  mkdirSync(join(workdir, 'plugin/bin'), { recursive: true });
  mkdirSync(join(workdir, 'plugin/lib'), { recursive: true });
  copyFileSync(
    join(REPO_ROOT, 'plugin/scripts/_common.sh'),
    join(workdir, 'plugin/scripts/_common.sh')
  );
  copyFileSync(
    join(REPO_ROOT, 'plugin/scripts/gate-claim.sh'),
    join(workdir, 'plugin/scripts/gate-claim.sh')
  );
  copyFileSync(
    join(REPO_ROOT, 'plugin/scripts/release-claims.sh'),
    join(workdir, 'plugin/scripts/release-claims.sh')
  );
  chmodSync(join(workdir, 'plugin/scripts/gate-claim.sh'), 0o755);
  chmodSync(join(workdir, 'plugin/scripts/release-claims.sh'), 0o755);

  // Marker bridge: append every invocation's argv to a sentinel file and
  // return a `claim_scope` success envelope so gate-claim returns "allow".
  const sentinel = join(workdir, 'argv.log');
  writeFileSync(
    join(workdir, 'plugin/lib/bridge.js'),
    `#!/usr/bin/env bun
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(sentinel)}, JSON.stringify(process.argv.slice(2)) + '\\n');
process.stdout.write(JSON.stringify({
  ok: true,
  data: { claim_id: 'fake-claim-1', expires_at: new Date(Date.now() + 60_000).toISOString() }
}));
process.exit(0);
`,
    { mode: 0o755 }
  );

  return { sentinel };
}

function setupActiveSession(
  workdir: string,
  sessionId: string,
  spacePin?: string
) {
  const sessionDir = join(workdir, 'plugin-data/sessions', sessionId);
  mkdirSync(sessionDir, { recursive: true });
  // Active flag — gate hook short-circuits without it.
  writeFileSync(join(sessionDir, 'active'), '');
  if (spacePin) {
    writeFileSync(join(sessionDir, 'space'), spacePin);
  }
  return sessionDir;
}

function runGate(
  workdir: string,
  sessionId: string,
  toolInput: Record<string, unknown>,
  extraEnv: Record<string, string | undefined> = {}
) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_PLUGIN_ROOT: join(workdir, 'plugin'),
    CLAUDE_PLUGIN_DATA: join(workdir, 'plugin-data'),
    CLAUDE_SESSION_ID: sessionId,
    ...extraEnv
  };
  delete env.TEAMEM_HOOK_DISABLE;
  const stdin = JSON.stringify({
    session_id: sessionId,
    tool_name: 'Edit',
    tool_input: toolInput,
    cwd: workdir
  });
  return spawnSync('bash', [join(workdir, 'plugin/scripts/gate-claim.sh')], {
    env,
    input: stdin,
    encoding: 'utf-8',
    timeout: 15_000
  });
}

describe('gate-claim.sh multi-space pin (Codex F14)', () => {
  it('with session pin ${SESSION_DIR}/space, bridge argv contains --space <pinned>', () => {
    const work = mkdtempSync(join(tmpdir(), 'teamem-multispace-'));
    try {
      const { sentinel } = stageFakePlugin(work);
      gitInitWorkdir(work);
      const sessionId = 'sess-1';
      setupActiveSession(work, sessionId, '01PINNEDSPACE');

      const r = runGate(work, sessionId, { file_path: join(work, 'file.ts') });
      expect(r.status).toBe(0);
      expect(existsSync(sentinel)).toBe(true);
      const calls = readFileSync(sentinel, 'utf-8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as string[]);
      expect(calls.length).toBeGreaterThan(0);
      // First call is teamem.claim_scope. Verify --space is present.
      const first = calls[0];
      expect(first).toContain('call');
      expect(first).toContain('teamem.claim_scope');
      expect(first).toContain('--space');
      const spaceIdx = first.indexOf('--space');
      expect(first[spaceIdx + 1]).toBe('01PINNEDSPACE');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 30_000);

  it('with manifest CLAUDE_PLUGIN_OPTION_DEFAULT_SPACE (no session pin), bridge gets --space <default>', () => {
    const work = mkdtempSync(join(tmpdir(), 'teamem-multispace-'));
    try {
      const { sentinel } = stageFakePlugin(work);
      gitInitWorkdir(work);
      const sessionId = 'sess-2';
      setupActiveSession(work, sessionId); // NO space file

      const r = runGate(
        work,
        sessionId,
        { file_path: join(work, 'a.ts') },
        {
          CLAUDE_PLUGIN_OPTION_DEFAULT_SPACE: 'team-alpha'
        }
      );
      expect(r.status).toBe(0);
      const calls = readFileSync(sentinel, 'utf-8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as string[]);
      const first = calls[0];
      expect(first).toContain('--space');
      const spaceIdx = first.indexOf('--space');
      expect(first[spaceIdx + 1]).toBe('team-alpha');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 30_000);

  it('with neither pin nor manifest default, bridge call omits --space (preserves credentials.default_space_id fallback)', () => {
    const work = mkdtempSync(join(tmpdir(), 'teamem-multispace-'));
    try {
      const { sentinel } = stageFakePlugin(work);
      gitInitWorkdir(work);
      const sessionId = 'sess-3';
      setupActiveSession(work, sessionId);

      const env: Record<string, string | undefined> = {
        CLAUDE_PLUGIN_ROOT: join(work, 'plugin'),
        CLAUDE_PLUGIN_DATA: join(work, 'plugin-data'),
        CLAUDE_SESSION_ID: sessionId,
        // Inherit the system PATH but explicitly drop CLAUDE_PLUGIN_OPTION_*.
        PATH: process.env.PATH,
        HOME: process.env.HOME
      };
      delete env.CLAUDE_PLUGIN_OPTION_DEFAULT_SPACE;
      delete env.TEAMEM_SPACE;
      delete env.TEAMEM_HOOK_DISABLE;

      const stdin = JSON.stringify({
        session_id: sessionId,
        tool_name: 'Edit',
        tool_input: { file_path: join(work, 'a.ts') },
        cwd: work
      });
      const r = spawnSync(
        'bash',
        [join(work, 'plugin/scripts/gate-claim.sh')],
        { env, input: stdin, encoding: 'utf-8', timeout: 15_000 }
      );
      expect(r.status).toBe(0);
      const calls = readFileSync(sentinel, 'utf-8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as string[]);
      const first = calls[0];
      expect(first).not.toContain('--space');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 30_000);
});
