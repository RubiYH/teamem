import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

import { parseCliArgs, renderHelp, runCli } from '../src/cli.js';
import type { ClaudeProcessLauncher } from '../src/cc-launcher.js';
import type {
  GitHookInstaller,
  GitHookInstallResult,
  GitHookPrompter
} from '../src/git-hooks.js';
import type {
  CommandProbeResult,
  CommandRunner
} from '../src/prerequisites.js';
import type { BootstrapperFileSystem } from '../src/plugin-installer.js';
import type {
  ScopePrompter,
  LocalStateFileSystem,
  SetupCommandRunner,
  SetupInvocation
} from '../src/index.js';

const PACKAGE_ROOT = resolve(import.meta.dir, '..');
const BIN_PATH = join(PACKAGE_ROOT, 'src/bin/teamem.ts');

describe('parseCliArgs', () => {
  it('treats no args as help output', () => {
    expect(parseCliArgs([])).toEqual({
      ok: true,
      value: { help: true, dryRun: false }
    });
  });

  it('parses dry-run init', () => {
    expect(parseCliArgs(['init', '--dry-run', '--scope', 'local'])).toEqual({
      ok: true,
      value: {
        command: 'init',
        dryRun: true,
        help: false,
        scope: 'local',
        setup: {
          flow: undefined,
          serverUrl: undefined,
          memberName: undefined,
          spaceLabel: undefined,
          roomCode: undefined
        }
      }
    });
  });

  it('parses non-interactive init create flags', () => {
    expect(
      parseCliArgs([
        'init',
        '--create',
        '--server-url',
        'https://teamem.example',
        '--member-name',
        'Rubi',
        '--label',
        'Alpha'
      ])
    ).toEqual({
      ok: true,
      value: {
        command: 'init',
        dryRun: false,
        help: false,
        scope: undefined,
        setup: {
          flow: 'create',
          serverUrl: 'https://teamem.example',
          memberName: 'Rubi',
          spaceLabel: 'Alpha',
          roomCode: undefined
        }
      }
    });
  });

  it('rejects unknown commands', () => {
    expect(parseCliArgs(['wat'])).toEqual({
      ok: false,
      error: 'Unknown command: wat'
    });
  });

  it('parses uninstall with credential preservation', () => {
    expect(
      parseCliArgs(['uninstall', '--scope', 'user', '--keep-credentials'])
    ).toEqual({
      ok: true,
      value: {
        command: 'uninstall',
        dryRun: false,
        help: false,
        scope: 'user',
        uninstall: {
          keepCredentials: true
        },
        setup: {
          flow: undefined,
          serverUrl: undefined,
          memberName: undefined,
          spaceLabel: undefined,
          roomCode: undefined
        }
      }
    });
  });

  it('rejects invalid scope values', () => {
    expect(parseCliArgs(['cc', '--scope', 'repo'])).toEqual({
      ok: false,
      error: 'Invalid value for --scope. Expected one of: project, user, local'
    });
  });

  it('parses forced cc update and passthrough args', () => {
    expect(parseCliArgs(['cc', '--update', '--', '--print', 'hello'])).toEqual({
      ok: true,
      value: {
        command: 'cc',
        dryRun: false,
        help: false,
        scope: undefined,
        cc: {
          updateMode: 'always',
          claudeArgs: ['--print', 'hello']
        },
        setup: {
          flow: undefined,
          serverUrl: undefined,
          memberName: undefined,
          spaceLabel: undefined,
          roomCode: undefined
        }
      }
    });
  });

  it('rejects conflicting cc update flags', () => {
    expect(parseCliArgs(['cc', '--update', '--no-update'])).toEqual({
      ok: false,
      error: 'Choose only one update mode: --update or --no-update'
    });
  });

  it('rejects conflicting git hook flags', () => {
    expect(
      parseCliArgs(['init', '--install-git-hooks', '--skip-git-hooks'])
    ).toEqual({
      ok: false,
      error:
        'Choose only one git hook mode: --install-git-hooks or --skip-git-hooks'
    });
  });
});

