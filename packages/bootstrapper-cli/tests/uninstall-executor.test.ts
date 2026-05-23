import { describe, expect, it } from 'bun:test';

import {
  executeUninstall,
  renderUninstallExecutionReport,
  type LocalStateFileSystem
} from '../src/uninstall-executor.js';
import type { GitHookInstaller } from '../src/git-hooks.js';
import type {
  CommandProbeResult,
  CommandRunner
} from '../src/prerequisites.js';
import type { BootstrapperFileSystem } from '../src/plugin-installer.js';

describe('executeUninstall', () => {
  it('continues hook and local cleanup after Claude plugin command failures', () => {
    const commandRunner = createRecordingRunner({
      'claude plugin uninstall teamem@teamem-alpha --scope user --prune -y':
        fail('plugin uninstall failed'),
      'claude plugin marketplace remove teamem-alpha': ok('removed')
    });
    const localStateFileSystem = createLocalStateFileSystemStub();
    const gitHookInstaller = createGitHookInstallerStub();

    const result = executeUninstall({
      cwd: '/repo',
      commandRunner,
      scopeFileSystem: createMemoryFileSystem({
        '/repo/.teamem/bootstrapper.json': '{ "pluginScope": "user" }'
      }),
      localStateFileSystem,
      gitHookInstaller,
      homeDir: '/home/alice',
      dryRun: false
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe('partial');
    expect(commandRunner.invocations).toEqual([
      'claude plugin uninstall teamem@teamem-alpha --scope user --prune -y',
      'claude plugin marketplace remove teamem-alpha'
    ]);
    expect(gitHookInstaller.uninstallInvocations).toBe(1);
    expect(localStateFileSystem.removedPaths).toContain(
      '/home/alice/.teamem/credentials.json'
    );
    expect(localStateFileSystem.removedPaths).toContain(
      '/home/alice/.claude/plugins/data/teamem-teamem-alpha'
    );
    expect(result.commandFailures).toHaveLength(1);

    const report = renderUninstallExecutionReport(result, { dryRun: false });
    expect(report).toContain(
      'partial: some uninstall steps failed; completed remaining cleanup where possible'
    );
    expect(report).toContain('Failed commands:');
    expect(report).not.toContain(
      'executed: Teamem plugin uninstall and local cleanup completed'
    );
  });

  it('clears known plugin data paths that hold sessions and persistent auto-on state', () => {
    const localStateFileSystem = createLocalStateFileSystemStub();
    const result = executeUninstall({
      cwd: '/repo',
      commandRunner: createRecordingRunner({
        'claude plugin uninstall teamem@teamem-alpha --scope local --prune -y':
          ok('uninstalled'),
        'claude plugin marketplace remove teamem-alpha': ok('removed')
      }),
      scopeFileSystem: createMemoryFileSystem(),
      localStateFileSystem,
      gitHookInstaller: createGitHookInstallerStub(),
      homeDir: '/home/alice',
      dryRun: false,
      requestedScope: 'local'
    });

    expect(result.ok).toBe(true);
    expect(localStateFileSystem.removedPaths).toEqual([
      '/home/alice/.teamem/credentials.json',
      '/home/alice/.teamem/run',
      '/home/alice/.cache/teamem',
      '/home/alice/.claude/plugins/data/teamem',
      '/home/alice/.claude/plugins/data/teamem-teamem-alpha',
      '/home/alice/.claude/plugins/data/teamem-teamem-local',
      '/home/alice/.claude/plugins/data/teamem-teamem2-local',
      '/home/alice/.claude/plugins/data/teamem2',
      '/home/alice/.claude/plugins/data/teamem2-teamem-alpha',
      '/home/alice/.claude/plugins/data/teamem2-teamem-local',
      '/home/alice/.claude/plugins/data/teamem2-teamem2-local',
      '/home/alice/.claude/plugins/data/teamem2-inline',
      '/home/alice/.claude/plugins/data/teamem-inline',
      '/repo/.teamem/bootstrapper.json'
    ]);
  });
});

function createRecordingRunner(
  table: Record<string, CommandProbeResult>
): CommandRunner & { invocations: string[] } {
  const invocations: string[] = [];
  return {
    invocations,
    run(command: string, args: readonly string[]): CommandProbeResult {
      const key = [command, ...args].join(' ');
      invocations.push(key);
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

function createMemoryFileSystem(
  initialFiles: Record<string, string> = {}
): BootstrapperFileSystem & { files: Map<string, string> } {
  const files = new Map(Object.entries(initialFiles));

  return {
    files,
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
    writeFile(path: string, content: string): void {
      files.set(path, content);
    },
    mkdir(): void {}
  };
}

function createLocalStateFileSystemStub(): LocalStateFileSystem & {
  removedPaths: string[];
} {
  const removedPaths: string[] = [];
  return {
    removedPaths,
    rm(path: string): void {
      removedPaths.push(path);
    }
  };
}

function createGitHookInstallerStub(): GitHookInstaller & {
  uninstallInvocations: number;
} {
  const installer = {
    uninstallInvocations: 0,
    install() {
      return {
        ok: true,
        exitCode: 0,
        message: 'Installed Teamem git hooks.'
      } as const;
    },
    uninstall() {
      installer.uninstallInvocations += 1;
      return {
        ok: true,
        exitCode: 0,
        message: 'Removed Teamem git hooks.'
      } as const;
    }
  };
  return installer;
}
