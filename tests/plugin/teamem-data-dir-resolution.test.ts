import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dir, '../..');

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

describe('Teamem plugin data directory resolution', () => {
  it('ignores another plugin data dir when running from installed Teamem cache', () => {
    const work = join(
      tmpdir(),
      `teamem-data-dir-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );
    const home = join(work, 'home');
    const pluginRoot = join(
      home,
      '.claude/plugins/cache/teamem-local/teamem/0.3.4'
    );
    const repo = join(work, 'repo');

    try {
      mkdirSync(join(pluginRoot, 'scripts'), { recursive: true });
      mkdirSync(join(pluginRoot, 'bin'), { recursive: true });
      copyFileSync(
        join(REPO_ROOT, 'plugin/scripts/_common.sh'),
        join(pluginRoot, 'scripts/_common.sh')
      );
      copyFileSync(
        join(REPO_ROOT, 'plugin/bin/teamem-flag'),
        join(pluginRoot, 'bin/teamem-flag')
      );

      mkdirSync(repo, { recursive: true });
      gitSync(repo, ['init']);
      gitSync(repo, [
        'remote',
        'add',
        'origin',
        'https://github.com/mdn/todo-react'
      ]);
      writeFileSync(join(repo, 'README.md'), 'test\n');
      gitSync(repo, ['add', '.']);
      gitSync(repo, ['commit', '-m', 'initial']);

      const wrongData = join(home, '.claude/plugins/data/codex-openai-codex');
      const expectedData = join(
        home,
        '.claude/plugins/data/teamem-teamem-local'
      );
      const env = {
        ...process.env,
        HOME: home,
        CLAUDE_PLUGIN_DATA: wrongData,
        CLAUDE_SESSION_ID: 'default'
      };

      const enable = spawnSync(
        'bash',
        [join(pluginRoot, 'bin/teamem-flag'), 'enable', '--persist'],
        { cwd: repo, env, encoding: 'utf8' }
      );
      expect(enable.status).toBe(0);

      const status = spawnSync(
        'bash',
        [join(pluginRoot, 'bin/teamem-flag'), 'status'],
        { cwd: repo, env, encoding: 'utf8' }
      );
      expect(status.status).toBe(0);
      expect(status.stdout).toContain(
        `session_dir: ${expectedData}/sessions/default`
      );
      expect(status.stdout).not.toContain('codex-openai-codex');

      const autoOnFiles = spawnSync(
        'find',
        [join(home, '.claude/plugins/data'), '-name', 'auto-on', '-print'],
        { cwd: repo, env, encoding: 'utf8' }
      );
      expect(autoOnFiles.status).toBe(0);
      expect(autoOnFiles.stdout).toContain(expectedData);
      expect(autoOnFiles.stdout).not.toContain(wrongData);
      expect(existsSync(join(expectedData, 'sessions/default/active'))).toBe(
        true
      );
      expect(readFileSync(join(expectedData, 'plugin.log'), 'utf8')).toContain(
        'enabled'
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 30_000);

  it('uses local-marketplace data when a source plugin belongs to a local marketplace', () => {
    const work = join(
      tmpdir(),
      `teamem-source-data-dir-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );
    const home = join(work, 'home');
    const marketplaceRoot = join(work, 'teamem');
    const pluginRoot = join(marketplaceRoot, 'plugin');
    const repo = join(work, 'repo');

    try {
      mkdirSync(join(pluginRoot, 'scripts'), { recursive: true });
      mkdirSync(join(pluginRoot, 'bin'), { recursive: true });
      mkdirSync(join(pluginRoot, '.claude-plugin'), { recursive: true });
      mkdirSync(join(marketplaceRoot, '.claude-plugin'), { recursive: true });
      copyFileSync(
        join(REPO_ROOT, 'plugin/scripts/_common.sh'),
        join(pluginRoot, 'scripts/_common.sh')
      );
      copyFileSync(
        join(REPO_ROOT, 'plugin/bin/teamem-flag'),
        join(pluginRoot, 'bin/teamem-flag')
      );
      writeFileSync(
        join(pluginRoot, '.claude-plugin/plugin.json'),
        JSON.stringify({ name: 'teamem', version: '0.3.4' })
      );
      writeFileSync(
        join(marketplaceRoot, '.claude-plugin/marketplace.json'),
        JSON.stringify({ name: 'teamem-local', version: '0.3.4' })
      );

      mkdirSync(repo, { recursive: true });
      gitSync(repo, ['init']);
      gitSync(repo, [
        'remote',
        'add',
        'origin',
        'https://github.com/mdn/todo-react'
      ]);
      writeFileSync(join(repo, 'README.md'), 'test\n');
      gitSync(repo, ['add', '.']);
      gitSync(repo, ['commit', '-m', 'initial']);

      const wrongData = join(home, '.claude/plugins/data/codex-openai-codex');
      const expectedData = join(
        home,
        '.claude/plugins/data/teamem-teamem-local'
      );
      const env = {
        ...process.env,
        HOME: home,
        CLAUDE_PLUGIN_ROOT: pluginRoot,
        CLAUDE_PLUGIN_DATA: wrongData,
        CLAUDE_SESSION_ID: 'default'
      };

      const enable = spawnSync(
        'bash',
        [join(pluginRoot, 'bin/teamem-flag'), 'enable', '--persist'],
        { cwd: repo, env, encoding: 'utf8' }
      );
      expect(enable.status).toBe(0);

      const status = spawnSync(
        'bash',
        [join(pluginRoot, 'bin/teamem-flag'), 'status'],
        { cwd: repo, env, encoding: 'utf8' }
      );
      expect(status.status).toBe(0);
      expect(status.stdout).toContain(
        `session_dir: ${expectedData}/sessions/default`
      );
      expect(status.stdout).not.toContain('codex-openai-codex');

      const autoOnFiles = spawnSync(
        'find',
        [join(home, '.claude/plugins/data'), '-name', 'auto-on', '-print'],
        { cwd: repo, env, encoding: 'utf8' }
      );
      expect(autoOnFiles.status).toBe(0);
      expect(autoOnFiles.stdout).toContain(expectedData);
      expect(autoOnFiles.stdout).not.toContain(wrongData);
      expect(existsSync(join(expectedData, 'sessions/default/active'))).toBe(
        true
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 30_000);
});
