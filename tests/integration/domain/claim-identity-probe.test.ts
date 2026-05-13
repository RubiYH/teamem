import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { probeClaimIdentity } from '../../../src/domain/claim-identity-probe.js';

let tmpDir: string;

function git(cwd: string, args: string[]): void {
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

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'teamem-probe-test-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('probeClaimIdentity', () => {
  it('returns repo-relative path for file in tree', async () => {
    git(tmpDir, ['init']);
    git(tmpDir, ['remote', 'add', 'origin', 'https://github.com/org/repo.git']);
    await writeFile(join(tmpDir, 'foo.ts'), 'export const x = 1;');
    git(tmpDir, ['add', '.']);
    git(tmpDir, ['commit', '-m', 'init']);

    const result = await probeClaimIdentity(join(tmpDir, 'foo.ts'));
    expect(result.repo_id).toBe('github.com/org/repo');
    expect(result.path).toBe('foo.ts');
    expect(result.branch).toBeTruthy();
    expect(result.head_sha).toBeTruthy();
  });

  it('returns repo-relative path for symlink in tree', async () => {
    git(tmpDir, ['init']);
    git(tmpDir, [
      'remote',
      'add',
      'origin',
      'https://github.com/org/symrepo.git'
    ]);
    await writeFile(join(tmpDir, 'real.ts'), 'export const x = 1;');
    await symlink(join(tmpDir, 'real.ts'), join(tmpDir, 'link.ts'));
    git(tmpDir, ['add', '.']);
    git(tmpDir, ['commit', '-m', 'init']);

    const result = await probeClaimIdentity(join(tmpDir, 'link.ts'));
    expect(result.repo_id).toBe('github.com/org/symrepo');
    expect(result.path).toBe('real.ts');
  });

  it('returns empty repo_id for file outside any git repo', async () => {
    // Use a path that has no .git parent
    const result = await probeClaimIdentity(
      '/tmp/nonexistent-file-for-probe-test-xyz.ts'
    );
    expect(result.repo_id).toBe('');
    expect(result.path).toBeNull();
    expect(result.branch).toBeNull();
    expect(result.head_sha).toBeNull();
  });

  it('falls back to toplevel path as repo_id when no remote.origin.url', async () => {
    git(tmpDir, ['init']);
    await writeFile(join(tmpDir, 'bar.ts'), 'export const y = 2;');
    git(tmpDir, ['add', '.']);
    git(tmpDir, ['commit', '-m', 'init']);

    const result = await probeClaimIdentity(join(tmpDir, 'bar.ts'));
    // No remote — repo_id should be the toplevel path itself
    expect(result.repo_id).toBeTruthy();
    expect(result.repo_id).not.toBe('');
    // It should contain the tmpDir path (or a realpath variant of it)
    expect(result.path).toBe('bar.ts');
    expect(result.branch).toBeTruthy();
  });
});