describe('runCli', () => {
  it('prints help text', () => {
    const writes: string[] = [];
    const exitCode = runCli([], {
      stdout: {
        write(text: string) {
          writes.push(text);
        }
      },
      stderr: { write() {} }
    });

    expect(exitCode).toBe(0);
    expect(writes.join('')).toBe(renderHelp());
  });

  it('prints dry-run action plans', () => {
    const writes: string[] = [];
    const exitCode = runCli(['update', '-n'], {
      stdout: {
        write(text: string) {
          writes.push(text);
        }
      },
      stderr: { write() {} }
    });

    expect(exitCode).toBe(0);
    expect(writes.join('')).toContain('teamem update');
    expect(writes.join('')).toContain(
      'dry-run: no external commands will be executed'
    );
    expect(writes.join('')).toContain(
      'claude plugin update teamem@teamem-alpha'
    );
  });

  it('launches Claude Code after accepting the default pre-launch update', () => {
    const commandRunner = createRecordingRunner({
      'claude plugin marketplace update teamem-alpha': ok(
        'marketplace updated'
      ),
      'claude plugin update teamem@teamem-alpha --scope user':
        ok('plugin updated')
    });
    const claudeLauncher = createClaudeLauncherStub();

    const exitCode = runCli(
      ['cc'],
      {
        stdout: { write() {} },
        stderr: { write() {} }
      },
      {
        prerequisites: {
          platform: 'linux',
          cwd: '/tmp/project',
          commandRunner
        },
        installer: {
          cwd: '/tmp/project',
          commandRunner,
          fileSystem: createMemoryFileSystem({
            '/tmp/project/.teamem/bootstrapper.json':
              '{\n  "pluginScope": "user"\n}\n'
          })
        },
        ccUpdatePrompter: () => true,
        claudeLauncher
      }
    );

    expect(exitCode).toBe(0);
    expect(commandRunner.invocations).toEqual([
      'claude plugin marketplace update teamem-alpha',
      'claude plugin update teamem@teamem-alpha --scope user'
    ]);
    expect(claudeLauncher.invocations).toEqual([
      'claude --dangerously-load-development-channels plugin:teamem@teamem-alpha'
    ]);
  });

  it('skips update and launches immediately with --no-update', () => {
    const commandRunner = createRecordingRunner({});
    const claudeLauncher = createClaudeLauncherStub();

    const exitCode = runCli(
      ['cc', '--no-update'],
      {
        stdout: { write() {} },
        stderr: { write() {} }
      },
      {
        prerequisites: {
          platform: 'linux',
          cwd: '/tmp/project',
          commandRunner
        },
        installer: {
          cwd: '/tmp/project',
          commandRunner,
          fileSystem: createMemoryFileSystem()
        },
        ccUpdatePrompter: () => {
          throw new Error('prompt should not run');
        },
        claudeLauncher
      }
    );

    expect(exitCode).toBe(0);
    expect(commandRunner.invocations).toEqual([]);
    expect(claudeLauncher.invocations).toEqual([
      'claude --dangerously-load-development-channels plugin:teamem@teamem-alpha'
    ]);
  });

  it('dry-runs cc without an update action when --no-update is set', () => {
    const writes: string[] = [];
    const exitCode = runCli(
      ['cc', '--dry-run', '--no-update'],
      {
        stdout: {
          write(text: string) {
            writes.push(text);
          }
        },
        stderr: { write() {} }
      },
      {
        prerequisites: {
          platform: 'linux',
          cwd: '/tmp/project',
          commandRunner: createFakeRunner({})
        },
        installer: {
          cwd: '/tmp/project',
          commandRunner: createFakeRunner({}),
          fileSystem: createMemoryFileSystem()
        }
      }
    );

    expect(exitCode).toBe(0);
    expect(writes.join('')).not.toContain('teamem update');
    expect(writes.join('')).toContain(
      'claude --dangerously-load-development-channels plugin:teamem@teamem-alpha'
    );
  });

  it('forces update before launch with --update', () => {
    const commandRunner = createRecordingRunner({
      'claude plugin marketplace update teamem-alpha': ok(
        'marketplace updated'
      ),
      'claude plugin update teamem@teamem-alpha --scope project':
        ok('plugin updated')
    });
    const claudeLauncher = createClaudeLauncherStub();

    const exitCode = runCli(
      ['cc', '--update', '--scope', 'project'],
      {
        stdout: { write() {} },
        stderr: { write() {} }
      },
      {
        prerequisites: {
          platform: 'linux',
          cwd: '/tmp/project',
          commandRunner
        },
        installer: {
          cwd: '/tmp/project',
          commandRunner,
          fileSystem: createMemoryFileSystem()
        },
        ccUpdatePrompter: () => {
          throw new Error('prompt should not run');
        },
        claudeLauncher
      }
    );

    expect(exitCode).toBe(0);
    expect(commandRunner.invocations).toEqual([
      'claude plugin marketplace update teamem-alpha',
      'claude plugin update teamem@teamem-alpha --scope project'
    ]);
    expect(claudeLauncher.invocations).toEqual([
      'claude --dangerously-load-development-channels plugin:teamem@teamem-alpha'
    ]);
  });

  it('warns on update failure and still launches Claude Code', () => {
    const stderr: string[] = [];
    const commandRunner = createRecordingRunner({
      'claude plugin marketplace update teamem-alpha': fail('network down')
    });
    const claudeLauncher = createClaudeLauncherStub();

    const exitCode = runCli(
      ['cc', '--update', '--scope', 'local'],
      {
        stdout: { write() {} },
        stderr: {
          write(text: string) {
            stderr.push(text);
          }
        }
      },
      {
        prerequisites: {
          platform: 'linux',
          cwd: '/tmp/project',
          commandRunner
        },
        installer: {
          cwd: '/tmp/project',
          commandRunner,
          fileSystem: createMemoryFileSystem()
        },
        claudeLauncher
      }
    );

    expect(exitCode).toBe(0);
    expect(commandRunner.invocations).toEqual([
      'claude plugin marketplace update teamem-alpha'
    ]);
    expect(stderr.join('')).toContain('Warning: Command failed');
    expect(stderr.join('')).toContain(
      'Continuing to launch Claude Code with Teamem.'
    );
    expect(claudeLauncher.invocations).toEqual([
      'claude --dangerously-load-development-channels plugin:teamem@teamem-alpha'
    ]);
  });

  it('passes args through to Claude after --', () => {
    const commandRunner = createRecordingRunner({});
    const claudeLauncher = createClaudeLauncherStub();

    const exitCode = runCli(
      ['cc', '--no-update', '--', '--print', 'hello'],
      {
        stdout: { write() {} },
        stderr: { write() {} }
      },
      {
        prerequisites: {
          platform: 'linux',
          cwd: '/tmp/project',
          commandRunner
        },
        installer: {
          cwd: '/tmp/project',
          commandRunner,
          fileSystem: createMemoryFileSystem()
        },
        claudeLauncher
      }
    );

    expect(exitCode).toBe(0);
    expect(claudeLauncher.invocations).toEqual([
      'claude --dangerously-load-development-channels plugin:teamem@teamem-alpha --print hello'
    ]);
  });

  it('runs prerequisite diagnostics for init with injected fakes', () => {
    const writes: string[] = [];
    const exitCode = runCli(
      ['init'],
      {
        stdout: {
          write(text: string) {
            writes.push(text);
          }
        },
        stderr: { write() {} }
      },
      {
        prerequisites: {
          platform: 'linux',
          cwd: '/tmp/project',
          commandRunner: createFakeRunner({
            'claude --version': missing(),
            'bun --version': ok('1.2.0'),
            'git --version': ok('git version 2.47.0'),
            'git rev-parse --is-inside-work-tree': fail('')
          })
        }
      }
    );

    expect(exitCode).toBe(1);
    expect(writes.join('')).toContain('teamem init');
    expect(writes.join('')).toContain('The `claude` command is not available');
    expect(writes.join('')).toContain(
      'Teamem did not attempt marketplace or plugin install actions.'
    );
  });

  it('installs the marketplace plugin at the selected scope and remembers it', () => {
    const writes: string[] = [];
    const fileSystem = createMemoryFileSystem();
    const setupRunner = createSetupRunnerStub();
    const exitCode = runCli(
      ['init', '--scope', 'local'],
      {
        stdout: {
          write(text: string) {
            writes.push(text);
          }
        },
        stderr: { write() {} }
      },
      {
        prerequisites: {
          platform: 'linux',
          cwd: '/tmp/project',
          commandRunner: createFakeRunner({
            'claude --version': ok('1.0.0'),
            'bun --version': ok('1.2.0'),
            'git --version': ok('git version 2.47.0'),
            'git rev-parse --is-inside-work-tree': ok('true')
          })
        },
        installer: {
          cwd: '/tmp/project',
          commandRunner: createFakeRunner({
            'claude plugin list --json': ok('[]'),
            'claude plugin marketplace list --json': ok('[]'),
            'claude plugin marketplace add https://github.com/RubiYH/teamem':
              ok('added'),
            'claude plugin install teamem@teamem-alpha --scope local':
              ok('installed')
          }),
          fileSystem
        },
        setupRunner
      }
    );

    expect(exitCode).toBe(0);
    expect(writes.join('')).toContain('Selected plugin scope: local (flag)');
    expect(writes.join('')).toContain('Marketplace action: add');
    expect(setupRunner.invocations).toEqual([
      { mode: 'interactive', args: [] }
    ]);
    expect(fileSystem.files.get('/tmp/project/.teamem/bootstrapper.json')).toBe(
      '{\n  "pluginScope": "local"\n}\n'
    );
    expect(
      [...fileSystem.files.keys()].some((path) => path.endsWith('.mcp.json'))
    ).toBe(false);
  });

  it('updates the marketplace when already present and reuses remembered scope for later plans', () => {
    const writes: string[] = [];
    const fileSystem = createMemoryFileSystem({
      '/tmp/project/.teamem/bootstrapper.json':
        '{\n  "pluginScope": "user"\n}\n'
    });
    const setupRunner = createSetupRunnerStub();
    const exitCode = runCli(
      ['init'],
      {
        stdout: {
          write(text: string) {
            writes.push(text);
          }
        },
        stderr: { write() {} }
      },
      {
        prerequisites: {
          platform: 'linux',
          cwd: '/tmp/project',
          commandRunner: createFakeRunner({
            'claude --version': ok('1.0.0'),
            'bun --version': ok('1.2.0'),
            'git --version': ok('git version 2.47.0'),
            'git rev-parse --is-inside-work-tree': ok('true')
          })
        },
        installer: {
          cwd: '/tmp/project',
          commandRunner: createFakeRunner({
            'claude plugin marketplace list --json': ok(
              '{"marketplaces":[{"name":"teamem-alpha"}]}'
            ),
            'claude plugin marketplace update teamem-alpha': ok('updated'),
            'claude plugin install teamem@teamem-alpha --scope user':
              ok('installed')
          }),
          fileSystem
        },
        setupRunner
      }
    );

    expect(exitCode).toBe(0);
    expect(writes.join('')).toContain('Selected plugin scope: user (memory)');
    expect(writes.join('')).toContain('Marketplace action: update');
    expect(setupRunner.invocations).toEqual([
      { mode: 'interactive', args: [] }
    ]);

    const updateWrites: string[] = [];
    const updateExitCode = runCli(
      ['update', '--dry-run'],
      {
        stdout: {
          write(text: string) {
            updateWrites.push(text);
          }
        },
        stderr: { write() {} }
      },
      {
        prerequisites: {
          platform: 'linux',
          cwd: '/tmp/project',
          commandRunner: createFakeRunner({
            'claude --version': ok('1.0.0'),
            'bun --version': ok('1.2.0'),
            'git --version': ok('git version 2.47.0'),
            'git rev-parse --is-inside-work-tree': ok('true')
          })
        },
        installer: {
          cwd: '/tmp/project',
          commandRunner: createFakeRunner({
            'claude plugin list --json': ok('[]')
          }),
          fileSystem
        }
      }
    );

    expect(updateExitCode).toBe(0);
    expect(updateWrites.join('')).toContain(
      'claude plugin update teamem@teamem-alpha --scope user'
    );
  });

  it('detects installed scope from Claude Code state when no remembered scope exists', () => {
    const writes: string[] = [];
    const exitCode = runCli(
      ['update', '--dry-run'],
      {
        stdout: {
          write(text: string) {
            writes.push(text);
          }
        },
        stderr: { write() {} }
      },
      {
        prerequisites: {
          platform: 'linux',
          cwd: '/tmp/project',
          commandRunner: createFakeRunner({
            'claude --version': ok('1.0.0'),
            'bun --version': ok('1.2.0'),
            'git --version': ok('git version 2.47.0'),
            'git rev-parse --is-inside-work-tree': ok('true')
          })
        },
        installer: {
          cwd: '/tmp/project',
          commandRunner: createFakeRunner({
            'claude plugin list --json': ok(
              '{"plugins":[{"id":"teamem@teamem-alpha","scope":"user"}]}'
            )
          }),
          fileSystem: createMemoryFileSystem()
        }
      }
    );

    expect(exitCode).toBe(0);
    expect(writes.join('')).toContain(
      'claude plugin update teamem@teamem-alpha --scope user'
    );
  });

  it('executes update using remembered scope when available', () => {
    const writes: string[] = [];
    const fileSystem = createMemoryFileSystem({
      '/tmp/project/.teamem/bootstrapper.json':
        '{\n  "pluginScope": "user"\n}\n'
    });
    const commandRunner = createRecordingRunner({
      'claude plugin marketplace update teamem-alpha': ok(
        'marketplace updated'
      ),
      'claude plugin update teamem@teamem-alpha --scope user':
        ok('plugin updated')
    });

    const exitCode = runCli(
      ['update'],
      {
        stdout: {
          write(text: string) {
            writes.push(text);
          }
        },
        stderr: { write() {} }
      },
      {
        prerequisites: {
          platform: 'linux',
          cwd: '/tmp/project',
          commandRunner
        },
        installer: {
          cwd: '/tmp/project',
          commandRunner,
          fileSystem
        }
      }
    );

    expect(exitCode).toBe(0);
    expect(commandRunner.invocations).toEqual([
      'claude plugin marketplace update teamem-alpha',
      'claude plugin update teamem@teamem-alpha --scope user'
    ]);
    expect(writes.join('')).toContain('Selected plugin scope: user (memory)');
    expect(writes.join('')).toContain(
      'Teamem marketplace/plugin update completed.'
    );
  });

  it('prefers explicit update scope over remembered scope', () => {
    const writes: string[] = [];
    const fileSystem = createMemoryFileSystem({
      '/tmp/project/.teamem/bootstrapper.json':
        '{\n  "pluginScope": "user"\n}\n'
    });
    const commandRunner = createRecordingRunner({
      'claude plugin marketplace update teamem-alpha': ok(
        'marketplace updated'
      ),
      'claude plugin update teamem@teamem-alpha --scope project':
        ok('plugin updated')
    });

    const exitCode = runCli(
      ['update', '--scope', 'project'],
      {
        stdout: {
          write(text: string) {
            writes.push(text);
          }
        },
        stderr: { write() {} }
      },
      {
        prerequisites: {
          platform: 'linux',
          cwd: '/tmp/project',
          commandRunner
        },
        installer: {
          cwd: '/tmp/project',
          commandRunner,
          fileSystem
        }
      }
    );

    expect(exitCode).toBe(0);
    expect(commandRunner.invocations).toEqual([
      'claude plugin marketplace update teamem-alpha',
      'claude plugin update teamem@teamem-alpha --scope project'
    ]);
    expect(writes.join('')).toContain('Selected plugin scope: project (flag)');
  });

  it('fails update with actionable guidance when no scope can be recovered', () => {
    const writes: string[] = [];
    const exitCode = runCli(
      ['update'],
      {
        stdout: {
          write(text: string) {
            writes.push(text);
          }
        },
        stderr: { write() {} }
      },
      {
        prerequisites: {
          platform: 'linux',
          cwd: '/tmp/project',
          commandRunner: createFakeRunner({
            'claude plugin list --json': ok('[]')
          })
        },
        installer: {
          cwd: '/tmp/project',
          commandRunner: createFakeRunner({
            'claude plugin list --json': ok('[]')
          }),
          fileSystem: createMemoryFileSystem()
        }
      }
    );

    expect(exitCode).toBe(1);
    expect(writes.join('')).toContain(
      'Could not determine which Claude Code plugin scope to update.'
    );
    expect(writes.join('')).toContain(
      'teamem update --scope <project|user|local>'
    );
  });

  it('returns non-zero and reports the marketplace update failure', () => {
    const writes: string[] = [];
    const commandRunner = createRecordingRunner({
      'claude plugin marketplace update teamem-alpha': fail('permission denied')
    });

    const exitCode = runCli(
      ['update', '--scope', 'user'],
      {
        stdout: {
          write(text: string) {
            writes.push(text);
          }
        },
        stderr: { write() {} }
      },
      {
        prerequisites: {
          platform: 'linux',
          cwd: '/tmp/project',
          commandRunner
        },
        installer: {
          cwd: '/tmp/project',
          commandRunner,
          fileSystem: createMemoryFileSystem()
        }
      }
    );

    expect(exitCode).toBe(1);
    expect(commandRunner.invocations).toEqual([
      'claude plugin marketplace update teamem-alpha'
    ]);
    expect(writes.join('')).toContain(
      'Command failed: claude plugin marketplace update teamem-alpha (permission denied)'
    );
  });

  it('returns non-zero and reports the plugin update failure', () => {
    const writes: string[] = [];
    const commandRunner = createRecordingRunner({
      'claude plugin marketplace update teamem-alpha': ok(
        'marketplace updated'
      ),
      'claude plugin update teamem@teamem-alpha --scope local': {
        exitCode: 1,
        stdout: 'try `claude plugin list --json`',
        stderr: 'plugin missing'
      }
    });

    const exitCode = runCli(
      ['update', '--scope', 'local'],
      {
        stdout: {
          write(text: string) {
            writes.push(text);
          }
        },
        stderr: { write() {} }
      },
      {
        prerequisites: {
          platform: 'linux',
          cwd: '/tmp/project',
          commandRunner
        },
        installer: {
          cwd: '/tmp/project',
          commandRunner,
          fileSystem: createMemoryFileSystem()
        }
      }
    );

    expect(exitCode).toBe(1);
    expect(commandRunner.invocations).toEqual([
      'claude plugin marketplace update teamem-alpha',
      'claude plugin update teamem@teamem-alpha --scope local'
    ]);
    expect(writes.join('')).toContain(
      'Command failed: claude plugin update teamem@teamem-alpha --scope local (plugin missing | try `claude plugin list --json`)'
    );
  });

  it('dry-runs uninstall as a first-class command', () => {
    const writes: string[] = [];
    const exitCode = runCli(
      ['uninstall', '--dry-run', '--scope', 'user'],
      {
        stdout: {
          write(text: string) {
            writes.push(text);
          }
        },
        stderr: { write() {} }
      },
      {
        prerequisites: {
          platform: 'linux',
          cwd: '/tmp/project',
          commandRunner: createFakeRunner({})
        },
        installer: {
          cwd: '/tmp/project',
          commandRunner: createFakeRunner({}),
          fileSystem: createMemoryFileSystem()
        }
      }
    );

    expect(exitCode).toBe(0);
    expect(writes.join('')).toContain('teamem uninstall');
    expect(writes.join('')).toContain(
      'claude plugin uninstall teamem@teamem-alpha --scope user --prune -y'
    );
    expect(writes.join('')).toContain(
      'claude plugin marketplace remove teamem-alpha'
    );
  });

  it('executes uninstall using remembered scope and clears local state', () => {
    const writes: string[] = [];
    const localStateFileSystem = createLocalStateFileSystemStub();
    const gitHookInstaller = createGitHookInstallerStub();
    const commandRunner = createRecordingRunner({
      'claude plugin uninstall teamem@teamem-alpha --scope user --prune -y':
        ok('uninstalled'),
      'claude plugin marketplace remove teamem-alpha': ok('removed')
    });

    const exitCode = runCli(
      ['uninstall'],
      {
        stdout: {
          write(text: string) {
            writes.push(text);
          }
        },
        stderr: { write() {} }
      },
      {
        prerequisites: {
          platform: 'linux',
          cwd: '/tmp/project',
          commandRunner
        },
        installer: {
          cwd: '/tmp/project',
          commandRunner,
          fileSystem: createMemoryFileSystem({
            '/tmp/project/.teamem/bootstrapper.json':
              '{\n  "pluginScope": "user"\n}\n'
          })
        },
        homeDir: '/tmp/home',
        localStateFileSystem,
        gitHookInstaller
      }
    );

    expect(exitCode).toBe(0);
    expect(commandRunner.invocations).toEqual([
      'claude plugin uninstall teamem@teamem-alpha --scope user --prune -y',
      'claude plugin marketplace remove teamem-alpha'
    ]);
    expect(localStateFileSystem.removedPaths).toEqual([
      '/tmp/home/.teamem/credentials.json',
      '/tmp/home/.teamem/run',
      '/tmp/home/.cache/teamem',
      '/tmp/home/.claude/plugins/data/teamem',
      '/tmp/home/.claude/plugins/data/teamem-teamem-alpha',
      '/tmp/home/.claude/plugins/data/teamem-teamem-local',
      '/tmp/home/.claude/plugins/data/teamem-teamem2-local',
      '/tmp/home/.claude/plugins/data/teamem2',
      '/tmp/home/.claude/plugins/data/teamem2-teamem-alpha',
      '/tmp/home/.claude/plugins/data/teamem2-teamem-local',
      '/tmp/home/.claude/plugins/data/teamem2-teamem2-local',
      '/tmp/home/.claude/plugins/data/teamem2-inline',
      '/tmp/home/.claude/plugins/data/teamem-inline',
      '/tmp/project/.teamem/bootstrapper.json'
    ]);
    expect(writes.join('')).toContain('Selected plugin scope: user (memory)');
    expect(writes.join('')).toContain(
      'Teamem plugin, git hooks, and local state were uninstalled.'
    );
  });

  it('preserves credentials when uninstall uses --keep-credentials', () => {
    const localStateFileSystem = createLocalStateFileSystemStub();
    const gitHookInstaller = createGitHookInstallerStub();
    const commandRunner = createRecordingRunner({
      'claude plugin uninstall teamem@teamem-alpha --scope local --prune -y':
        ok('uninstalled'),
      'claude plugin marketplace remove teamem-alpha': ok('removed')
    });

    const exitCode = runCli(
      ['uninstall', '--scope', 'local', '--keep-credentials'],
      {
        stdout: { write() {} },
        stderr: { write() {} }
      },
      {
        prerequisites: {
          platform: 'linux',
          cwd: '/tmp/project',
          commandRunner
        },
        installer: {
          cwd: '/tmp/project',
          commandRunner,
          fileSystem: createMemoryFileSystem()
        },
        homeDir: '/tmp/home',
        localStateFileSystem,
        gitHookInstaller
      }
    );

    expect(exitCode).toBe(0);
    expect(localStateFileSystem.removedPaths).toEqual([
      '/tmp/home/.teamem/run',
      '/tmp/home/.cache/teamem',
      '/tmp/home/.claude/plugins/data/teamem',
      '/tmp/home/.claude/plugins/data/teamem-teamem-alpha',
      '/tmp/home/.claude/plugins/data/teamem-teamem-local',
      '/tmp/home/.claude/plugins/data/teamem-teamem2-local',
      '/tmp/home/.claude/plugins/data/teamem2',
      '/tmp/home/.claude/plugins/data/teamem2-teamem-alpha',
      '/tmp/home/.claude/plugins/data/teamem2-teamem-local',
      '/tmp/home/.claude/plugins/data/teamem2-teamem2-local',
      '/tmp/home/.claude/plugins/data/teamem2-inline',
      '/tmp/home/.claude/plugins/data/teamem-inline',
      '/tmp/project/.teamem/bootstrapper.json'
    ]);
  });

  it('prints help and exits non-zero for invalid commands', () => {
    const stderr: string[] = [];
    const exitCode = runCli(['broken'], {
      stdout: { write() {} },
      stderr: {
        write(text: string) {
          stderr.push(text);
        }
      }
    });

    expect(exitCode).toBe(1);
    expect(stderr.join('')).toContain('Unknown command: broken');
    expect(stderr.join('')).toContain('Usage:');
  });

  it('prompts for plugin scope when init has no explicit scope flag', () => {
    const writes: string[] = [];
    const setupRunner = createSetupRunnerStub();
    const scopePrompter: ScopePrompter = () => 'local';

    const exitCode = runCli(
      ['init'],
      {
        stdout: {
          write(text: string) {
            writes.push(text);
          }
        },
        stderr: { write() {} }
      },
      {
        prerequisites: {
          platform: 'linux',
          cwd: '/tmp/project',
          commandRunner: createFakeRunner({
            'claude --version': ok('1.0.0'),
            'bun --version': ok('1.2.0'),
            'git --version': ok('git version 2.47.0'),
            'git rev-parse --is-inside-work-tree': ok('true')
          })
        },
        installer: {
          cwd: '/tmp/project',
          commandRunner: createFakeRunner({
            'claude plugin list --json': ok('[]'),
            'claude plugin marketplace list --json': ok('[]'),
            'claude plugin marketplace add https://github.com/RubiYH/teamem':
              ok('added'),
            'claude plugin install teamem@teamem-alpha --scope local':
              ok('installed')
          }),
          fileSystem: createMemoryFileSystem()
        },
        scopePrompter,
        setupRunner
      }
    );

    expect(exitCode).toBe(0);
    expect(writes.join('')).toContain('Selected plugin scope: local (prompt)');
    expect(setupRunner.invocations).toEqual([
      { mode: 'interactive', args: [] }
    ]);
  });

  it('delegates non-interactive create setup through the existing setup json flow', () => {
    const setupRunner = createSetupRunnerStub();
    const exitCode = runCli(
      [
        'init',
        '--scope',
        'project',
        '--create',
        '--server-url',
        'https://teamem.example',
        '--member-name',
        'Rubi',
        '--label',
        'Alpha'
      ],
      {
        stdout: { write() {} },
        stderr: { write() {} }
      },
      {
        prerequisites: {
          platform: 'linux',
          cwd: '/tmp/project',
          commandRunner: createFakeRunner({
            'claude --version': ok('1.0.0'),
            'bun --version': ok('1.2.0'),
            'git --version': ok('git version 2.47.0'),
            'git rev-parse --is-inside-work-tree': ok('true')
          })
        },
        installer: {
          cwd: '/tmp/project',
          commandRunner: createFakeRunner({
            'claude plugin marketplace list --json': ok('[]'),
            'claude plugin marketplace add https://github.com/RubiYH/teamem':
              ok('added'),
            'claude plugin install teamem@teamem-alpha --scope project':
              ok('installed')
          }),
          fileSystem: createMemoryFileSystem()
        },
        setupRunner
      }
    );

    expect(exitCode).toBe(0);
    expect(setupRunner.invocations).toEqual([
      {
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
    ]);
  });

  it('delegates non-interactive join setup through the existing setup json flow', () => {
    const setupRunner = createSetupRunnerStub();
    const exitCode = runCli(
      [
        'init',
        '--scope',
        'user',
        '--join',
        '--server-url',
        'https://teamem.example',
        '--member-name',
        'Rubi',
        '--room-code',
        'ROOM-123'
      ],
      {
        stdout: { write() {} },
        stderr: { write() {} }
      },
      {
        prerequisites: {
          platform: 'linux',
          cwd: '/tmp/project',
          commandRunner: createFakeRunner({
            'claude --version': ok('1.0.0'),
            'bun --version': ok('1.2.0'),
            'git --version': ok('git version 2.47.0'),
            'git rev-parse --is-inside-work-tree': ok('true')
          })
        },
        installer: {
          cwd: '/tmp/project',
          commandRunner: createFakeRunner({
            'claude plugin marketplace list --json': ok('[]'),
            'claude plugin marketplace add https://github.com/RubiYH/teamem':
              ok('added'),
            'claude plugin install teamem@teamem-alpha --scope user':
              ok('installed')
          }),
          fileSystem: createMemoryFileSystem()
        },
        setupRunner
      }
    );

    expect(exitCode).toBe(0);
    expect(setupRunner.invocations).toEqual([
      {
        mode: 'non-interactive',
        args: [
          '--json',
          JSON.stringify({
            flow: 'join',
            serverUrl: 'https://teamem.example',
            memberName: 'Rubi',
            roomCode: 'ROOM-123'
          })
        ]
      }
    ]);
  });

  it('prompts for git hook install inside a git repo and defaults to install', () => {
    const writes: string[] = [];
    const setupRunner = createSetupRunnerStub();
    const gitHookInstaller = createGitHookInstallerStub();
    const gitHookPrompter: GitHookPrompter = () => true;

    const exitCode = runCli(
      ['init', '--scope', 'project'],
      {
        stdout: {
          write(text: string) {
            writes.push(text);
          }
        },
        stderr: { write() {} }
      },
      {
        prerequisites: {
          platform: 'linux',
          cwd: '/tmp/project',
          commandRunner: createFakeRunner({
            'claude --version': ok('1.0.0'),
            'bun --version': ok('1.2.0'),
            'git --version': ok('git version 2.47.0'),
            'git rev-parse --is-inside-work-tree': ok('true')
          })
        },
        installer: {
          cwd: '/tmp/project',
          commandRunner: createFakeRunner({
            'claude plugin marketplace list --json': ok('[]'),
            'claude plugin marketplace add https://github.com/RubiYH/teamem':
              ok('added'),
            'claude plugin install teamem@teamem-alpha --scope project':
              ok('installed')
          }),
          fileSystem: createMemoryFileSystem()
        },
        setupRunner,
        gitHookPrompter,
        gitHookInstaller
      }
    );

    expect(exitCode).toBe(0);
    expect(gitHookInstaller.invocations).toEqual([{ scope: 'project' }]);
    expect(writes.join('')).toContain('Installed Teamem git hooks');
  });

  it('skips git hook install outside a git repo with a clear message', () => {
    const writes: string[] = [];
    const setupRunner = createSetupRunnerStub();
    const gitHookInstaller = createGitHookInstallerStub();

    const exitCode = runCli(
      ['init', '--scope', 'user'],
      {
        stdout: {
          write(text: string) {
            writes.push(text);
          }
        },
        stderr: { write() {} }
      },
      {
        prerequisites: {
          platform: 'linux',
          cwd: '/tmp/outside',
          commandRunner: createFakeRunner({
            'claude --version': ok('1.0.0'),
            'bun --version': ok('1.2.0'),
            'git --version': ok('git version 2.47.0'),
            'git rev-parse --is-inside-work-tree': fail('')
          })
        },
        installer: {
          cwd: '/tmp/outside',
          commandRunner: createFakeRunner({
            'claude plugin marketplace list --json': ok('[]'),
            'claude plugin marketplace add https://github.com/RubiYH/teamem':
              ok('added'),
            'claude plugin install teamem@teamem-alpha --scope user':
              ok('installed')
          }),
          fileSystem: createMemoryFileSystem()
        },
        setupRunner,
        gitHookInstaller
      }
    );

    expect(exitCode).toBe(0);
    expect(gitHookInstaller.invocations).toEqual([]);
    expect(writes.join('')).toContain(
      'Git hooks skipped: current directory is not inside a git repository.'
    );
  });

  it('rejects explicit project scope outside a git repo before install', () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const setupRunner = createSetupRunnerStub();

    const exitCode = runCli(
      ['init', '--scope', 'project'],
      {
        stdout: {
          write(text: string) {
            stdout.push(text);
          }
        },
        stderr: {
          write(text: string) {
            stderr.push(text);
          }
        }
      },
      {
        prerequisites: {
          platform: 'linux',
          cwd: '/tmp/outside',
          commandRunner: createFakeRunner({
            'claude --version': missing(),
            'bun --version': ok('1.2.0'),
            'git --version': ok('git version 2.47.0'),
            'git rev-parse --is-inside-work-tree': fail('')
          })
        },
        installer: {
          cwd: '/tmp/outside',
          commandRunner: createFakeRunner({}),
          fileSystem: createMemoryFileSystem()
        },
        setupRunner
      }
    );

    expect(exitCode).toBe(1);
    expect(stdout.join('')).toContain('teamem init');
    expect(stdout.join('')).toContain(
      'The `claude` command is not available on PATH.'
    );
    expect(stdout.join('')).toContain('Selected plugin scope: project (flag)');
    expect(stdout.join('')).toContain(
      'Explicit project scope is unavailable here: Current directory is not inside a git repository'
    );
    expect(stderr).toEqual([]);
    expect(setupRunner.invocations).toEqual([]);
  });

  it('rejects explicit project scope with full diagnostics when git cannot check repository context', () => {
    const stdout: string[] = [];
    const setupRunner = createSetupRunnerStub();

    const exitCode = runCli(
      ['init', '--scope', 'project'],
      {
        stdout: {
          write(text: string) {
            stdout.push(text);
          }
        },
        stderr: { write() {} }
      },
      {
        prerequisites: {
          platform: 'linux',
          cwd: '/tmp/unknown',
          commandRunner: createFakeRunner({
            'claude --version': ok('1.0.0'),
            'bun --version': ok('1.2.0'),
            'git --version': missing()
          })
        },
        installer: {
          cwd: '/tmp/unknown',
          commandRunner: createFakeRunner({}),
          fileSystem: createMemoryFileSystem()
        },
        setupRunner
      }
    );

    expect(exitCode).toBe(1);
    expect(stdout.join('')).toContain(
      'The `git` command is not available on PATH.'
    );
    expect(stdout.join('')).toContain(
      'Repository context could not be checked because Git is unavailable.'
    );
    expect(stdout.join('')).toContain(
      'Explicit project scope is unavailable here: Repository context could not be checked because Git is unavailable.'
    );
    expect(setupRunner.invocations).toEqual([]);
  });

  it('forces git hook install with --install-git-hooks', () => {
    const setupRunner = createSetupRunnerStub();
    const gitHookInstaller = createGitHookInstallerStub();
    const gitHookPrompter: GitHookPrompter = () => false;

    const exitCode = runCli(
      ['init', '--scope', 'local', '--install-git-hooks'],
      {
        stdout: { write() {} },
        stderr: { write() {} }
      },
      {
        prerequisites: {
          platform: 'linux',
          cwd: '/tmp/project',
          commandRunner: createFakeRunner({
            'claude --version': ok('1.0.0'),
            'bun --version': ok('1.2.0'),
            'git --version': ok('git version 2.47.0'),
            'git rev-parse --is-inside-work-tree': ok('true')
          })
        },
        installer: {
          cwd: '/tmp/project',
          commandRunner: createFakeRunner({
            'claude plugin marketplace list --json': ok('[]'),
            'claude plugin marketplace add https://github.com/RubiYH/teamem':
              ok('added'),
            'claude plugin install teamem@teamem-alpha --scope local':
              ok('installed')
          }),
          fileSystem: createMemoryFileSystem()
        },
        setupRunner,
        gitHookPrompter,
        gitHookInstaller
      }
    );

    expect(exitCode).toBe(0);
    expect(gitHookInstaller.invocations).toEqual([{ scope: 'local' }]);
  });

  it('forces git hook skip with --skip-git-hooks', () => {
    const writes: string[] = [];
    const setupRunner = createSetupRunnerStub();
    const gitHookInstaller = createGitHookInstallerStub();

    const exitCode = runCli(
      ['init', '--scope', 'project', '--skip-git-hooks'],
      {
        stdout: {
          write(text: string) {
            writes.push(text);
          }
        },
        stderr: { write() {} }
      },
      {
        prerequisites: {
          platform: 'linux',
          cwd: '/tmp/project',
          commandRunner: createFakeRunner({
            'claude --version': ok('1.0.0'),
            'bun --version': ok('1.2.0'),
            'git --version': ok('git version 2.47.0'),
            'git rev-parse --is-inside-work-tree': ok('true')
          })
        },
        installer: {
          cwd: '/tmp/project',
          commandRunner: createFakeRunner({
            'claude plugin marketplace list --json': ok('[]'),
            'claude plugin marketplace add https://github.com/RubiYH/teamem':
              ok('added'),
            'claude plugin install teamem@teamem-alpha --scope project':
              ok('installed')
          }),
          fileSystem: createMemoryFileSystem()
        },
        setupRunner,
        gitHookInstaller
      }
    );

    expect(exitCode).toBe(0);
    expect(gitHookInstaller.invocations).toEqual([]);
    expect(writes.join('')).toContain('Git hooks skipped by --skip-git-hooks.');
  });
});

