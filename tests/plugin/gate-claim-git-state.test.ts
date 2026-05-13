/**
 * Slice #30 — gate-claim.sh git-state probes.
 *
 * AC coverage:
 *  - Outside any git repo: gate exits 0 silently (no stderr, no bridge call).
 *  - Inside repo with detached HEAD: gate exits 0, stderr contains
 *    'teamem:' and 'detached-head'; bridge NOT called.
 *  - Detached HEAD warn rate-limited: second invocation within 60s window
 *    produces no second warn.
 *  - Normal branch: gate DOES call bridge (claim_scope).
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
  existsSync,
  readFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dir, '../..');

function stageFakePlugin(workdir: string, sentinel: string) {
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
}

function setupActiveSession(workdir: string, sessionId: string) {
  const sessionDir = join(workdir, 'plugin-data/sessions', sessionId);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, 'active'), '');
}

function gitSync(cwd: string, args: string[]): void {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@test.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@test.com'
    }
  });
  if (r.status !== 0)
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
}

function createGitRepo(workdir: string): { repoDir: string; filePath: string } {
  const repoDir = join(workdir, 'git-repo');
  mkdirSync(repoDir, { recursive: true });
  gitSync(repoDir, ['init']);
  gitSync(repoDir, [
    'remote',
    'add',
    'origin',
    'https://github.com/org/test-repo.git'
  ]);
  writeFileSync(join(repoDir, 'README.md'), 'test');
  gitSync(repoDir, ['add', '.']);
  gitSync(repoDir, ['commit', '-m', 'initial']);
  const filePath = join(repoDir, 'src', 'Form.tsx');
  mkdirSync(join(repoDir, 'src'), { recursive: true });
  writeFileSync(filePath, 'export const Form = () => null;');
  gitSync(repoDir, ['add', '.']);
  gitSync(repoDir, ['commit', '-m', 'add form']);
  return { repoDir, filePath };
}

function runGate(
  workdir: string,
  sessionId: string,
  filePath: string,
  cwd: string,
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
    tool_input: { file_path: filePath },
    cwd
  });
  return spawnSync('bash', [join(workdir, 'plugin/scripts/gate-claim.sh')], {
    env,
    input: stdin,
    encoding: 'utf-8',
    timeout: 15_000
  });
}

describe('gate-claim.sh git-state probes (slice #30)', () => {
  it('inactive session: exits 0 and traces skip_inactive for diagnosis', () => {
    const work = mkdtempSync(join(tmpdir(), 'teamem-git-state-inactive-'));
    try {
      const sentinel = join(work, 'argv.log');
      stageFakePlugin(work, sentinel);
      const { repoDir, filePath } = createGitRepo(work);

      const r = runGate(work, 'sess-inactive-1', filePath, repoDir);

      expect(r.status).toBe(0);
      expect(existsSync(sentinel)).toBe(false);
      const trace = readFileSync(
        join(work, '.cache/teamem/hook-trace.log'),
        'utf-8'
      );
      expect(trace).toContain('"decision":"skip_inactive"');
      expect(trace).toContain('"session":"sess-inactive-1"');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 30_000);

  it('outside any git repo: exits 0 silently, bridge never called', () => {
    const work = mkdtempSync(join(tmpdir(), 'teamem-git-state-outside-'));
    try {
      const sentinel = join(work, 'argv.log');
      stageFakePlugin(work, sentinel);
      setupActiveSession(work, 'sess-outside-1');

      // Use a non-git temp dir as the file location
      const nonGitDir = mkdtempSync(join(tmpdir(), 'teamem-non-git-'));
      const scratchFile = join(nonGitDir, 'scratch.ts');
      writeFileSync(scratchFile, 'const x = 1;');

      const r = runGate(work, 'sess-outside-1', scratchFile, nonGitDir);

      expect(r.status).toBe(0);
      // No stderr output (Tier-S silent)
      expect(r.stderr).toBe('');
      // Bridge must NOT have been called
      expect(existsSync(sentinel)).toBe(false);

      rmSync(nonGitDir, { recursive: true, force: true });
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 30_000);

  it('detached HEAD: exits 0, emits teamem: detached-head on stderr, bridge never called', () => {
    const work = mkdtempSync(join(tmpdir(), 'teamem-git-state-detached-'));
    try {
      const sentinel = join(work, 'argv.log');
      stageFakePlugin(work, sentinel);
      setupActiveSession(work, 'sess-detached-1');

      const { repoDir, filePath } = createGitRepo(work);

      // Detach HEAD
      const headSha = spawnSync('git', ['rev-parse', 'HEAD'], {
        cwd: repoDir,
        encoding: 'utf8'
      }).stdout.trim();
      gitSync(repoDir, ['checkout', headSha]);

      const r = runGate(work, 'sess-detached-1', filePath, repoDir);

      expect(r.status).toBe(0);
      // Must emit Tier-W warn to stderr
      expect(r.stderr).toContain('teamem:');
      expect(r.stderr).toContain('detached-head');
      // Bridge must NOT have been called
      expect(existsSync(sentinel)).toBe(false);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 30_000);

  it('detached HEAD warn is rate-limited: second invocation within 60s window produces no second warn', () => {
    const work = mkdtempSync(join(tmpdir(), 'teamem-git-state-detached-rate-'));
    try {
      const sentinel = join(work, 'argv.log');
      stageFakePlugin(work, sentinel);
      setupActiveSession(work, 'sess-detached-rate-1');

      const { repoDir, filePath } = createGitRepo(work);
      const headSha = spawnSync('git', ['rev-parse', 'HEAD'], {
        cwd: repoDir,
        encoding: 'utf8'
      }).stdout.trim();
      gitSync(repoDir, ['checkout', headSha]);

      const first = runGate(work, 'sess-detached-rate-1', filePath, repoDir);
      expect(first.status).toBe(0);
      expect(first.stderr).toContain('teamem:');

      const second = runGate(work, 'sess-detached-rate-1', filePath, repoDir);
      expect(second.status).toBe(0);
      // Rate-limited — no second warn within the 60s window
      expect(second.stderr).not.toContain('teamem:');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 30_000);

  it('normal branch: gate calls bridge (claim_scope)', () => {
    const work = mkdtempSync(join(tmpdir(), 'teamem-git-state-normal-'));
    try {
      const sentinel = join(work, 'argv.log');
      stageFakePlugin(work, sentinel);
      setupActiveSession(work, 'sess-normal-1');

      const { repoDir, filePath } = createGitRepo(work);

      const r = runGate(work, 'sess-normal-1', filePath, repoDir, {
        TEAMEM_SPACE: 'default'
      });

      expect(r.status).toBe(0);
      // Bridge MUST have been called (sentinel file exists)
      expect(existsSync(sentinel)).toBe(true);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 30_000);
});
