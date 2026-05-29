import { describe, expect, it } from 'bun:test';

import { resolveDevProfilePaths } from '../src/dev-profiles.js';
import {
  createLocalDevSetupRunner,
  type DevSetupFileSystem
} from '../src/dev-setup.js';
import type { SetupProcessRunner } from '../src/setup-delegation.js';

describe('dev profile setup', () => {
  it('runs the selected local source setup bundle with profile credentials env', () => {
    const calls: Array<{
      command: string;
      args: readonly string[];
      cwd: string;
      env?: NodeJS.ProcessEnv;
    }> = [];
    const processRunner: SetupProcessRunner = {
      run(command, args, options) {
        calls.push({ command, args, cwd: options.cwd, env: options.env });
        return { status: 0 };
      }
    };

    const runner = createLocalDevSetupRunner({
      fileSystem: existingFiles(['/src/teamem/plugin/lib/setup.js']),
      processRunner,
      env: {
        PATH: '/bin',
        TEAMEM_CREDENTIALS: '/tmp/home/.teamem/credentials.json'
      }
    });

    const result = runner.run({
      source: {
        teamemRoot: '/src/teamem',
        pluginRoot: '/src/teamem/plugin',
        launchCwd: '/work/project',
        source: 'flag'
      },
      profile: resolveDevProfilePaths({
        homeDir: '/tmp/home',
        profileName: 'alice'
      })
    });

    expect(result).toEqual({
      ok: true,
      exitCode: 0,
      message: 'Profile-scoped Teamem setup completed.'
    });
    expect(calls).toEqual([
      {
        command: 'bun',
        args: ['run', '/src/teamem/plugin/lib/setup.js'],
        cwd: '/work/project',
        env: {
          PATH: '/bin',
          TEAMEM_CREDENTIALS:
            '/tmp/home/.teamem/dev-profiles/alice/credentials.json'
        }
      }
    ]);
  });

  it('does not inspect or delegate to the installed marketplace setup bundle', () => {
    const processRunner: SetupProcessRunner = {
      run(command, args) {
        expect(command).toBe('bun');
        expect(args).toEqual(['run', '/src/teamem/plugin/lib/setup.js']);
        return { status: 0 };
      }
    };

    const runner = createLocalDevSetupRunner({
      fileSystem: existingFiles(['/src/teamem/plugin/lib/setup.js']),
      processRunner
    });

    const result = runner.run({
      source: {
        teamemRoot: '/src/teamem',
        pluginRoot: '/src/teamem/plugin',
        launchCwd: '/work/project',
        source: 'cwd'
      },
      profile: resolveDevProfilePaths({
        homeDir: '/tmp/home',
        profileName: 'bob'
      })
    });

    expect(result.ok).toBe(true);
  });

  it('fails before process launch when the selected local setup bundle is missing', () => {
    const calls: string[] = [];
    const runner = createLocalDevSetupRunner({
      fileSystem: existingFiles([]),
      processRunner: {
        run(command) {
          calls.push(command);
          return { status: 0 };
        }
      }
    });

    const result = runner.run({
      source: {
        teamemRoot: '/src/teamem',
        pluginRoot: '/src/teamem/plugin',
        launchCwd: '/work/project',
        source: 'flag'
      },
      profile: resolveDevProfilePaths({
        homeDir: '/tmp/home',
        profileName: 'alice'
      })
    });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain('/src/teamem/plugin/lib/setup.js');
    expect(calls).toEqual([]);
  });

  it('propagates setup cancellation or failure exit codes', () => {
    const runner = createLocalDevSetupRunner({
      fileSystem: existingFiles(['/src/teamem/plugin/lib/setup.js']),
      processRunner: {
        run() {
          return { status: 130 };
        }
      }
    });

    const result = runner.run({
      source: {
        teamemRoot: '/src/teamem',
        pluginRoot: '/src/teamem/plugin',
        launchCwd: '/work/project',
        source: 'flag'
      },
      profile: resolveDevProfilePaths({
        homeDir: '/tmp/home',
        profileName: 'alice'
      })
    });

    expect(result).toEqual({
      ok: false,
      exitCode: 130,
      message: 'Profile-scoped Teamem setup exited with code 130.'
    });
  });
});

function existingFiles(paths: readonly string[]): DevSetupFileSystem {
  const files = new Set(paths);
  return {
    exists(path: string): boolean {
      return files.has(path);
    }
  };
}