describe('teamem bin', () => {
  it('runs the package bin entry with bun', () => {
    const result = spawnSync('bun', ['run', BIN_PATH, 'cc', '--dry-run'], {
      cwd: PACKAGE_ROOT,
      encoding: 'utf8'
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('teamem cc');
    expect(result.stdout).toContain('plugin:teamem@teamem-alpha');
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

function missing(): CommandProbeResult {
  return {
    exitCode: null,
    stdout: '',
    stderr: '',
    errorCode: 'ENOENT'
  };
}

function createSetupRunnerStub(
  exitCode = 0
): SetupCommandRunner & { invocations: SetupInvocation[] } {
  const invocations: SetupInvocation[] = [];
  return {
    invocations,
    run(invocation: SetupInvocation) {
      invocations.push(invocation);
      return exitCode === 0
        ? {
            ok: true,
            exitCode,
            message: 'ok'
          }
        : {
            ok: false,
            exitCode,
            message: 'failed'
          };
    }
  };
}

function createGitHookInstallerStub(
  result: GitHookInstallResult = {
    ok: true,
    exitCode: 0,
    message: 'Installed Teamem git hooks.'
  }
): GitHookInstaller & {
  invocations: Array<{ scope: 'project' | 'user' | 'local' }>;
} {
  const invocations: Array<{ scope: 'project' | 'user' | 'local' }> = [];
  return {
    invocations,
    install(invocation) {
      invocations.push(invocation);
      return result;
    },
    uninstall() {
      return {
        ok: true,
        exitCode: 0,
        message: 'Removed Teamem git hooks.'
      };
    }
  };
}

function createClaudeLauncherStub(
  status = 0
): ClaudeProcessLauncher & { invocations: string[] } {
  const invocations: string[] = [];
  return {
    invocations,
    launch(command, args) {
      invocations.push([command, ...args].join(' '));
      return { status };
    }
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
