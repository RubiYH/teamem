import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
  chmodSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  installGitHooks,
  uninstallGitHooks
} from '../../../src/cli/install-git-hooks.js';

const REPO_ROOT = resolve(import.meta.dir, '../../..');
const SOURCE_PLUGIN_ROOT = join(REPO_ROOT, 'plugin');

function gitSync(
  cwd: string,
  args: string[],
  env?: Record<string, string>
): { stdout: string; stderr: string; status: number } {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@test.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@test.com',
      ...env
    }
  });
  if (r.status !== 0)
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return {
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    status: r.status ?? 1
  };
}

function makeFakePluginRoot(workdir: string, sentinel: string): string {
  const pluginRoot = join(workdir, 'fake-plugin');
  mkdirSync(join(pluginRoot, 'scripts'), { recursive: true });
  mkdirSync(join(pluginRoot, 'lib'), { recursive: true });
  writeFileSync(
    join(pluginRoot, 'scripts', '_common.sh'),
    '#!/usr/bin/env bash\n',
    { mode: 0o755 }
  );
  writeFileSync(
    join(pluginRoot, 'lib', 'bridge.js'),
    `#!/usr/bin/env bun
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(sentinel)}, JSON.stringify(process.argv.slice(2)) + '\\n');
process.stdout.write(JSON.stringify({ ok: true, data: {} }));
`,
    { mode: 0o755 }
  );
  chmodSync(join(pluginRoot, 'lib', 'bridge.js'), 0o755);
  return pluginRoot;
}

function makeFakePluginRootAt(pluginRoot: string, sentinel: string): string {
  mkdirSync(join(pluginRoot, 'scripts'), { recursive: true });
  mkdirSync(join(pluginRoot, 'git-hooks'), { recursive: true });
  mkdirSync(join(pluginRoot, 'lib'), { recursive: true });
  writeFileSync(
    join(pluginRoot, 'scripts', '_common.sh'),
    '#!/usr/bin/env bash\n',
    { mode: 0o755 }
  );
  writeFileSync(
    join(pluginRoot, 'lib', 'bridge.js'),
    `#!/usr/bin/env bun
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(sentinel)}, JSON.stringify(process.argv.slice(2)) + '\\n');
process.stdout.write(JSON.stringify({ ok: true, data: {} }));
`,
    { mode: 0o755 }
  );
  chmodSync(join(pluginRoot, 'lib', 'bridge.js'), 0o755);
  return pluginRoot;
}

