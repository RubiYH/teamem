import { describe, expect, it } from 'bun:test';

import {
  createSetupRunner,
  parseSetupSelection,
  resolveInstalledSetupBundle,
  type SetupProcessRunner
} from '../src/setup-delegation.js';
import type {
  CommandProbeResult,
  CommandRunner
} from '../src/prerequisites.js';

describe('parseSetupSelection', () => {
  it('returns interactive delegation when no setup flow is provided', () => {
    expect(parseSetupSelection(undefined)).toEqual({
      ok: true,
      value: {
        mode: 'interactive',
        args: []
      }
    });
  });

  it('builds setup json args for create flow', () => {
    expect(
      parseSetupSelection({
        flow: 'create',
        serverUrl: 'https://teamem.example',
        memberName: 'Rubi',
        spaceLabel: 'Alpha'
      })
    ).toEqual({
      ok: true,
      value: {
        mode: 'non-interactive',
        args: [
          '--json',
          JSON.stringify({
            flow: 'create',
            serverUrl: 'https://teamem.example',
            memberName: 'Rubi',
            spaceLabel: 'Alpha'
          })
        ]
      }
    });
  });

  it('rejects invalid join/create flag combinations', () => {
    expect(
      parseSetupSelection({
        flow: 'join',
        serverUrl: 'https://teamem.example',
        memberName: 'Rubi',
        spaceLabel: 'Alpha',
        roomCode: 'ROOM-123'
      })
    ).toEqual({
      ok: false,
      error: '--label is only valid with --create'
    });

    expect(
      parseSetupSelection({
        flow: 'create',
        serverUrl: 'https://teamem.example',
        memberName: 'Rubi',
        roomCode: 'ROOM-123'
      })
    ).toEqual({
      ok: false,
      error: '--room-code is only valid with --join'
    });
  });

  it('resolves the setup bundle from wrapped plugin-list JSON', () => {
    const result = resolveInstalledSetupBundle({
      commandRunner: createFakeRunner({
        'claude plugin list --json': ok(
          JSON.stringify({
            plugins: [
              {
                id: 'teamem@teamem-alpha',
                scope: 'project',
                installPath: '/cache/teamem/0.3.17'
              }
            ]
          })
        )
      }),
      fileSystem: {
        exists(path: string): boolean {
          return path === '/cache/teamem/0.3.17/lib/setup.js';
        }
      },
      scope: 'project'
    });

    expect(result).toEqual({
      ok: true,
      path: '/cache/teamem/0.3.17/lib/setup.js'
    });
  });

  it('runs setup through the installed plugin bundle instead of the source tree', () => {
    const calls: Array<{
      command: string;
      args: readonly string[];
      cwd: string;
    }> = [];
    const processRunner: SetupProcessRunner = {
      run(command, args, options) {
        calls.push({ command, args, cwd: options.cwd });
        return { status: 0 };
      }
    };

    const runner = createSetupRunner('user', {
      cwd: '/work/repo',
      commandRunner: createFakeRunner({
        'claude plugin list --json': ok(
          JSON.stringify([
            {
              id: 'teamem@teamem-alpha',
              scope: 'user',
              installPath: '/cache/teamem/0.3.17'
            }
          ])
        )
      }),
      fileSystem: {
        exists(path: string): boolean {
          return path === '/cache/teamem/0.3.17/lib/setup.js';
        }
      },
      processRunner
    });

    const result = runner.run({ mode: 'interactive', args: [] });

    expect(result).toEqual({
      ok: true,
      exitCode: 0,
      message: 'Teamem setup completed.'
    });
    expect(calls).toEqual([
      {
        command: 'bun',
        args: ['run', '/cache/teamem/0.3.17/lib/setup.js'],
        cwd: '/work/repo'
      }
    ]);
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
