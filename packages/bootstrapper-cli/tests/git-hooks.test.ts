import { describe, expect, it } from 'bun:test';

import {
  createInteractiveGitHookPrompter,
  createGitHookInstaller,
  resolveInstalledPluginRoot,
  type GitHookFileSystem
} from '../src/git-hooks.js';
import type {
  CommandProbeResult,
  CommandRunner
} from '../src/prerequisites.js';

describe('createInteractiveGitHookPrompter', () => {
  it('uses the runtime prompt and defaults to installing hooks', () => {
    const writes: string[] = [];
    const prompter = createInteractiveGitHookPrompter(
      {
        stdout: { write: (text) => writes.push(text) },
        stderr: { write() {} }
      },
      {
        isInteractive: () => true,
        prompt: () => ''
      }
    );

    expect(prompter({ scope: 'project' })).toBe(true);
    expect(writes).toEqual([]);
  });

  it('accepts a negative answer without reading raw stdin', () => {
    const prompter = createInteractiveGitHookPrompter(
      { stdout: { write() {} }, stderr: { write() {} } },
      {
        isInteractive: () => true,
        prompt: () => 'n'
      }
    );

    expect(prompter({ scope: 'project' })).toBe(false);
  });

  it('reprompts on invalid answers', () => {
    const answers = ['maybe', 'yes'];
    const writes: string[] = [];
    const prompter = createInteractiveGitHookPrompter(
      {
        stdout: { write: (text) => writes.push(text) },
        stderr: { write() {} }
      },
      {
        isInteractive: () => true,
        prompt: () => answers.shift() ?? ''
      }
    );

    expect(prompter({ scope: 'project' })).toBe(true);
    expect(writes).toEqual(['Enter y, yes, n, no, or press Enter for yes.\n']);
  });

  it('skips prompting outside an interactive terminal', () => {
    const prompter = createInteractiveGitHookPrompter(
      { stdout: { write() {} }, stderr: { write() {} } },
      {
        isInteractive: () => false,
        prompt: () => {
          throw new Error('should not prompt');
        }
      }
    );

    expect(prompter({ scope: 'project' })).toBe(false);
  });
});

describe('resolveInstalledPluginRoot', () => {
  it('resolves the marketplace-installed plugin root for the selected scope', () => {
    const fileSystem = createMemoryGitHookFileSystem({
      '/plugins/teamem/git-hooks/post-commit': '#!/usr/bin/env bash\n',
      '/plugins/teamem/git-hooks/post-checkout': '#!/usr/bin/env bash\n'
    });

    const result = resolveInstalledPluginRoot({
      commandRunner: createFakeRunner({
        'claude plugin list --json': ok(
          JSON.stringify([
            {
              id: 'teamem@teamem-alpha',
              scope: 'project',
              installPath: '/plugins/teamem'
            }
          ])
        )
      }),
      fileSystem,
      scope: 'project'
    });

    expect(result).toEqual({
      ok: true,
      pluginRoot: '/plugins/teamem'
    });
  });
});

