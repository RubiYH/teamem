import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import {
  DEFAULT_DEMO_FEATURE_BRANCHES,
  DEFAULT_DEMO_INITIAL_BRANCH,
  createDemoRepositoryWorkspace,
  finishDemoRepositoryWorkspace,
  formatDemoWorkspaceReport
} from './teamem-demo-repository-workspace.js';

const repoRoot = resolve(import.meta.dir, '../..');

describe('demo repository workspace fixture', () => {
  it('copies the committed template into a temp workspace', async () => {
    const workspace = await createDemoRepositoryWorkspace({
      teamemSourceRoot: repoRoot
    });

    try {
      await expect(
        stat(join(workspace.demoWorkspaceLaunchCwd, 'README.md'))
      ).resolves.toBeTruthy();
      await expect(
        stat(join(workspace.demoWorkspaceLaunchCwd, 'TEAMEM.md'))
      ).resolves.toBeTruthy();
      await expect(
        stat(
          join(
            workspace.demoWorkspaceLaunchCwd,
            'src/features/collaboration-board.ts'
          )
        )
      ).resolves.toBeTruthy();
      await expect(
        stat(join(workspace.demoWorkspaceLaunchCwd, 'docs/operator-runbook.md'))
      ).resolves.toBeTruthy();
    } finally {
      await rm(workspace.demoWorkspaceLaunchCwd, {
        recursive: true,
        force: true
      });
    }
  });

  it('provides stable Teamem targets for smoke streams', async () => {
    const workspace = await createDemoRepositoryWorkspace({
      teamemSourceRoot: repoRoot
    });

    try {
      const teamemRules = await readFile(
        join(workspace.demoWorkspaceLaunchCwd, 'TEAMEM.md'),
        'utf8'
      );
      const readme = await readFile(
        join(workspace.demoWorkspaceLaunchCwd, 'README.md'),
        'utf8'
      );

      for (const target of [
        'src/app.ts',
        'src/features/collaboration-board.ts',
        'features/collaboration-board.md',
        'docs/operator-runbook.md',
        'TEAMEM.md'
      ]) {
        expect(teamemRules).toContain(target);
        expect(readme).toContain(target);
      }

      for (const stream of [
        'Space Rules',
        'Briefing Anchors',
        'Scope Claim Targets',
        'Git Handoff Targets',
        'Decisions And Gotchas',
        'Discussions'
      ]) {
        expect(teamemRules).toContain(stream);
      }
    } finally {
      await rm(workspace.demoWorkspaceLaunchCwd, {
        recursive: true,
        force: true
      });
    }
  });

  it('initializes deterministic git history and branches', async () => {
    const workspace = await createDemoRepositoryWorkspace({
      teamemSourceRoot: repoRoot
    });

    try {
      expect(
        git(workspace.demoWorkspaceLaunchCwd, ['branch', '--show-current'])
      ).toBe(DEFAULT_DEMO_INITIAL_BRANCH);
      expect(
        git(workspace.demoWorkspaceLaunchCwd, ['log', '--format=%s'])
      ).toBe('Initialize Teamem demo workspace');
      expect(
        git(workspace.demoWorkspaceLaunchCwd, ['log', '--format=%an'])
      ).toBe('Teamem Smoke Fixture');
      expect(
        git(workspace.demoWorkspaceLaunchCwd, ['log', '--format=%aI'])
      ).toBe('2026-01-01T00:00:00Z');

      const branches = git(workspace.demoWorkspaceLaunchCwd, [
        'branch',
        '--format=%(refname:short)'
      ])
        .split('\n')
        .sort();
      expect(branches).toEqual(
        [DEFAULT_DEMO_INITIAL_BRANCH, ...DEFAULT_DEMO_FEATURE_BRANCHES].sort()
      );
    } finally {
      await rm(workspace.demoWorkspaceLaunchCwd, {
        recursive: true,
        force: true
      });
    }
  });

  it('initializes git history under hostile caller git config', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'teamem-hostile-git-'));
    const hostileConfig = join(tempDir, 'gitconfig');
    const hostileHooksPath = join(tempDir, 'hooks');
    const hostileTemplateHooksPath = join(tempDir, 'template/hooks');
    const hostileHookMarker = join(tempDir, 'hostile-hook-ran');
    const hostileTemplateHookMarker = join(
      tempDir,
      'hostile-template-hook-ran'
    );
    const previousGitEnv = {
      GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
      GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT,
      GIT_CONFIG_KEY_0: process.env.GIT_CONFIG_KEY_0,
      GIT_CONFIG_VALUE_0: process.env.GIT_CONFIG_VALUE_0,
      GIT_DIR: process.env.GIT_DIR,
      GIT_WORK_TREE: process.env.GIT_WORK_TREE
    };

    await mkdir(hostileHooksPath, { recursive: true });
    await mkdir(hostileTemplateHooksPath, { recursive: true });
    await writeFile(
      join(hostileHooksPath, 'pre-commit'),
      `#!/bin/sh\ntouch "${hostileHookMarker}"\nexit 1\n`,
      { mode: 0o755 }
    );
    await writeFile(
      join(hostileTemplateHooksPath, 'pre-commit'),
      `#!/bin/sh\ntouch "${hostileTemplateHookMarker}"\nexit 1\n`,
      { mode: 0o755 }
    );
    await writeFile(
      hostileConfig,
      [
        '[commit]',
        '\tgpgsign = true',
        '[core]',
        `\thooksPath = ${hostileHooksPath}`,
        '[init]',
        `\ttemplateDir = ${join(tempDir, 'template')}`,
        ''
      ].join('\n')
    );

    process.env.GIT_CONFIG_GLOBAL = hostileConfig;
    process.env.GIT_CONFIG_COUNT = '1';
    process.env.GIT_CONFIG_KEY_0 = 'core.hooksPath';
    process.env.GIT_CONFIG_VALUE_0 = hostileHooksPath;
    process.env.GIT_DIR = join(tempDir, 'not-the-demo-git-dir');
    process.env.GIT_WORK_TREE = tempDir;

    let workspace:
      | Awaited<ReturnType<typeof createDemoRepositoryWorkspace>>
      | undefined;

    try {
      workspace = await createDemoRepositoryWorkspace({
        teamemSourceRoot: repoRoot
      });

      expect(
        git(workspace.demoWorkspaceLaunchCwd, ['branch', '--show-current'])
      ).toBe(DEFAULT_DEMO_INITIAL_BRANCH);
      expect(
        git(workspace.demoWorkspaceLaunchCwd, ['log', '--format=%s'])
      ).toBe('Initialize Teamem demo workspace');
      expect(existsSync(hostileHookMarker)).toBe(false);
      expect(existsSync(hostileTemplateHookMarker)).toBe(false);
    } finally {
      for (const [key, value] of Object.entries(previousGitEnv)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      if (workspace) {
        await rm(workspace.demoWorkspaceLaunchCwd, {
          recursive: true,
          force: true
        });
      }
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('reports source root separately from demo launch cwd', async () => {
    const workspace = await createDemoRepositoryWorkspace({
      teamemSourceRoot: repoRoot
    });

    try {
      const report = formatDemoWorkspaceReport(workspace);

      expect(report.teamemSourceRoot).toBe(repoRoot);
      expect(report.demoWorkspaceLaunchCwd).toBe(
        workspace.demoWorkspaceLaunchCwd
      );
      expect(report.teamemSourceRoot).not.toBe(report.demoWorkspaceLaunchCwd);
      expect(String(report.demoWorkspaceLaunchCwd).startsWith(repoRoot)).toBe(
        false
      );
    } finally {
      await rm(workspace.demoWorkspaceLaunchCwd, {
        recursive: true,
        force: true
      });
    }
  });

  it('removes copied demo workspaces on successful cleanup', async () => {
    const workspace = await createDemoRepositoryWorkspace({
      teamemSourceRoot: repoRoot
    });

    const result = await finishDemoRepositoryWorkspace(workspace, {
      success: true
    });

    expect(result.preserved).toBe(false);
    expect(existsSync(workspace.demoWorkspaceLaunchCwd)).toBe(false);
  });

  it('refuses to delete a mistaken workspace pointing at the source root', async () => {
    const fakeSourceRoot = await mkdtemp(join(tmpdir(), 'teamem-source-root-'));
    const templateRoot = join(
      fakeSourceRoot,
      'tests/fixtures/demo-repository-template'
    );
    await mkdir(templateRoot, { recursive: true });

    try {
      const workspace = {
        teamemSourceRoot: fakeSourceRoot,
        templateRoot,
        demoWorkspaceLaunchCwd: fakeSourceRoot,
        initialBranch: DEFAULT_DEMO_INITIAL_BRANCH,
        featureBranches: [...DEFAULT_DEMO_FEATURE_BRANCHES]
      };

      await expect(
        finishDemoRepositoryWorkspace(workspace, { success: true })
      ).rejects.toThrow('Refusing to delete unsafe demo workspace');
      expect(existsSync(fakeSourceRoot)).toBe(true);
      expect(existsSync(templateRoot)).toBe(true);
    } finally {
      await rm(fakeSourceRoot, { recursive: true, force: true });
    }
  });

  it('refuses to delete a mistaken workspace pointing at the template root', async () => {
    const fakeSourceRoot = await mkdtemp(join(tmpdir(), 'teamem-source-root-'));
    const templateRoot = join(
      fakeSourceRoot,
      'tests/fixtures/demo-repository-template'
    );
    await mkdir(templateRoot, { recursive: true });

    try {
      const workspace = {
        teamemSourceRoot: fakeSourceRoot,
        templateRoot,
        demoWorkspaceLaunchCwd: templateRoot,
        initialBranch: DEFAULT_DEMO_INITIAL_BRANCH,
        featureBranches: [...DEFAULT_DEMO_FEATURE_BRANCHES]
      };

      await expect(
        finishDemoRepositoryWorkspace(workspace, { success: true })
      ).rejects.toThrow('Refusing to delete unsafe demo workspace');
      expect(existsSync(fakeSourceRoot)).toBe(true);
      expect(existsSync(templateRoot)).toBe(true);
    } finally {
      await rm(fakeSourceRoot, { recursive: true, force: true });
    }
  });

  it('refuses to delete arbitrary same-prefix directories on successful cleanup', async () => {
    const tempParentDir = await mkdtemp(join(tmpdir(), 'teamem-demo-parent-'));
    const arbitraryWorkspace = join(
      tempParentDir,
      'teamem-demo-workspace-fake'
    );
    const markerPath = join(arbitraryWorkspace, 'keep-me.txt');
    const fakeSourceRoot = join(tempParentDir, 'source-root');
    const templateRoot = join(
      fakeSourceRoot,
      'tests/fixtures/demo-repository-template'
    );

    await mkdir(arbitraryWorkspace, { recursive: true });
    await mkdir(templateRoot, { recursive: true });
    await writeFile(markerPath, 'not helper-created\n');

    try {
      const workspace = {
        teamemSourceRoot: fakeSourceRoot,
        templateRoot,
        demoWorkspaceLaunchCwd: arbitraryWorkspace,
        initialBranch: DEFAULT_DEMO_INITIAL_BRANCH,
        featureBranches: [...DEFAULT_DEMO_FEATURE_BRANCHES]
      };

      await expect(
        finishDemoRepositoryWorkspace(workspace, { success: true })
      ).rejects.toThrow('Refusing to delete unsafe demo workspace');
      expect(existsSync(arbitraryWorkspace)).toBe(true);
      expect(await readFile(markerPath, 'utf8')).toBe('not helper-created\n');
    } finally {
      await rm(tempParentDir, { recursive: true, force: true });
    }
  });

  it('preserves failed demo workspaces and writes artifact paths', async () => {
    const artifactsDir = await mkdtemp(
      join(tmpdir(), 'teamem-demo-artifacts-')
    );
    const workspace = await createDemoRepositoryWorkspace({
      teamemSourceRoot: repoRoot
    });

    try {
      const result = await finishDemoRepositoryWorkspace(workspace, {
        success: false,
        artifactsDir
      });

      expect(result.preserved).toBe(true);
      expect(existsSync(workspace.demoWorkspaceLaunchCwd)).toBe(true);
      expect(result.artifactPath).toBe(
        join(artifactsDir, `${basename(workspace.demoWorkspaceLaunchCwd)}.json`)
      );

      const artifact = JSON.parse(
        await readFile(result.artifactPath ?? '', 'utf8')
      ) as Record<string, unknown>;
      expect(artifact.teamemSourceRoot).toBe(repoRoot);
      expect(artifact.demoWorkspaceLaunchCwd).toBe(
        workspace.demoWorkspaceLaunchCwd
      );
      expect(artifact.teamemSourceRoot).not.toBe(
        artifact.demoWorkspaceLaunchCwd
      );
    } finally {
      await rm(workspace.demoWorkspaceLaunchCwd, {
        recursive: true,
        force: true
      });
      await rm(artifactsDir, { recursive: true, force: true });
    }
  });

  it('writes unique failure artifacts for multiple preserved workspaces', async () => {
    const artifactsDir = await mkdtemp(
      join(tmpdir(), 'teamem-demo-artifacts-')
    );
    const firstWorkspace = await createDemoRepositoryWorkspace({
      teamemSourceRoot: repoRoot
    });
    const secondWorkspace = await createDemoRepositoryWorkspace({
      teamemSourceRoot: repoRoot
    });

    try {
      const firstResult = await finishDemoRepositoryWorkspace(firstWorkspace, {
        success: false,
        artifactsDir
      });
      const secondResult = await finishDemoRepositoryWorkspace(
        secondWorkspace,
        {
          success: false,
          artifactsDir
        }
      );

      expect(firstResult.artifactPath).toBeTruthy();
      expect(secondResult.artifactPath).toBeTruthy();
      expect(firstResult.artifactPath).not.toBe(secondResult.artifactPath);

      const firstArtifact = JSON.parse(
        await readFile(firstResult.artifactPath ?? '', 'utf8')
      ) as Record<string, unknown>;
      const secondArtifact = JSON.parse(
        await readFile(secondResult.artifactPath ?? '', 'utf8')
      ) as Record<string, unknown>;

      expect(firstArtifact.demoWorkspaceLaunchCwd).toBe(
        firstWorkspace.demoWorkspaceLaunchCwd
      );
      expect(secondArtifact.demoWorkspaceLaunchCwd).toBe(
        secondWorkspace.demoWorkspaceLaunchCwd
      );
    } finally {
      await rm(firstWorkspace.demoWorkspaceLaunchCwd, {
        recursive: true,
        force: true
      });
      await rm(secondWorkspace.demoWorkspaceLaunchCwd, {
        recursive: true,
        force: true
      });
      await rm(artifactsDir, { recursive: true, force: true });
    }
  });
});

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8'
  });

  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed in ${cwd}: ${result.stderr || result.stdout}`
    );
  }

  return result.stdout.trim();
}
