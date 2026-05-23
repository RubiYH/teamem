import { describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = resolve(import.meta.dir, '../../..');
const CLI_PATH = join(REPO_ROOT, 'src/cli/teamem.ts');

function runBun(cwd: string, args: string[]) {
  const result = spawnSync('bun', ['run', CLI_PATH, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      // Real shells sync PWD with cwd via `cd`. spawnSync inherits PWD from
      // the parent process by default, which leaks the test runner's cwd
      // into the child and trips install-git-hooks.ts's PWD heuristic. Set
      // PWD = cwd to match real shell behavior.
      PWD: cwd,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@test.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@test.com'
    }
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? ''
  };
}

function gitInit(cwd: string): void {
  const result = spawnSync('git', ['init'], { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git init failed: ${result.stderr}`);
  }
}

describe('teamem CLI dispatcher', () => {
  it('routes install-git-hooks and succeeds inside a git repo', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'teamem-cli-test-'));
    try {
      const repoRoot = join(tmpDir, 'repo');
      mkdirSync(repoRoot, { recursive: true });
      gitInit(repoRoot);

      const result = runBun(repoRoot, ['install-git-hooks']);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('teamem: installed post-commit hook');
      expect(existsSync(join(repoRoot, '.git', 'hooks', 'post-commit'))).toBe(
        true
      );
      expect(existsSync(join(repoRoot, '.git', 'hooks', 'post-checkout'))).toBe(
        true
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('exits non-zero with usage for an unknown subcommand', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'teamem-cli-unknown-test-'));
    try {
      const result = runBun(tmpDir, ['wat']);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('Usage:');
      expect(result.stderr).toContain('install-git-hooks');
      expect(result.stderr).toContain('uninstall');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('routes uninstall to the reset CLI help without mutating state', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'teamem-cli-uninstall-test-'));
    try {
      const result = runBun(tmpDir, ['uninstall', '--help']);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Usage: bun run teamem uninstall');
      expect(result.stdout).toContain('--keep-credentials');
      expect(result.stdout).toContain('--keep-bridge');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