describe('createGitHookInstaller', () => {
  it('installs hooks from the installed plugin path and preserves non-teamem hooks as backups', () => {
    const fileSystem = createMemoryGitHookFileSystem({
      '/plugins/teamem/git-hooks/post-commit':
        '#!/usr/bin/env bash\n' + 'PLUGIN_ROOT="__TEAMEM_PLUGIN_ROOT__"\n',
      '/plugins/teamem/git-hooks/post-checkout':
        '#!/usr/bin/env bash\n' + 'PLUGIN_ROOT="__TEAMEM_PLUGIN_ROOT__"\n',
      '/repo/.git/hooks/post-commit': '#!/usr/bin/env bash\necho original\n'
    });

    const installer = createGitHookInstaller({
      cwd: '/repo',
      commandRunner: createFakeRunner({
        'claude plugin list --json': ok(
          JSON.stringify([
            {
              id: 'teamem@teamem-alpha',
              scope: 'project',
              installPath: '/plugins/teamem'
            }
          ])
        ),
        'git rev-parse --show-toplevel': ok('/repo\n'),
        'git config --get core.hooksPath': fail(''),
        'git rev-parse --git-path hooks': ok('.git/hooks\n')
      }),
      fileSystem
    });

    const result = installer.install({ scope: 'project' });

    expect(result.ok).toBe(true);
    expect(fileSystem.files.get('/repo/.git/hooks/post-commit')).toBe(
      '#!/usr/bin/env bash\n' +
        '# teamem-managed-hook\n' +
        'PLUGIN_ROOT="/plugins/teamem"\n'
    );
    expect(fileSystem.files.get('/repo/.git/hooks/post-checkout')).toBe(
      '#!/usr/bin/env bash\n' +
        '# teamem-managed-hook\n' +
        'PLUGIN_ROOT="/plugins/teamem"\n'
    );
    expect(
      fileSystem.files.get('/repo/.git/hooks/post-commit.teamem-backup')
    ).toBe('#!/usr/bin/env bash\necho original\n');
    expect(fileSystem.modes.get('/repo/.git/hooks/post-commit')).toBe(0o755);
    expect(fileSystem.modes.get('/repo/.git/hooks/post-checkout')).toBe(0o755);
  });

  it('fails clearly when a non-teamem hook backup already exists', () => {
    const fileSystem = createMemoryGitHookFileSystem({
      '/plugins/teamem/git-hooks/post-commit':
        '#!/usr/bin/env bash\n' + 'PLUGIN_ROOT="__TEAMEM_PLUGIN_ROOT__"\n',
      '/plugins/teamem/git-hooks/post-checkout':
        '#!/usr/bin/env bash\n' + 'PLUGIN_ROOT="__TEAMEM_PLUGIN_ROOT__"\n',
      '/repo/.git/hooks/post-commit': '#!/usr/bin/env bash\necho original\n',
      '/repo/.git/hooks/post-commit.teamem-backup':
        '#!/usr/bin/env bash\necho older backup\n'
    });

    const installer = createGitHookInstaller({
      cwd: '/repo',
      commandRunner: createFakeRunner({
        'claude plugin list --json': ok(
          JSON.stringify([
            {
              id: 'teamem@teamem-alpha',
              scope: 'project',
              installPath: '/plugins/teamem'
            }
          ])
        ),
        'git rev-parse --show-toplevel': ok('/repo\n'),
        'git config --get core.hooksPath': fail(''),
        'git rev-parse --git-path hooks': ok('.git/hooks\n')
      }),
      fileSystem
    });

    const result = installer.install({ scope: 'project' });

    expect(result.ok).toBe(false);
    expect(result.message).toContain(
      'post-commit already has a non-Teamem backup'
    );
  });
});

function createFakeRunner(
  table: Record<string, CommandProbeResult>
): CommandRunner {
  return {
    run(command: string, args: readonly string[]): CommandProbeResult {
      const key = [command, ...args].join(' ');
      const result = table[key];
      if (result) {
        return result;
      }
      throw new Error(`Unexpected command probe: ${key}`);
    }
  };
}

function ok(stdout: string): CommandProbeResult {
  return {
    exitCode: 0,
    stdout,
    stderr: ''
  };
}

function fail(stderr: string): CommandProbeResult {
  return {
    exitCode: 1,
    stdout: '',
    stderr
  };
}

function createMemoryGitHookFileSystem(
  initialFiles: Record<string, string>
): GitHookFileSystem & {
  files: Map<string, string>;
  modes: Map<string, number>;
} {
  const files = new Map(Object.entries(initialFiles));
  const modes = new Map<string, number>();

  return {
    files,
    modes,
    exists(path: string): boolean {
      return files.has(path);
    },
    readFile(path: string): string {
      const value = files.get(path);
      if (value === undefined) {
        throw new Error(`Missing file: ${path}`);
      }
      return value;
    },
    writeFile(
      path: string,
      content: string,
      options?: { readonly mode?: number }
    ): void {
      files.set(path, content);
      if (options?.mode !== undefined) {
        modes.set(path, options.mode);
      }
    },
    copyFile(source: string, destination: string): void {
      const value = files.get(source);
      if (value === undefined) {
        throw new Error(`Missing file: ${source}`);
      }
      files.set(destination, value);
    },
    mkdir(): void {},
    chmod(path: string, mode: number): void {
      modes.set(path, mode);
    }
  };
}
