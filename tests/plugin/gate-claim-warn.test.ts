/**
 * Tier-W silent-failure surfacing regression.
 *
 * The hook used to silently swallow infra failures (bridge subprocess crash,
 * unrecognized response shape, JSON encode failure). The user saw no signal
 * — `decision:fail-open` in the trace log was the only clue and most users
 * never tail it. _teamem_warn() in _common.sh now emits a one-line
 * `teamem: <class> — <cause>` to stderr, which Claude Code surfaces
 * inline on tool result. Rate-limited per warn-class so a broken bridge
 * doesn't spam every keystroke. Silenced when TEAMEM_HOOK_QUIET=1.
 *
 * Tests:
 *   1. Unhandled bridge response → stderr contains the warn marker, exit 0.
 *   2. Second invocation within rate window → no warn (rate-limited).
 *   3. TEAMEM_HOOK_QUIET=1 → no warn even on first invocation.
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
  readFileSync
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
  mkdirSync(join(workdir, 'plugin/scripts'), { recursive: true });
  mkdirSync(join(workdir, 'plugin/lib'), { recursive: true });
  copyFileSync(
    join(REPO_ROOT, 'plugin/scripts/_common.sh'),
    join(workdir, 'plugin/scripts/_common.sh')
  );
  copyFileSync(
    join(REPO_ROOT, 'plugin/scripts/gate-claim.sh'),
    join(workdir, 'plugin/scripts/gate-claim.sh')
  );
  chmodSync(join(workdir, 'plugin/scripts/gate-claim.sh'), 0o755);

  // Bridge stub that returns an unrecognized response shape — exercises the
  // `*)` fall-through case in the dispatch switch (= "unhandled-response"
  // warn-class).
  writeFileSync(
    join(workdir, 'plugin/lib/bridge.js'),
    `#!/usr/bin/env bun
process.stdout.write(JSON.stringify({
  ok: false,
  error: { code: 'wat_is_this', message: 'simulated unhandled shape' }
}));
process.exit(0);
`,
    { mode: 0o755 }
  );
}

function setupActiveSession(workdir: string, sessionId: string) {
  const sessionDir = join(workdir, 'plugin-data/sessions', sessionId);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, 'active'), '');
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
    HOME: workdir,
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

describe('gate-claim.sh Tier-W warn surfacing', () => {
  it('unhandled bridge response emits teamem: <class> on stderr and exits 0', () => {
    const work = mkdtempSync(join(tmpdir(), 'teamem-warn-'));
    try {
      stageFakePlugin(work);
      gitInitWorkdir(work);
      setupActiveSession(work, 'sess-warn-1');

      const r = runGate(work, 'sess-warn-1', {
        file_path: join(work, 'x.ts')
      });
      expect(r.status).toBe(0);
      // stderr should contain `teamem: unhandled-response — ...`
      expect(r.stderr).toContain('teamem:');
      expect(r.stderr).toContain('unhandled-response');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 30_000);

  it('second invocation within rate-limit window suppresses the warn', () => {
    const work = mkdtempSync(join(tmpdir(), 'teamem-warn-rate-'));
    try {
      stageFakePlugin(work);
      gitInitWorkdir(work);
      setupActiveSession(work, 'sess-warn-2');

      const first = runGate(work, 'sess-warn-2', {
        file_path: join(work, 'a.ts')
      });
      expect(first.stderr).toContain('teamem:');

      const second = runGate(work, 'sess-warn-2', {
        file_path: join(work, 'b.ts')
      });
      expect(second.status).toBe(0);
      // Within the default 60s window the same warn-class is rate-limited.
      expect(second.stderr).not.toContain('teamem:');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 30_000);

  it('TEAMEM_HOOK_QUIET=1 silences Tier-W output on first invocation', () => {
    const work = mkdtempSync(join(tmpdir(), 'teamem-warn-quiet-'));
    try {
      stageFakePlugin(work);
      gitInitWorkdir(work);
      setupActiveSession(work, 'sess-warn-3');

      const r = runGate(
        work,
        'sess-warn-3',
        { file_path: join(work, 'q.ts') },
        { TEAMEM_HOOK_QUIET: '1' }
      );
      expect(r.status).toBe(0);
      expect(r.stderr).not.toContain('teamem:');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 30_000);

  it('hook-errors.log still records the unhandled response (silent or not)', () => {
    const work = mkdtempSync(join(tmpdir(), 'teamem-warn-log-'));
    try {
      stageFakePlugin(work);
      gitInitWorkdir(work);
      setupActiveSession(work, 'sess-warn-4');

      runGate(
        work,
        'sess-warn-4',
        { file_path: join(work, 'l.ts') },
        { TEAMEM_HOOK_QUIET: '1' }
      );
      const errorLog = join(work, '.cache/teamem/hook-errors.log');
      const logContents = readFileSync(errorLog, 'utf-8');
      expect(logContents).toContain('unhandled_response');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 30_000);
});