let tmpDir: string;
let repoRoot: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'teamem-install-hooks-test-'));
  repoRoot = join(tmpDir, 'repo');
  mkdirSync(repoRoot, { recursive: true });
  gitSync(repoRoot, ['init']);
  // Ensure .git/hooks dir exists (it does by default but let's be safe)
  mkdirSync(join(repoRoot, '.git', 'hooks'), { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('installGitHooks', () => {
  it('writes post-commit hook to .git/hooks/', () => {
    installGitHooks(repoRoot);
    const hookPath = join(repoRoot, '.git', 'hooks', 'post-commit');
    expect(existsSync(hookPath)).toBe(true);
    const content = readFileSync(hookPath, 'utf-8');
    expect(content.split('\n')[1]).toBe('# teamem-managed-hook');
    expect(content).toContain('teamem');
    expect(content).toContain('release_scope_via_git');
    expect(content).toContain(SOURCE_PLUGIN_ROOT);
    expect(content).not.toContain('__TEAMEM_PLUGIN_ROOT__');
    expect(
      existsSync(join(repoRoot, '.git', 'hooks', 'post-commit.teamem-backup'))
    ).toBe(false);
  });

  it('installs self-contained hooks that do not need a repo-local plugin directory', () => {
    installGitHooks(repoRoot);
    const hookPath = join(repoRoot, '.git', 'hooks', 'post-commit');
    expect(existsSync(join(repoRoot, 'plugin'))).toBe(false);
    const content = readFileSync(hookPath, 'utf-8');
    expect(content).toContain(SOURCE_PLUGIN_ROOT);

    const result = spawnSync('bash', [hookPath], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, TEAMEM_POST_COMMIT_SYNC: '1' }
    });

    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain('plugin root not found');
  });

  it('keeps the source-tree dev fallback working when hooks run from a repo-local plugin directory', () => {
    const sentinel = join(tmpDir, 'dev-mode-hooks.log');
    const pluginRoot = makeFakePluginRootAt(join(repoRoot, 'plugin'), sentinel);
    const hookPath = join(repoRoot, '.git', 'hooks', 'post-commit');
    writeFileSync(
      hookPath,
      readFileSync(
        join(SOURCE_PLUGIN_ROOT, 'git-hooks', 'post-commit'),
        'utf-8'
      ),
      { mode: 0o755 }
    );
    chmodSync(hookPath, 0o755);

    writeFileSync(join(repoRoot, 'file.txt'), 'one\n');
    gitSync(repoRoot, ['add', '.']);
    gitSync(repoRoot, ['commit', '-m', 'initial'], {
      TEAMEM_POST_COMMIT_SYNC: '1'
    });

    expect(pluginRoot).toBe(join(repoRoot, 'plugin'));
    expect(readFileSync(sentinel, 'utf-8')).toContain('release_scope_via_git');
  });

  it('backs up existing hook before overwriting', () => {
    const hookPath = join(repoRoot, '.git', 'hooks', 'post-commit');
    const backupPath = join(
      repoRoot,
      '.git',
      'hooks',
      'post-commit.teamem-backup'
    );
    writeFileSync(hookPath, '#!/bin/sh\necho "existing hook"\n', {
      mode: 0o755
    });

    installGitHooks(repoRoot);

    expect(existsSync(backupPath)).toBe(true);
    const backup = readFileSync(backupPath, 'utf-8');
    expect(backup).toContain('existing hook');
  });

  it('is idempotent — re-running with identical content does not re-backup', () => {
    installGitHooks(repoRoot);
    const backupPath = join(
      repoRoot,
      '.git',
      'hooks',
      'post-commit.teamem-backup'
    );
    expect(existsSync(backupPath)).toBe(false);

    // Second run — content is identical, should not create backup
    installGitHooks(repoRoot);
    expect(existsSync(backupPath)).toBe(false);
  });

  it('re-install over a teamem hook does not touch an existing backup', () => {
    installGitHooks(repoRoot);
    const backupPath = join(
      repoRoot,
      '.git',
      'hooks',
      'post-commit.teamem-backup'
    );
    writeFileSync(backupPath, 'original backup\n');

    installGitHooks(repoRoot);

    expect(readFileSync(backupPath, 'utf-8')).toBe('original backup\n');
  });

  it('aborts when a non-teamem hook exists and a backup is already present', () => {
    const hookPath = join(repoRoot, '.git', 'hooks', 'post-commit');
    const backupPath = join(
      repoRoot,
      '.git',
      'hooks',
      'post-commit.teamem-backup'
    );
    writeFileSync(hookPath, '#!/bin/sh\necho "existing hook"\n', {
      mode: 0o755
    });
    writeFileSync(backupPath, 'prior backup\n');

    expect(() => installGitHooks(repoRoot)).toThrow(
      'Cannot install: a non-teamem hook exists and a backup is already present at .teamem-backup. Resolve manually.'
    );
    expect(readFileSync(hookPath, 'utf-8')).toContain('existing hook');
    expect(readFileSync(backupPath, 'utf-8')).toBe('prior backup\n');
  });

  it('installs hooks into core.hooksPath and git fires them', () => {
    const hooksDir = join(repoRoot, '.githooks');
    gitSync(repoRoot, ['config', 'core.hooksPath', '.githooks']);
    installGitHooks(repoRoot);
    expect(existsSync(join(hooksDir, 'post-commit'))).toBe(true);

    const sentinel = join(tmpDir, 'hooks.log');
    const pluginRoot = makeFakePluginRoot(tmpDir, sentinel);
    writeFileSync(join(repoRoot, 'file.txt'), 'one\n');
    gitSync(repoRoot, ['add', '.']);
    gitSync(repoRoot, ['commit', '-m', 'initial'], {
      TEAMEM_PLUGIN_ROOT: pluginRoot
    });
    Bun.sleepSync(500);

    expect(readFileSync(sentinel, 'utf-8')).toContain('release_scope_via_git');
  });

  it('installs and fires hooks in a linked worktree', () => {
    writeFileSync(join(repoRoot, 'file.txt'), 'one\n');
    gitSync(repoRoot, ['add', '.']);
    gitSync(repoRoot, ['commit', '-m', 'initial']);
    const worktreeRoot = join(tmpDir, 'worktree');
    gitSync(repoRoot, ['worktree', 'add', '-b', 'feature/test', worktreeRoot]);

    installGitHooks(worktreeRoot);
    const hookPath = resolve(
      worktreeRoot,
      gitSync(worktreeRoot, ['rev-parse', '--git-path', 'hooks']).stdout.trim(),
      'post-commit'
    );
    expect(existsSync(hookPath)).toBe(true);

    const sentinel = join(tmpDir, 'worktree-hooks.log');
    const pluginRoot = makeFakePluginRoot(tmpDir, sentinel);
    writeFileSync(join(worktreeRoot, 'file.txt'), 'two\n');
    gitSync(worktreeRoot, ['add', '.']);
    gitSync(worktreeRoot, ['commit', '-m', 'worktree update'], {
      TEAMEM_PLUGIN_ROOT: pluginRoot
    });
    Bun.sleepSync(500);

    expect(readFileSync(sentinel, 'utf-8')).toContain('release_scope_via_git');
  });
});

describe('uninstallGitHooks', () => {
  it('removes the hook and restores backup if present', () => {
    const hookPath = join(repoRoot, '.git', 'hooks', 'post-commit');
    const backupPath = join(
      repoRoot,
      '.git',
      'hooks',
      'post-commit.teamem-backup'
    );
    const originalContent = '#!/bin/sh\necho "original"\n';
    writeFileSync(hookPath, originalContent, { mode: 0o755 });

    installGitHooks(repoRoot);
    expect(existsSync(backupPath)).toBe(true);

    uninstallGitHooks(repoRoot);
    expect(existsSync(backupPath)).toBe(false);
    // Original hook restored
    expect(existsSync(hookPath)).toBe(true);
    expect(readFileSync(hookPath, 'utf-8')).toBe(originalContent);
  });

  it('removes hook without backup when no backup exists', () => {
    installGitHooks(repoRoot);
    const hookPath = join(repoRoot, '.git', 'hooks', 'post-commit');
    expect(existsSync(hookPath)).toBe(true);

    uninstallGitHooks(repoRoot);
    expect(existsSync(hookPath)).toBe(false);
  });

  it('does not remove non-teamem hooks during uninstall', () => {
    const hookPath = join(repoRoot, '.git', 'hooks', 'post-commit');
    const originalContent = '#!/bin/sh\necho "user hook"\n';
    writeFileSync(hookPath, originalContent, { mode: 0o755 });

    uninstallGitHooks(repoRoot);

    expect(readFileSync(hookPath, 'utf-8')).toBe(originalContent);
  });

  it('restores backups from core.hooksPath', () => {
    const hooksDir = join(repoRoot, '.githooks');
    gitSync(repoRoot, ['config', 'core.hooksPath', '.githooks']);
    mkdirSync(hooksDir, { recursive: true });
    const hookPath = join(hooksDir, 'post-checkout');
    const backupPath = join(hooksDir, 'post-checkout.teamem-backup');
    writeFileSync(
      hookPath,
      '#!/usr/bin/env bash\n# teamem-managed-hook\nteamem\n',
      { mode: 0o755 }
    );
    writeFileSync(backupPath, '#!/bin/sh\necho "original checkout"\n', {
      mode: 0o755
    });

    uninstallGitHooks(repoRoot);

    expect(existsSync(backupPath)).toBe(false);
    expect(readFileSync(hookPath, 'utf-8')).toBe(
      '#!/bin/sh\necho "original checkout"\n'
    );
  });
});
