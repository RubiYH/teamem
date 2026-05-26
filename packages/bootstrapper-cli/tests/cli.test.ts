import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

import { parseCliArgs, renderHelp, runCli } from '../src/cli.js';
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
  ClaudeLaunchProcessRunner,
  ClaudeLauncherFileSystem,
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

  it('parses Teamem-aware Claude launcher lifecycle commands', () => {
    expect(parseCliArgs(['claude', 'install', '--dry-run'])).toEqual({
      ok: true,
      value: {
        command: 'claude',
        dryRun: true,
        help: false,
        scope: undefined,
        cc: undefined,
        claude: {
          lifecycleCommand: 'install'
        },
        uninstall: undefined,
        setup: {
          flow: undefined,
          serverUrl: undefined,
          memberName: undefined,
          spaceLabel: undefined,
          roomCode: undefined
        }
      }
    });
    expect(parseCliArgs(['claude', 'status'])).toEqual({
      ok: true,
      value: {
        command: 'claude',
        dryRun: false,
        help: false,
        scope: undefined,
        cc: undefined,
        claude: {
          lifecycleCommand: 'status'
        },
        uninstall: undefined,
        setup: {
          flow: undefined,
          serverUrl: undefined,
          memberName: undefined,
          spaceLabel: undefined,
          roomCode: undefined
        }
      }
    });
    expect(parseCliArgs(['claude', 'uninstall'])).toEqual({
      ok: true,
      value: {
        command: 'claude',
        dryRun: false,
        help: false,
        scope: undefined,
        cc: undefined,
        claude: {
          lifecycleCommand: 'uninstall'
        },
        uninstall: undefined,
        setup: {
          flow: undefined,
          serverUrl: undefined,
          memberName: undefined,
          spaceLabel: undefined,
          roomCode: undefined
        }
      }
    });
    expect(
      parseCliArgs(['claude', 'launch', '--teamem', '--', '--print', 'hello'])
    ).toEqual({
      ok: true,
      value: {
        command: 'claude',
        dryRun: false,
        help: false,
        scope: undefined,
        cc: undefined,
        claude: {
          lifecycleCommand: 'launch',
          launchMode: 'teamem',
          claudeArgs: ['--print', 'hello']
        },
        uninstall: undefined,
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

  it('rejects missing or unknown Teamem-aware Claude launcher lifecycle commands', () => {
    expect(parseCliArgs(['claude'])).toEqual({
      ok: false,
      error:
        'Missing teamem claude lifecycle command. Expected one of: install, status, uninstall'
    });
    expect(parseCliArgs(['claude', 'repair'])).toEqual({
      ok: false,
      error: 'Unknown teamem claude lifecycle command: repair'
    });
    expect(parseCliArgs(['claude', 'launch', '--teamem', '--pure'])).toEqual({
      ok: false,
      error: 'Choose only one Claude launch mode: --teamem or --pure'
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

  it('parses and rejects init Claude launcher install modes', () => {
    expect(parseCliArgs(['init', '--install-claude-launcher'])).toMatchObject({
      ok: true,
      value: {
        command: 'init',
        claudeLauncher: 'install'
      }
    });
    expect(parseCliArgs(['init', '--skip-claude-launcher'])).toMatchObject({
      ok: true,
      value: {
        command: 'init',
        claudeLauncher: 'skip'
      }
    });
    expect(
      parseCliArgs([
        'init',
        '--install-claude-launcher',
        '--skip-claude-launcher'
      ])
    ).toEqual({
      ok: false,
      error:
        'Choose only one Claude launcher mode: --install-claude-launcher or --skip-claude-launcher'
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

  it('prints the Teamem-aware launcher commands in help text', () => {
    const help = renderHelp();

    expect(help).toContain('claude install');
    expect(help).toContain('claude status');
    expect(help).toContain('claude uninstall');
    expect(help).toContain('Teamem-aware Claude launcher');
    expect(help).toContain('opt-in `claude` shim');
  });

  it('installs Teamem-owned machine-local Claude launcher state and shim', () => {
    const writes: string[] = [];
    const launcherFileSystem = createLauncherFileSystem({
      executableFiles: ['/opt/claude/bin/claude']
    });

    const exitCode = runCli(
      ['claude', 'install'],
      {
        stdout: {
          write(text: string) {
            writes.push(text);
          }
        },
        stderr: { write() {} }
      },
      createLauncherCliEnvironment({
        launcherFileSystem,
        pathEnv: '/tmp/home/.teamem/bin:/opt/claude/bin',
        homeDir: '/tmp/home'
      })
    );

    expect(exitCode).toBe(0);
    expect(
      launcherFileSystem.files.get('/tmp/home/.teamem/launcher/claude.json')
    ).toBe(
      '{\n  "version": 1,\n  "realClaudePath": "/opt/claude/bin/claude",\n  "shimPath": "/tmp/home/.teamem/bin/claude",\n  "installedAt": "2026-05-25T00:00:00.000Z"\n}\n'
    );
    expect(
      launcherFileSystem.files.get('/tmp/home/.teamem/bin/claude')
    ).toContain('# teamem-owned-claude-shim');
    expect(
      launcherFileSystem.files.get('/tmp/home/.teamem/bin/claude')
    ).toContain('teamem claude launch');
    expect(
      launcherFileSystem.files.get('/tmp/home/.teamem/bin/claude')
    ).toContain('teamem_launcher_mode="$1"');
    expect(
      launcherFileSystem.executableFiles.has('/tmp/home/.teamem/bin/claude')
    ).toBe(true);
    expect(writes.join('')).toContain('Status: installed-on-path');
    expect(writes.join('')).toContain(
      'export PATH="/tmp/home/.teamem/bin:$PATH"'
    );
    expect(
      [...launcherFileSystem.files.keys()].some((path) =>
        path.endsWith('.teamem/bootstrapper.json')
      )
    ).toBe(false);

    const reinstallExitCode = runCli(
      ['claude', 'install'],
      {
        stdout: { write() {} },
        stderr: { write() {} }
      },
      createLauncherCliEnvironment({
        launcherFileSystem,
        pathEnv: '/tmp/home/.teamem/bin:/opt/claude/bin',
        homeDir: '/tmp/home'
      })
    );
    expect(reinstallExitCode).toBe(0);
    expect(
      launcherFileSystem.files.get('/tmp/home/.teamem/launcher/claude.json')
    ).toContain('"realClaudePath": "/opt/claude/bin/claude"');
  });

  it('routes reserved launcher flags in the installed Claude shim before Claude args', () => {
    const launcherFileSystem = createLauncherFileSystem({
      executableFiles: ['/opt/claude/bin/claude']
    });

    const exitCode = runCli(
      ['claude', 'install'],
      { stdout: { write() {} }, stderr: { write() {} } },
      createLauncherCliEnvironment({
        launcherFileSystem,
        pathEnv: '/tmp/home/.teamem/bin:/opt/claude/bin',
        homeDir: '/tmp/home'
      })
    );

    expect(exitCode).toBe(0);
    const shimScript = launcherFileSystem.files.get(
      '/tmp/home/.teamem/bin/claude'
    );
    expect(shimScript).toBeDefined();
    expect(
      runInstalledShim(shimScript ?? '', ['--teamem', '--print', 'hi'])
    ).toEqual(['claude', 'launch', '--teamem', '--', '--print', 'hi']);
    expect(
      runInstalledShim(shimScript ?? '', ['--pure', '--print', 'hi'])
    ).toEqual(['claude', 'launch', '--pure', '--', '--print', 'hi']);
    expect(runInstalledShim(shimScript ?? '', ['--print', 'hi'])).toEqual([
      'claude',
      'launch',
      '--',
      '--print',
      'hi'
    ]);
    expect(runInstalledShim(shimScript ?? '', ['--', '--teamem'])).toEqual([
      'claude',
      'launch',
      '--',
      '--teamem'
    ]);
  });

  it('dry-runs Claude launcher install without writing files', () => {
    const writes: string[] = [];
    const launcherFileSystem = createLauncherFileSystem({
      executableFiles: ['/opt/claude/bin/claude']
    });

    const exitCode = runCli(
      ['claude', 'install', '--dry-run'],
      {
        stdout: {
          write(text: string) {
            writes.push(text);
          }
        },
        stderr: { write() {} }
      },
      createLauncherCliEnvironment({
        launcherFileSystem,
        pathEnv: '/opt/claude/bin',
        homeDir: '/tmp/home'
      })
    );

    expect(exitCode).toBe(0);
    expect(launcherFileSystem.files.size).toBe(0);
    expect(writes.join('')).toContain(
      'dry-run: no launcher files were changed'
    );
    expect(writes.join('')).toContain('/tmp/home/.teamem/bin/claude');
    expect(writes.join('')).toContain('/tmp/home/.teamem/launcher/claude.json');
  });

  it('excludes Teamem shim directory when detecting the real Claude Code path', () => {
    const launcherFileSystem = createLauncherFileSystem({
      executableFiles: [
        '/tmp/home/.teamem/bin/claude',
        '/opt/claude/bin/claude'
      ],
      files: {
        '/tmp/home/.teamem/bin/claude': '# teamem-owned-claude-shim\n'
      }
    });

    const exitCode = runCli(
      ['claude', 'install'],
      {
        stdout: { write() {} },
        stderr: { write() {} }
      },
      createLauncherCliEnvironment({
        launcherFileSystem,
        pathEnv: '/tmp/home/.teamem/bin:/opt/claude/bin',
        homeDir: '/tmp/home'
      })
    );

    expect(exitCode).toBe(0);
    expect(
      launcherFileSystem.files.get('/tmp/home/.teamem/launcher/claude.json')
    ).toContain('"realClaudePath": "/opt/claude/bin/claude"');
  });

  it('does not treat regular non-executable Claude files as usable', () => {
    const installWrites: string[] = [];
    const launcherFileSystem = createLauncherFileSystem({
      files: {
        '/opt/claude/bin/claude': '#!/usr/bin/env sh\nexit 0\n'
      }
    });

    const installExitCode = runCli(
      ['claude', 'install'],
      {
        stdout: {
          write(text: string) {
            installWrites.push(text);
          }
        },
        stderr: { write() {} }
      },
      createLauncherCliEnvironment({
        launcherFileSystem,
        pathEnv: '/opt/claude/bin',
        homeDir: '/tmp/home'
      })
    );

    expect(installExitCode).toBe(1);
    expect(installWrites.join('')).toContain(
      'Could not find the real Claude Code executable'
    );
    expect(
      launcherFileSystem.files.has('/tmp/home/.teamem/launcher/claude.json')
    ).toBe(false);

    launcherFileSystem.files.set(
      '/tmp/home/.teamem/bin/claude',
      '# teamem-owned-claude-shim\n'
    );
    launcherFileSystem.executableFiles.add('/tmp/home/.teamem/bin/claude');
    launcherFileSystem.files.set(
      '/tmp/home/.teamem/launcher/claude.json',
      '{"version":1,"realClaudePath":"/opt/claude/bin/claude","shimPath":"/tmp/home/.teamem/bin/claude","installedAt":"2026-05-25T00:00:00.000Z"}\n'
    );

    const statusWrites: string[] = [];
    const statusExitCode = runCli(
      ['claude', 'status'],
      {
        stdout: {
          write(text: string) {
            statusWrites.push(text);
          }
        },
        stderr: { write() {} }
      },
      createLauncherCliEnvironment({
        launcherFileSystem,
        pathEnv: '/tmp/home/.teamem/bin:/opt/claude/bin',
        homeDir: '/tmp/home'
      })
    );

    expect(statusExitCode).toBe(1);
    expect(statusWrites.join('')).toContain(
      'Status: recorded-real-claude-missing'
    );
    expect(statusWrites.join('')).toContain(
      'Recorded path is not executable: /opt/claude/bin/claude'
    );
  });

  it('does not treat executable PATH directories named claude as real Claude Code', () => {
    const sandboxRoot = mkdtempSync(join(tmpdir(), 'teamem-claude-dir-'));
    try {
      const homeDir = join(sandboxRoot, 'home');
      const fakeBinDir = join(sandboxRoot, 'fake-bin');
      const fakeClaudeDirectory = join(fakeBinDir, 'claude');
      const shimDir = join(homeDir, '.teamem', 'bin');
      const stateDir = join(homeDir, '.teamem', 'launcher');
      const shimPath = join(shimDir, 'claude');
      const statePath = join(stateDir, 'claude.json');

      mkdirSync(fakeClaudeDirectory, { recursive: true });
      chmodSync(fakeClaudeDirectory, 0o755);

      const installWrites: string[] = [];
      const installExitCode = runCli(
        ['claude', 'install'],
        {
          stdout: {
            write(text: string) {
              installWrites.push(text);
            }
          },
          stderr: { write() {} }
        },
        createLauncherCliEnvironment({
          pathEnv: fakeBinDir,
          homeDir
        })
      );

      expect(installExitCode).toBe(1);
      expect(installWrites.join('')).toContain(
        'Could not find the real Claude Code executable'
      );

      mkdirSync(shimDir, { recursive: true });
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(shimPath, '# teamem-owned-claude-shim\n', 'utf8');
      chmodSync(shimPath, 0o755);
      writeFileSync(
        statePath,
        `${JSON.stringify({
          version: 1,
          realClaudePath: fakeClaudeDirectory,
          shimPath,
          installedAt: '2026-05-25T00:00:00.000Z'
        })}\n`,
        'utf8'
      );

      const statusWrites: string[] = [];
      const statusExitCode = runCli(
        ['claude', 'status'],
        {
          stdout: {
            write(text: string) {
              statusWrites.push(text);
            }
          },
          stderr: { write() {} }
        },
        createLauncherCliEnvironment({
          pathEnv: `${shimDir}${delimiter}${fakeBinDir}`,
          homeDir
        })
      );

      expect(statusExitCode).toBe(1);
      expect(statusWrites.join('')).toContain(
        'Status: recorded-real-claude-missing'
      );
    } finally {
      rmSync(sandboxRoot, { recursive: true, force: true });
    }
  });

  it('refuses to overwrite a non-Teamem-owned Claude shim', () => {
    const writes: string[] = [];
    const launcherFileSystem = createLauncherFileSystem({
      executableFiles: [
        '/opt/claude/bin/claude',
        '/tmp/home/.teamem/bin/claude'
      ],
      files: {
        '/tmp/home/.teamem/bin/claude': '#!/usr/bin/env sh\necho custom\n'
      }
    });

    const exitCode = runCli(
      ['claude', 'install'],
      {
        stdout: {
          write(text: string) {
            writes.push(text);
          }
        },
        stderr: { write() {} }
      },
      createLauncherCliEnvironment({
        launcherFileSystem,
        pathEnv: '/tmp/home/.teamem/bin:/opt/claude/bin',
        homeDir: '/tmp/home'
      })
    );

    expect(exitCode).toBe(1);
    expect(writes.join('')).toContain('Refusing to overwrite');
    expect(launcherFileSystem.files.get('/tmp/home/.teamem/bin/claude')).toBe(
      '#!/usr/bin/env sh\necho custom\n'
    );
    expect(
      launcherFileSystem.files.has('/tmp/home/.teamem/launcher/claude.json')
    ).toBe(false);
  });

  it('refuses an existing directory at the Teamem Claude shim path', () => {
    const sandboxRoot = mkdtempSync(join(tmpdir(), 'teamem-shim-dir-'));
    try {
      const homeDir = join(sandboxRoot, 'home');
      const shimPath = join(homeDir, '.teamem', 'bin', 'claude');
      const realClaudeDir = join(sandboxRoot, 'real-bin');
      const realClaudePath = join(realClaudeDir, 'claude');
      mkdirSync(shimPath, { recursive: true });
      mkdirSync(realClaudeDir, { recursive: true });
      writeFileSync(realClaudePath, '#!/bin/sh\nexit 0\n', 'utf8');
      chmodSync(realClaudePath, 0o755);

      const writes: string[] = [];
      const exitCode = runCli(
        ['claude', 'install'],
        {
          stdout: {
            write(text: string) {
              writes.push(text);
            }
          },
          stderr: { write() {} }
        },
        createLauncherCliEnvironment({
          pathEnv: `${join(homeDir, '.teamem', 'bin')}${delimiter}${realClaudeDir}`,
          homeDir
        })
      );

      expect(exitCode).toBe(1);
      expect(writes.join('')).toContain('Refusing to overwrite');
      expect(writes.join('')).toContain(`Existing path: ${shimPath}`);
    } finally {
      rmSync(sandboxRoot, { recursive: true, force: true });
    }
  });

  it('distinguishes installed launcher status states', () => {
    const installed = runLauncherStatus({
      pathEnv: '/tmp/home/.teamem/bin:/opt/claude/bin',
      executableFiles: [
        '/tmp/home/.teamem/bin/claude',
        '/opt/claude/bin/claude'
      ]
    });
    expect(installed.exitCode).toBe(0);
    expect(installed.output).toContain('Status: installed-on-path');

    const notFirst = runLauncherStatus({
      pathEnv: '/opt/claude/bin:/tmp/home/.teamem/bin',
      executableFiles: [
        '/tmp/home/.teamem/bin/claude',
        '/opt/claude/bin/claude'
      ]
    });
    expect(notFirst.exitCode).toBe(0);
    expect(notFirst.output).toContain('Status: installed-not-first-on-path');

    const missingReal = runLauncherStatus({
      pathEnv: '/tmp/home/.teamem/bin',
      executableFiles: ['/tmp/home/.teamem/bin/claude']
    });
    expect(missingReal.exitCode).toBe(1);
    expect(missingReal.output).toContain(
      'Status: recorded-real-claude-missing'
    );

    const notInstalled = runCli(
      ['claude', 'status'],
      {
        stdout: {
          write(text: string) {
            installed.writes.push(text);
          }
        },
        stderr: { write() {} }
      },
      createLauncherCliEnvironment({
        launcherFileSystem: createLauncherFileSystem(),
        pathEnv: '/opt/claude/bin',
        homeDir: '/tmp/home'
      })
    );
    expect(notInstalled).toBe(0);
    expect(installed.writes.join('')).toContain('Status: not-installed');
  });

  it('uninstalls only Teamem-owned launcher files and tolerates partial state', () => {
    const writes: string[] = [];
    const launcherFileSystem = createLauncherFileSystem({
      executableFiles: ['/tmp/home/.teamem/bin/claude'],
      files: {
        '/tmp/home/.teamem/bin/claude': '# teamem-owned-claude-shim\n',
        '/tmp/home/.teamem/launcher/claude.json':
          '{"version":1,"realClaudePath":"/opt/claude/bin/claude","shimPath":"/tmp/home/.teamem/bin/claude","installedAt":"2026-05-25T00:00:00.000Z"}\n'
      }
    });

    const exitCode = runCli(
      ['claude', 'uninstall'],
      {
        stdout: {
          write(text: string) {
            writes.push(text);
          }
        },
        stderr: { write() {} }
      },
      createLauncherCliEnvironment({
        launcherFileSystem,
        pathEnv: '/tmp/home/.teamem/bin',
        homeDir: '/tmp/home'
      })
    );

    expect(exitCode).toBe(0);
    expect(launcherFileSystem.files.has('/tmp/home/.teamem/bin/claude')).toBe(
      false
    );
    expect(
      launcherFileSystem.files.has('/tmp/home/.teamem/launcher/claude.json')
    ).toBe(false);
    expect(writes.join('')).toContain('Removals:');

    const partialFileSystem = createLauncherFileSystem({
      files: {
        '/tmp/home/.teamem/launcher/claude.json':
          '{"version":1,"realClaudePath":"/opt/claude/bin/claude","shimPath":"/tmp/home/.teamem/bin/claude","installedAt":"2026-05-25T00:00:00.000Z"}\n'
      }
    });
    expect(
      runCli(
        ['claude', 'uninstall'],
        { stdout: { write() {} }, stderr: { write() {} } },
        createLauncherCliEnvironment({
          launcherFileSystem: partialFileSystem,
          pathEnv: '',
          homeDir: '/tmp/home'
        })
      )
    ).toBe(0);
    expect(
      partialFileSystem.files.has('/tmp/home/.teamem/launcher/claude.json')
    ).toBe(false);
  });

  it('dry-runs Claude launcher uninstall and preserves non-Teamem shim files', () => {
    const writes: string[] = [];
    const launcherFileSystem = createLauncherFileSystem({
      executableFiles: ['/tmp/home/.teamem/bin/claude'],
      files: {
        '/tmp/home/.teamem/bin/claude': '#!/usr/bin/env sh\necho custom\n',
        '/tmp/home/.teamem/launcher/claude.json':
          '{"version":1,"realClaudePath":"/opt/claude/bin/claude","shimPath":"/tmp/home/.teamem/bin/claude","installedAt":"2026-05-25T00:00:00.000Z"}\n'
      }
    });

    const exitCode = runCli(
      ['claude', 'uninstall', '--dry-run'],
      {
        stdout: {
          write(text: string) {
            writes.push(text);
          }
        },
        stderr: { write() {} }
      },
      createLauncherCliEnvironment({
        launcherFileSystem,
        pathEnv: '/tmp/home/.teamem/bin',
        homeDir: '/tmp/home'
      })
    );

    expect(exitCode).toBe(0);
    expect(launcherFileSystem.files.has('/tmp/home/.teamem/bin/claude')).toBe(
      true
    );
    expect(
      launcherFileSystem.files.has('/tmp/home/.teamem/launcher/claude.json')
    ).toBe(true);
    expect(writes.join('')).toContain(
      'dry-run: no launcher files were changed'
    );
    expect(writes.join('')).toContain('Preserved non-Teamem path');
  });

  it('uninstalls the Claude shim with a user-friendly restore hint', () => {
    const writes: string[] = [];
    const launcherFileSystem = createLauncherFileSystem({
      executableFiles: ['/tmp/home/.teamem/bin/claude'],
      files: {
        '/tmp/home/.teamem/bin/claude': '# teamem-owned-claude-shim\n',
        '/tmp/home/.teamem/launcher/claude.json':
          '{"version":1,"realClaudePath":"/opt/claude/bin/claude","shimPath":"/tmp/home/.teamem/bin/claude","installedAt":"2026-05-25T00:00:00.000Z"}\n'
      }
    });

    const exitCode = runCli(
      ['claude', 'uninstall'],
      {
        stdout: {
          write(text: string) {
            writes.push(text);
          }
        },
        stderr: { write() {} }
      },
      createLauncherCliEnvironment({
        launcherFileSystem,
        pathEnv: '/tmp/home/.teamem/bin',
        homeDir: '/tmp/home'
      })
    );

    expect(exitCode).toBe(0);
    expect(launcherFileSystem.files.has('/tmp/home/.teamem/bin/claude')).toBe(
      false
    );
    expect(
      launcherFileSystem.files.has('/tmp/home/.teamem/launcher/claude.json')
    ).toBe(false);
    expect(writes.join('')).toContain('teamem claude uninstall');
    expect(writes.join('')).toContain('Claude Code restored');
    expect(writes.join('')).toContain('hash -r');
    expect(writes.join('')).toContain('which claude');
  });

  it('defaults the interactive Claude shim prompt to Teamem launch args', () => {
    const launcherFileSystem = createInstalledLauncherFileSystem();
    const runner = createClaudeLaunchRecorder();
    const promptMessages: string[] = [];

    const exitCode = runCli(
      ['claude', 'launch', '--', '--print', 'hello'],
      {
        stdout: { write() {} },
        stderr: { write() {} }
      },
      createLauncherCliEnvironment({
        launcherFileSystem,
        pathEnv: '/tmp/home/.teamem/bin:/opt/claude/bin:/usr/bin',
        homeDir: '/tmp/home',
        claudeLaunchProcessRunner: runner,
        env: {
          PATH: '/tmp/home/.teamem/bin:/opt/claude/bin:/usr/bin',
          TEAMEM_CLAUDE_LAUNCHER_STATE:
            '/tmp/home/.teamem/launcher/claude.json',
          PRESERVED: '1'
        },
        promptEnvironment: {
          isInteractive: () => true,
          prompt(message) {
            promptMessages.push(message);
            return '';
          }
        }
      })
    );

    expect(exitCode).toBe(0);
    expect(promptMessages).toEqual(['Start Claude Code with Teamem? [Y/n] ']);
    expect(runner.invocations).toEqual([
      {
        command: '/opt/claude/bin/claude',
        args: [
          '--dangerously-load-development-channels',
          'plugin:teamem@teamem-alpha',
          '--print',
          'hello'
        ],
        env: {
          PATH: '/opt/claude/bin:/usr/bin',
          PRESERVED: '1',
          TEAMEM_CLAUDE_LAUNCH_INTENT: 'activate'
        }
      }
    ]);
  });

  it('launches pure Claude when the interactive prompt answer is no', () => {
    const runner = createClaudeLaunchRecorder();

    const exitCode = runCli(
      ['claude', 'launch', '--', '--model', 'sonnet'],
      { stdout: { write() {} }, stderr: { write() {} } },
      createLauncherCliEnvironment({
        launcherFileSystem: createInstalledLauncherFileSystem(),
        pathEnv: '/tmp/home/.teamem/bin:/opt/claude/bin',
        homeDir: '/tmp/home',
        claudeLaunchProcessRunner: runner,
        env: {
          PATH: '/tmp/home/.teamem/bin:/opt/claude/bin',
          TEAMEM_CLAUDE_LAUNCHER_STATE:
            '/tmp/home/.teamem/launcher/claude.json',
          TEAMEM_CLAUDE_LAUNCH_INTENT: 'activate',
          TEAMEM_CLAUDE_LAUNCH_SPACE: 'stale-space'
        },
        promptEnvironment: {
          isInteractive: () => true,
          prompt: () => 'n'
        }
      })
    );

    expect(exitCode).toBe(0);
    expect(runner.invocations[0]).toEqual({
      command: '/opt/claude/bin/claude',
      args: ['--model', 'sonnet'],
      env: {
        PATH: '/opt/claude/bin'
      }
    });
  });

  it('blocks pure Claude launch when the recorded real Claude executable is missing', () => {
    const runner = createClaudeLaunchRecorder();
    const stderr: string[] = [];
    const launcherFileSystem = createInstalledLauncherFileSystem();
    launcherFileSystem.executableFiles.delete('/opt/claude/bin/claude');

    const exitCode = runCli(
      ['claude', 'launch', '--pure', '--', '--resume'],
      {
        stdout: { write() {} },
        stderr: {
          write(text: string) {
            stderr.push(text);
          }
        }
      },
      createLauncherCliEnvironment({
        launcherFileSystem,
        pathEnv: '/tmp/home/.teamem/bin:/opt/claude/bin',
        homeDir: '/tmp/home',
        claudeLaunchProcessRunner: runner,
        env: {
          PATH: '/tmp/home/.teamem/bin:/opt/claude/bin',
          TEAMEM_CLAUDE_LAUNCHER_STATE:
            '/tmp/home/.teamem/launcher/claude.json'
        },
        promptEnvironment: {
          isInteractive: () => false,
          prompt: () => {
            throw new Error('should not prompt');
          }
        }
      })
    );

    expect(exitCode).toBe(1);
    expect(runner.invocations).toEqual([]);
    expect(stderr.join('')).toContain(
      'recorded real Claude Code executable is not available'
    );
    expect(stderr.join('')).toContain('/opt/claude/bin/claude');
    expect(stderr.join('')).toContain('teamem claude install');
  });

  it('launches pure Claude on prompt cancellation or EOF', () => {
    const runner = createClaudeLaunchRecorder();

    const exitCode = runCli(
      ['claude', 'launch'],
      { stdout: { write() {} }, stderr: { write() {} } },
      createLauncherCliEnvironment({
        launcherFileSystem: createInstalledLauncherFileSystem(),
        pathEnv: '/tmp/home/.teamem/bin:/opt/claude/bin',
        homeDir: '/tmp/home',
        claudeLaunchProcessRunner: runner,
        env: {
          PATH: '/tmp/home/.teamem/bin:/opt/claude/bin',
          TEAMEM_CLAUDE_LAUNCHER_STATE: '/tmp/home/.teamem/launcher/claude.json'
        },
        promptEnvironment: {
          isInteractive: () => true,
          prompt: () => null
        }
      })
    );

    expect(exitCode).toBe(0);
    expect(runner.invocations[0]?.args).toEqual([]);
  });

  it('launches pure Claude when the interactive prompt throws', () => {
    const runner = createClaudeLaunchRecorder();

    const exitCode = runCli(
      ['claude', 'launch'],
      { stdout: { write() {} }, stderr: { write() {} } },
      createLauncherCliEnvironment({
        launcherFileSystem: createInstalledLauncherFileSystem(),
        pathEnv: '/tmp/home/.teamem/bin:/opt/claude/bin',
        homeDir: '/tmp/home',
        claudeLaunchProcessRunner: runner,
        env: {
          PATH: '/tmp/home/.teamem/bin:/opt/claude/bin',
          TEAMEM_CLAUDE_LAUNCHER_STATE: '/tmp/home/.teamem/launcher/claude.json'
        },
        promptEnvironment: {
          isInteractive: () => true,
          prompt: () => {
            throw new Error('cancelled');
          }
        }
      })
    );

    expect(exitCode).toBe(0);
    expect(runner.invocations[0]?.args).toEqual([]);
  });

  it('defaults non-interactive Claude shim launch to pure Claude without prompting', () => {
    const runner = createClaudeLaunchRecorder();

    const exitCode = runCli(
      ['claude', 'launch', '--', '--resume'],
      { stdout: { write() {} }, stderr: { write() {} } },
      createLauncherCliEnvironment({
        launcherFileSystem: createInstalledLauncherFileSystem(),
        pathEnv: '/tmp/home/.teamem/bin:/opt/claude/bin',
        homeDir: '/tmp/home',
        claudeLaunchProcessRunner: runner,
        env: {
          PATH: '/tmp/home/.teamem/bin:/opt/claude/bin',
          TEAMEM_CLAUDE_LAUNCHER_STATE: '/tmp/home/.teamem/launcher/claude.json'
        },
        promptEnvironment: {
          isInteractive: () => false,
          prompt: () => {
            throw new Error('should not prompt');
          }
        }
      })
    );

    expect(exitCode).toBe(0);
    expect(runner.invocations[0]).toEqual({
      command: '/opt/claude/bin/claude',
      args: ['--resume'],
      env: {
        PATH: '/opt/claude/bin'
      }
    });
  });

  it('allows explicit non-interactive Teamem opt-in and pure opt-out', () => {
    const teamemRunner = createClaudeLaunchRecorder();
    const pureRunner = createClaudeLaunchRecorder();

    const teamemExitCode = runCli(
      ['claude', 'launch', '--teamem', '--', '--continue'],
      { stdout: { write() {} }, stderr: { write() {} } },
      createLauncherCliEnvironment({
        launcherFileSystem: createInstalledLauncherFileSystem(),
        pathEnv: '/tmp/home/.teamem/bin:/opt/claude/bin',
        homeDir: '/tmp/home',
        claudeLaunchProcessRunner: teamemRunner,
        env: {
          PATH: '/tmp/home/.teamem/bin:/opt/claude/bin',
          TEAMEM_CLAUDE_LAUNCHER_STATE: '/tmp/home/.teamem/launcher/claude.json'
        },
        promptEnvironment: {
          isInteractive: () => false,
          prompt: () => {
            throw new Error('should not prompt');
          }
        }
      })
    );
    const pureExitCode = runCli(
      ['claude', 'launch', '--pure', '--', '--continue'],
      { stdout: { write() {} }, stderr: { write() {} } },
      createLauncherCliEnvironment({
        launcherFileSystem: createInstalledLauncherFileSystem(),
        pathEnv: '/tmp/home/.teamem/bin:/opt/claude/bin',
        homeDir: '/tmp/home',
        claudeLaunchProcessRunner: pureRunner,
        env: {
          PATH: '/tmp/home/.teamem/bin:/opt/claude/bin',
          TEAMEM_CLAUDE_LAUNCHER_STATE: '/tmp/home/.teamem/launcher/claude.json'
        },
        promptEnvironment: {
          isInteractive: () => false,
          prompt: () => {
            throw new Error('should not prompt');
          }
        }
      })
    );

    expect(teamemExitCode).toBe(0);
    expect(pureExitCode).toBe(0);
    expect(teamemRunner.invocations[0]?.args).toEqual([
      '--dangerously-load-development-channels',
      'plugin:teamem@teamem-alpha',
      '--continue'
    ]);
    expect(teamemRunner.invocations[0]?.env).toMatchObject({
      PATH: '/opt/claude/bin',
      TEAMEM_CLAUDE_LAUNCH_INTENT: 'activate'
    });
    expect(pureRunner.invocations[0]?.args).toEqual(['--continue']);
    expect(pureRunner.invocations[0]?.env.TEAMEM_CLAUDE_LAUNCH_INTENT).toBe(
      undefined
    );
  });

  it('blocks Teamem launch when a required prerequisite is missing', () => {
    const runner = createClaudeLaunchRecorder();
    const stderr: string[] = [];

    const exitCode = runCli(
      ['claude', 'launch', '--teamem'],
      {
        stdout: { write() {} },
        stderr: { write: (text: string) => stderr.push(text) }
      },
      createLauncherCliEnvironment({
        launcherFileSystem: createInstalledLauncherFileSystem(),
        commandRunner: createFakeRunner({
          '/opt/claude/bin/claude --version': ok('1.0.0'),
          'bun --version': missing(),
          'git --version': ok('git version 2.0.0'),
          'git rev-parse --is-inside-work-tree': ok('true\n')
        }),
        pathEnv: '/tmp/home/.teamem/bin:/opt/claude/bin',
        homeDir: '/tmp/home',
        claudeLaunchProcessRunner: runner,
        env: {
          PATH: '/tmp/home/.teamem/bin:/opt/claude/bin',
          TEAMEM_CLAUDE_LAUNCHER_STATE: '/tmp/home/.teamem/launcher/claude.json'
        }
      })
    );

    expect(exitCode).toBe(1);
    expect(runner.invocations).toEqual([]);
    expect(stderr.join('')).toContain('Bun is not ready');
    expect(stderr.join('')).toContain('teamem init');
  });

  it('blocks Teamem launch when the Teamem plugin is missing', () => {
    const result = runTeamemReadinessFailure({
      commandRunner: createReadyLaunchCommandRunner({
        pluginList: '[]'
      })
    });

    expect(result.exitCode).toBe(1);
    expect(result.invocations).toEqual([]);
    expect(result.stderr).toContain(
      'Teamem Claude Code plugin is not installed'
    );
    expect(result.stderr).toContain('teamem init');
  });

  it('blocks Teamem launch when the installed Teamem plugin lacks slash commands', () => {
    const fileSystem = createInstalledLauncherFileSystem();
    fileSystem.files.set(
      '/plugins/teamem/.claude-plugin/plugin.json',
      JSON.stringify({
        name: 'teamem',
        version: '0.3.17',
        skills: './skills/',
        mcpServers: './.mcp.json'
      })
    );
    const result = runTeamemReadinessFailure({
      launcherFileSystem: fileSystem
    });

    expect(result.exitCode).toBe(1);
    expect(result.invocations).toEqual([]);
    expect(result.stderr).toContain('plugin install is incomplete or stale');
    expect(result.stderr).toContain('does not declare Teamem slash commands');
    expect(result.stderr).toContain('teamem update');
  });

  it('blocks Teamem launch when the installed Teamem plugin lacks a required command entry', () => {
    const fileSystem = createInstalledLauncherFileSystem();
    fileSystem.files.set(
      '/plugins/teamem/.claude-plugin/plugin.json',
      JSON.stringify({
        name: 'teamem',
        version: '0.3.20',
        commands: [
          './commands/teamem-setup.md',
          './commands/teamem-status.md',
          './commands/teamem-briefing.md'
        ],
        skills: './skills/',
        mcpServers: './.mcp.json'
      })
    );
    const result = runTeamemReadinessFailure({
      launcherFileSystem: fileSystem
    });

    expect(result.exitCode).toBe(1);
    expect(result.invocations).toEqual([]);
    expect(result.stderr).toContain('plugin install is incomplete or stale');
    expect(result.stderr).toContain(
      'missing required command entry: ./commands/teamem-on.md'
    );
  });

  it('blocks Teamem launch when project-scoped plugin belongs to another project', () => {
    const result = runTeamemReadinessFailure({
      commandRunner: createReadyLaunchCommandRunner({
        pluginList: JSON.stringify({
          plugins: [
            {
              id: 'teamem@teamem-alpha',
              scope: 'project',
              installPath: '/plugins/teamem',
              projectPath: '/tmp/other-project'
            }
          ]
        })
      })
    });

    expect(result.exitCode).toBe(1);
    expect(result.invocations).toEqual([]);
    expect(result.stderr).toContain(
      'Teamem Claude Code plugin is not installed'
    );
    expect(result.stderr).toContain('teamem init');
  });

  it('matches a project-scoped plugin from a repo subdirectory launch', () => {
    const runner = createClaudeLaunchRecorder();
    const exitCode = runCli(
      ['claude', 'launch', '--teamem', '--', '--continue'],
      { stdout: { write() {} }, stderr: { write() {} } },
      createLauncherCliEnvironment({
        launcherFileSystem: createInstalledLauncherFileSystem(),
        commandRunner: createReadyLaunchCommandRunner({
          repoRoot: '/tmp/project',
          pluginList: JSON.stringify({
            plugins: [
              {
                id: 'teamem@teamem-alpha',
                scope: 'project',
                installPath: '/plugins/teamem',
                projectPath: '/tmp/project'
              }
            ]
          })
        }),
        cwd: '/tmp/project/subdir',
        pathEnv: '/tmp/home/.teamem/bin:/opt/claude/bin',
        homeDir: '/tmp/home',
        claudeLaunchProcessRunner: runner,
        env: {
          PATH: '/tmp/home/.teamem/bin:/opt/claude/bin',
          TEAMEM_CLAUDE_LAUNCHER_STATE: '/tmp/home/.teamem/launcher/claude.json'
        }
      })
    );

    expect(exitCode).toBe(0);
    expect(runner.invocations[0]?.args).toContain('plugin:teamem@teamem-alpha');
  });

  it('blocks Teamem launch when credentials are missing', () => {
    const fileSystem = createInstalledLauncherFileSystem();
    fileSystem.files.delete('/tmp/home/.teamem/credentials.json');
    const result = runTeamemReadinessFailure({
      launcherFileSystem: fileSystem
    });

    expect(result.exitCode).toBe(1);
    expect(result.invocations).toEqual([]);
    expect(result.stderr).toContain('credentials are missing');
    expect(result.stderr).toContain('teamem init');
  });

  it('blocks Teamem launch when credentials are malformed', () => {
    const fileSystem = createInstalledLauncherFileSystem();
    fileSystem.files.set('/tmp/home/.teamem/credentials.json', '{nope');
    const result = runTeamemReadinessFailure({
      launcherFileSystem: fileSystem
    });

    expect(result.exitCode).toBe(1);
    expect(result.invocations).toEqual([]);
    expect(result.stderr).toContain('credentials are malformed');
    expect(result.stderr).toContain('teamem init');
  });

  it('blocks Teamem launch when the requested Space does not resolve', () => {
    const result = runTeamemReadinessFailure({
      env: {
        PATH: '/tmp/home/.teamem/bin:/opt/claude/bin',
        TEAMEM_CLAUDE_LAUNCHER_STATE: '/tmp/home/.teamem/launcher/claude.json',
        TEAMEM_SPACE: 'missing-space'
      }
    });

    expect(result.exitCode).toBe(1);
    expect(result.invocations).toEqual([]);
    expect(result.stderr).toContain('no usable Teamem Space resolved');
    expect(result.stderr).toContain("Space 'missing-space' was not found");
  });

  it('blocks Teamem launch when the selected Space token is expired', () => {
    const fileSystem = createInstalledLauncherFileSystem({
      credentials: createCredentialsJson({ jwtExp: 1 })
    });
    const result = runTeamemReadinessFailure({
      launcherFileSystem: fileSystem
    });

    expect(result.exitCode).toBe(1);
    expect(result.invocations).toEqual([]);
    expect(result.stderr).toContain('selected Space token is expired');
    expect(result.stderr).toContain('teamem init');
  });

  it('launches Teamem when readiness checks pass', () => {
    const runner = createClaudeLaunchRecorder();

    const exitCode = runCli(
      ['claude', 'launch', '--teamem', '--', '--continue'],
      { stdout: { write() {} }, stderr: { write() {} } },
      createLauncherCliEnvironment({
        launcherFileSystem: createInstalledLauncherFileSystem(),
        pathEnv: '/tmp/home/.teamem/bin:/opt/claude/bin',
        homeDir: '/tmp/home',
        claudeLaunchProcessRunner: runner,
        env: {
          PATH: '/tmp/home/.teamem/bin:/opt/claude/bin',
          TEAMEM_CLAUDE_LAUNCHER_STATE: '/tmp/home/.teamem/launcher/claude.json'
        }
      })
    );

    expect(exitCode).toBe(0);
    expect(runner.invocations[0]?.args).toEqual([
      '--dangerously-load-development-channels',
      'plugin:teamem@teamem-alpha',
      '--continue'
    ]);
    expect(runner.invocations[0]?.env.TEAMEM_CLAUDE_LAUNCH_INTENT).toBe(
      'activate'
    );
  });

  it('passes explicit Space override through Teamem launch intent', () => {
    const runner = createClaudeLaunchRecorder();

    const exitCode = runCli(
      ['claude', 'launch', '--teamem'],
      { stdout: { write() {} }, stderr: { write() {} } },
      createLauncherCliEnvironment({
        launcherFileSystem: createInstalledLauncherFileSystem(),
        pathEnv: '/tmp/home/.teamem/bin:/opt/claude/bin',
        homeDir: '/tmp/home',
        claudeLaunchProcessRunner: runner,
        env: {
          PATH: '/tmp/home/.teamem/bin:/opt/claude/bin',
          TEAMEM_CLAUDE_LAUNCHER_STATE:
            '/tmp/home/.teamem/launcher/claude.json',
          TEAMEM_SPACE: 'Alpha'
        }
      })
    );

    expect(exitCode).toBe(0);
    expect(runner.invocations[0]?.env).toMatchObject({
      PATH: '/opt/claude/bin',
      TEAMEM_SPACE: 'Alpha',
      TEAMEM_CLAUDE_LAUNCH_INTENT: 'activate',
      TEAMEM_CLAUDE_LAUNCH_SPACE: 'Alpha'
    });
  });

  it('does not remember Claude shim prompt choices across launches', () => {
    const launcherFileSystem = createInstalledLauncherFileSystem();
    const runner = createClaudeLaunchRecorder();
    const answers = ['', 'n'];

    for (let index = 0; index < 2; index += 1) {
      const exitCode = runCli(
        ['claude', 'launch'],
        { stdout: { write() {} }, stderr: { write() {} } },
        createLauncherCliEnvironment({
          launcherFileSystem,
          pathEnv: '/tmp/home/.teamem/bin:/opt/claude/bin',
          homeDir: '/tmp/home',
          claudeLaunchProcessRunner: runner,
          env: {
            PATH: '/tmp/home/.teamem/bin:/opt/claude/bin',
            TEAMEM_CLAUDE_LAUNCHER_STATE:
              '/tmp/home/.teamem/launcher/claude.json'
          },
          promptEnvironment: {
            isInteractive: () => true,
            prompt: () => answers[index] ?? 'n'
          }
        })
      );
      expect(exitCode).toBe(0);
    }

    expect(runner.invocations[0]?.args).toEqual([
      '--dangerously-load-development-channels',
      'plugin:teamem@teamem-alpha'
    ]);
    expect(runner.invocations[1]?.args).toEqual([]);
    expect(launcherFileSystem.files.has('/tmp/home/.teamem/bin/claude')).toBe(
      true
    );
    expect(
      launcherFileSystem.files.has('/tmp/home/.teamem/launcher/claude.json')
    ).toBe(true);
    expect(
      launcherFileSystem.files.has('/tmp/home/.teamem/credentials.json')
    ).toBe(true);
  });

  it('turns teamem cc into a non-zero compatibility error without launching Claude Code', () => {
    const commandRunner = createRecordingRunner({});
    const stderr: string[] = [];

    const exitCode = runCli(
      ['cc'],
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
        }
      }
    );

    expect(exitCode).toBe(1);
    expect(commandRunner.invocations).toEqual([]);
    const message = stderr.join('');
    expect(message).toContain('no longer launches Claude Code');
    expect(message).toContain('teamem claude install');
    expect(message).toContain(
      'prompts before starting Claude Code with Teamem'
    );
    expect(message).toContain('preserves a pure Claude Code path');
    expect(message).toContain(
      'then start Claude Code with normal `claude`'
    );
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

  it('offers the Claude launcher after interactive init setup and defaults to install', () => {
    const writes: string[] = [];
    const prompts: string[] = [];
    const fileSystem = createMemoryFileSystem();
    const setupRunner = createSetupRunnerStub();
    const launcherFileSystem = createLauncherFileSystem({
      executableFiles: ['/opt/claude/bin/claude']
    });

    const exitCode = runCli(
      ['init', '--scope', 'local', '--skip-git-hooks'],
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
        setupRunner,
        claudeLauncherFileSystem: launcherFileSystem,
        promptEnvironment: {
          isInteractive: () => true,
          prompt(message) {
            prompts.push(message);
            return '';
          }
        },
        pathEnv: '/opt/claude/bin',
        homeDir: '/tmp/home',
        now: () => new Date('2026-05-25T00:00:00.000Z')
      }
    );

    expect(exitCode).toBe(0);
    expect(setupRunner.invocations).toEqual([
      { mode: 'interactive', args: [] }
    ]);
    expect(prompts).toEqual([
      'Install the Teamem-aware Claude launcher? [Y/n]: '
    ]);
    expect(
      launcherFileSystem.files.get('/tmp/home/.teamem/bin/claude')
    ).toContain('# teamem-owned-claude-shim');
    expect(writes.join('')).toContain('teamem claude install');
  });

  it('forces Claude launcher install during non-interactive init only with an explicit flag', () => {
    const launcherFileSystem = createLauncherFileSystem({
      executableFiles: ['/opt/claude/bin/claude']
    });
    const setupRunner = createSetupRunnerStub();

    const exitCode = runCli(
      [
        'init',
        '--scope',
        'local',
        '--skip-git-hooks',
        '--install-claude-launcher'
      ],
      {
        stdout: { write() {} },
        stderr: { write() {} }
      },
      createSuccessfulInitEnvironment({
        setupRunner,
        launcherFileSystem,
        pathEnv: '/opt/claude/bin'
      })
    );

    expect(exitCode).toBe(0);
    expect(
      launcherFileSystem.files.has('/tmp/home/.teamem/launcher/claude.json')
    ).toBe(true);
  });

  it('skips Claude launcher install during non-interactive init by default or explicit skip', () => {
    const defaultWrites: string[] = [];
    const defaultLauncherFileSystem = createLauncherFileSystem({
      executableFiles: ['/opt/claude/bin/claude']
    });

    const defaultExitCode = runCli(
      ['init', '--scope', 'local', '--skip-git-hooks'],
      {
        stdout: {
          write(text: string) {
            defaultWrites.push(text);
          }
        },
        stderr: { write() {} }
      },
      createSuccessfulInitEnvironment({
        launcherFileSystem: defaultLauncherFileSystem,
        pathEnv: '/opt/claude/bin'
      })
    );

    expect(defaultExitCode).toBe(0);
    expect(defaultLauncherFileSystem.files.size).toBe(0);
    expect(defaultWrites.join('')).toContain(
      'Claude launcher was not installed because this session is non-interactive'
    );

    const skipWrites: string[] = [];
    const skipLauncherFileSystem = createLauncherFileSystem({
      executableFiles: ['/opt/claude/bin/claude']
    });
    const skipExitCode = runCli(
      [
        'init',
        '--scope',
        'local',
        '--skip-git-hooks',
        '--skip-claude-launcher'
      ],
      {
        stdout: {
          write(text: string) {
            skipWrites.push(text);
          }
        },
        stderr: { write() {} }
      },
      createSuccessfulInitEnvironment({
        launcherFileSystem: skipLauncherFileSystem,
        pathEnv: '/opt/claude/bin'
      })
    );

    expect(skipExitCode).toBe(0);
    expect(skipLauncherFileSystem.files.size).toBe(0);
    expect(skipWrites.join('')).toContain(
      'Claude launcher skipped by --skip-claude-launcher.'
    );
    expect(skipWrites.join('')).not.toContain(
      'Claude launcher was not installed because this session is non-interactive'
    );
  });

  it('reports init Claude launcher dry-run offer, force, and skip without writing launcher files', () => {
    const offerWrites: string[] = [];
    const offerFileSystem = createLauncherFileSystem({
      executableFiles: ['/opt/claude/bin/claude']
    });
    const offerExitCode = runCli(
      ['init', '--dry-run', '--scope', 'local'],
      {
        stdout: {
          write(text: string) {
            offerWrites.push(text);
          }
        },
        stderr: { write() {} }
      },
      createSuccessfulInitEnvironment({
        launcherFileSystem: offerFileSystem,
        pathEnv: '/opt/claude/bin'
      })
    );

    expect(offerExitCode).toBe(0);
    expect(offerFileSystem.files.size).toBe(0);
    expect(offerWrites.join('')).toContain(
      'Claude launcher: would be offered after setup in an interactive init'
    );

    const forcedWrites: string[] = [];
    const forcedFileSystem = createLauncherFileSystem({
      executableFiles: ['/opt/claude/bin/claude']
    });
    const forcedExitCode = runCli(
      [
        'init',
        '--dry-run',
        '--scope',
        'local',
        '--install-claude-launcher'
      ],
      {
        stdout: {
          write(text: string) {
            forcedWrites.push(text);
          }
        },
        stderr: { write() {} }
      },
      createSuccessfulInitEnvironment({
        launcherFileSystem: forcedFileSystem,
        pathEnv: '/opt/claude/bin'
      })
    );

    expect(forcedExitCode).toBe(0);
    expect(forcedFileSystem.files.size).toBe(0);
    expect(forcedWrites.join('')).toContain(
      'Claude launcher: forced by --install-claude-launcher'
    );

    const skippedWrites: string[] = [];
    const skippedExitCode = runCli(
      [
        'init',
        '--dry-run',
        '--scope',
        'local',
        '--skip-claude-launcher'
      ],
      {
        stdout: {
          write(text: string) {
            skippedWrites.push(text);
          }
        },
        stderr: { write() {} }
      },
      createSuccessfulInitEnvironment({
        launcherFileSystem: createLauncherFileSystem(),
        pathEnv: '/opt/claude/bin'
      })
    );

    expect(skippedExitCode).toBe(0);
    expect(skippedWrites.join('')).toContain(
      'Claude launcher: skipped by --skip-claude-launcher'
    );
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
    const launcherFileSystem = createInstalledLauncherFileSystem();
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
        claudeLauncherFileSystem: launcherFileSystem,
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
    expect(launcherFileSystem.files.has('/tmp/home/.teamem/bin/claude')).toBe(
      false
    );
    expect(
      launcherFileSystem.files.has('/tmp/home/.teamem/launcher/claude.json')
    ).toBe(false);
    expect(writes.join('')).toContain('Selected plugin scope: user (memory)');
    expect(writes.join('')).toContain(
      'Teamem plugin, git hooks, launcher files, and local state were uninstalled.'
    );
  });

  it('first-class uninstall preserves foreign launcher shim files and removes partial state', () => {
    const writes: string[] = [];
    const launcherFileSystem = createLauncherFileSystem({
      files: {
        '/tmp/home/.teamem/bin/claude': '# user-owned claude shim\n',
        '/tmp/home/.teamem/launcher/claude.json':
          '{"version":1,"realClaudePath":"/opt/claude/bin/claude","shimPath":"/tmp/home/.teamem/bin/claude","installedAt":"2026-05-25T00:00:00.000Z"}\n'
      },
      executableFiles: ['/tmp/home/.teamem/bin/claude']
    });
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
        localStateFileSystem: createLocalStateFileSystemStub(),
        claudeLauncherFileSystem: launcherFileSystem,
        gitHookInstaller: createGitHookInstallerStub()
      }
    );

    expect(exitCode).toBe(0);
    expect(launcherFileSystem.files.get('/tmp/home/.teamem/bin/claude')).toBe(
      '# user-owned claude shim\n'
    );
    expect(
      launcherFileSystem.files.has('/tmp/home/.teamem/launcher/claude.json')
    ).toBe(false);
    expect(writes.join('')).toContain(
      'Preserved non-Teamem path: /tmp/home/.teamem/bin/claude'
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
    const result = spawnSync(
      'bun',
      ['run', BIN_PATH, 'claude', 'status', '--dry-run'],
      {
        cwd: PACKAGE_ROOT,
        encoding: 'utf8'
      }
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('teamem claude status');
    expect(result.stdout).toContain('Teamem-aware Claude launcher');
  });

  it('prints the cc compatibility error from the package bin entry', () => {
    const result = spawnSync('bun', ['run', BIN_PATH, 'cc', '--dry-run'], {
      cwd: PACKAGE_ROOT,
      encoding: 'utf8'
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('teamem claude install');
    expect(result.stderr).toContain('preserves a pure Claude Code path');
    expect(result.stderr).toContain(
      'then start Claude Code with normal `claude`'
    );
    expect(result.stdout).toBe('');
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

function createReadyLaunchCommandRunner(
  options: { readonly pluginList?: string; readonly repoRoot?: string } = {}
): CommandRunner {
  return createFakeRunner({
    '/opt/claude/bin/claude --version': ok('1.0.0'),
    'bun --version': ok('1.2.0'),
    'git --version': ok('git version 2.0.0'),
    'git rev-parse --is-inside-work-tree': ok('true\n'),
    'git rev-parse --show-toplevel': ok(
      `${options.repoRoot ?? '/tmp/project'}\n`
    ),
    '/opt/claude/bin/claude plugin list --json': ok(
      options.pluginList ??
        '{"plugins":[{"id":"teamem@teamem-alpha","scope":"user","installPath":"/plugins/teamem"}]}'
    )
  });
}

function createCredentialsJson(
  options: { readonly jwtExp?: number } = {}
): string {
  return `${JSON.stringify(
    {
      version: 1,
      default_space_id: 'space-1',
      spaces: {
        'space-1': {
          space_id: 'space-1',
          label: 'Alpha',
          member_name: 'alice',
          jwt: 'token',
          jwt_exp: options.jwtExp ?? 1_900_000_000,
          server_url: 'https://teamem.example'
        }
      }
    },
    null,
    2
  )}\n`;
}

function runTeamemReadinessFailure(
  options: {
    readonly launcherFileSystem?: ClaudeLauncherFileSystem & {
      readonly files: Map<string, string>;
      readonly executableFiles: Set<string>;
    };
    readonly commandRunner?: CommandRunner;
    readonly env?: NodeJS.ProcessEnv;
  } = {}
): {
  readonly exitCode: number;
  readonly stderr: string;
  readonly invocations: Array<{
    readonly command: string;
    readonly args: readonly string[];
    readonly env: NodeJS.ProcessEnv;
  }>;
} {
  const runner = createClaudeLaunchRecorder();
  const stderr: string[] = [];
  const exitCode = runCli(
    ['claude', 'launch', '--teamem'],
    {
      stdout: { write() {} },
      stderr: {
        write(text: string) {
          stderr.push(text);
        }
      }
    },
    createLauncherCliEnvironment({
      launcherFileSystem:
        options.launcherFileSystem ?? createInstalledLauncherFileSystem(),
      commandRunner: options.commandRunner,
      pathEnv: '/tmp/home/.teamem/bin:/opt/claude/bin',
      homeDir: '/tmp/home',
      claudeLaunchProcessRunner: runner,
      env: options.env ?? {
        PATH: '/tmp/home/.teamem/bin:/opt/claude/bin',
        TEAMEM_CLAUDE_LAUNCHER_STATE: '/tmp/home/.teamem/launcher/claude.json'
      }
    })
  );
  return {
    exitCode,
    stderr: stderr.join(''),
    invocations: runner.invocations
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

function createLauncherCliEnvironment(options: {
  readonly launcherFileSystem?: ClaudeLauncherFileSystem;
  readonly commandRunner?: CommandRunner;
  readonly claudeLaunchProcessRunner?: ClaudeLaunchProcessRunner;
  readonly promptEnvironment?: {
    readonly isInteractive?: () => boolean;
    readonly prompt?: (message: string) => string | null;
  };
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly pathEnv: string;
  readonly homeDir: string;
}) {
  const commandRunner =
    options.commandRunner ?? createReadyLaunchCommandRunner();
  const cwd = options.cwd ?? '/tmp/project';
  return {
    prerequisites: {
      platform: 'linux' as const,
      cwd,
      commandRunner
    },
    installer: {
      cwd,
      commandRunner,
      fileSystem: createMemoryFileSystem()
    },
    ...(options.launcherFileSystem
      ? { claudeLauncherFileSystem: options.launcherFileSystem }
      : {}),
    ...(options.claudeLaunchProcessRunner
      ? { claudeLaunchProcessRunner: options.claudeLaunchProcessRunner }
      : {}),
    ...(options.promptEnvironment
      ? { promptEnvironment: options.promptEnvironment }
      : {}),
    ...(options.env ? { env: options.env } : {}),
    pathEnv: options.pathEnv,
    homeDir: options.homeDir,
    now: () => new Date('2026-05-25T00:00:00.000Z')
  };
}

function createSuccessfulInitEnvironment(options: {
  readonly setupRunner?: SetupCommandRunner;
  readonly launcherFileSystem?: ClaudeLauncherFileSystem;
  readonly pathEnv?: string;
}) {
  const commandRunner = createFakeRunner({
    'claude --version': ok('1.0.0'),
    'bun --version': ok('1.2.0'),
    'git --version': ok('git version 2.47.0'),
    'git rev-parse --is-inside-work-tree': ok('true'),
    'claude plugin list --json': ok('[]'),
    'claude plugin marketplace list --json': ok('[]'),
    'claude plugin marketplace add https://github.com/RubiYH/teamem':
      ok('added'),
    'claude plugin install teamem@teamem-alpha --scope local': ok('installed')
  });
  return {
    prerequisites: {
      platform: 'linux' as const,
      cwd: '/tmp/project',
      commandRunner
    },
    installer: {
      cwd: '/tmp/project',
      commandRunner,
      fileSystem: createMemoryFileSystem()
    },
    setupRunner: options.setupRunner ?? createSetupRunnerStub(),
    ...(options.launcherFileSystem
      ? { claudeLauncherFileSystem: options.launcherFileSystem }
      : {}),
    pathEnv: options.pathEnv,
    homeDir: '/tmp/home',
    now: () => new Date('2026-05-25T00:00:00.000Z')
  };
}

function runLauncherStatus(options: {
  readonly pathEnv: string;
  readonly executableFiles: readonly string[];
}): {
  readonly exitCode: number;
  readonly output: string;
  readonly writes: string[];
} {
  const writes: string[] = [];
  const launcherFileSystem = createLauncherFileSystem({
    executableFiles: options.executableFiles,
    files: {
      '/tmp/home/.teamem/bin/claude': '# teamem-owned-claude-shim\n',
      '/tmp/home/.teamem/launcher/claude.json':
        '{"version":1,"realClaudePath":"/opt/claude/bin/claude","shimPath":"/tmp/home/.teamem/bin/claude","installedAt":"2026-05-25T00:00:00.000Z"}\n'
    }
  });
  const exitCode = runCli(
    ['claude', 'status'],
    {
      stdout: {
        write(text: string) {
          writes.push(text);
        }
      },
      stderr: { write() {} }
    },
    createLauncherCliEnvironment({
      launcherFileSystem,
      pathEnv: options.pathEnv,
      homeDir: '/tmp/home'
    })
  );
  return {
    exitCode,
    output: writes.join(''),
    writes
  };
}

function createInstalledLauncherFileSystem(options?: {
  readonly credentials?: string;
}): ClaudeLauncherFileSystem & {
  readonly files: Map<string, string>;
  readonly executableFiles: Set<string>;
} {
  return createLauncherFileSystem({
    executableFiles: ['/tmp/home/.teamem/bin/claude', '/opt/claude/bin/claude'],
    files: {
      '/tmp/home/.teamem/bin/claude': '# teamem-owned-claude-shim\n',
      '/tmp/home/.teamem/launcher/claude.json':
        '{"version":1,"realClaudePath":"/opt/claude/bin/claude","shimPath":"/tmp/home/.teamem/bin/claude","installedAt":"2026-05-25T00:00:00.000Z"}\n',
      '/tmp/home/.teamem/credentials.json':
        options?.credentials ?? createCredentialsJson(),
      '/plugins/teamem/.claude-plugin/plugin.json': JSON.stringify({
        name: 'teamem',
        version: '0.3.20',
        commands: [
          './commands/teamem-setup.md',
          './commands/teamem-on.md',
          './commands/teamem-off.md',
          './commands/teamem-status.md',
          './commands/teamem-briefing.md'
        ],
        skills: './skills/',
        mcpServers: './.mcp.json'
      }),
      '/plugins/teamem/commands/teamem-setup.md':
        '---\ndescription: Setup Teamem\n---\n',
      '/plugins/teamem/commands/teamem-on.md':
        '---\ndescription: Activate Teamem\n---\n',
      '/plugins/teamem/commands/teamem-off.md':
        '---\ndescription: Deactivate Teamem\n---\n',
      '/plugins/teamem/commands/teamem-status.md':
        '---\ndescription: Check Teamem status\n---\n',
      '/plugins/teamem/commands/teamem-briefing.md':
        '---\ndescription: Fetch Teamem briefing\n---\n'
    }
  });
}

function runInstalledShim(
  shimScript: string,
  args: readonly string[]
): readonly string[] {
  const tempDir = mkdtempSync(join(tmpdir(), 'teamem-shim-'));
  try {
    const binDir = join(tempDir, 'bin');
    const shimPath = join(tempDir, 'claude');
    const teamemPath = join(binDir, 'teamem');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(shimPath, shimScript, 'utf8');
    chmodSync(shimPath, 0o755);
    writeFileSync(
      teamemPath,
      '#!/usr/bin/env bun\nconsole.log(JSON.stringify(process.argv.slice(2)));\n',
      'utf8'
    );
    chmodSync(teamemPath, 0o755);

    const result = spawnSync(shimPath, [...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`
      }
    });
    if (result.status !== 0) {
      throw new Error(result.stderr);
    }
    return JSON.parse(result.stdout.trim()) as string[];
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function createClaudeLaunchRecorder(): ClaudeLaunchProcessRunner & {
  readonly invocations: Array<{
    readonly command: string;
    readonly args: readonly string[];
    readonly env: NodeJS.ProcessEnv;
  }>;
} {
  const invocations: Array<{
    readonly command: string;
    readonly args: readonly string[];
    readonly env: NodeJS.ProcessEnv;
  }> = [];
  return {
    invocations,
    run(command: string, args: readonly string[], env: NodeJS.ProcessEnv) {
      invocations.push({ command, args: [...args], env: { ...env } });
      return 0;
    }
  };
}

function createLauncherFileSystem(
  options: {
    readonly files?: Record<string, string>;
    readonly executableFiles?: readonly string[];
  } = {}
): ClaudeLauncherFileSystem & {
  readonly files: Map<string, string>;
  readonly executableFiles: Set<string>;
} {
  const files = new Map(Object.entries(options.files ?? {}));
  const executableFiles = new Set(options.executableFiles ?? []);
  return {
    files,
    executableFiles,
    exists(path: string): boolean {
      return files.has(path) || executableFiles.has(path);
    },
    readFile(path: string): string {
      const value = files.get(path);
      if (value === undefined) {
        throw new Error(`Missing file: ${path}`);
      }
      return value;
    },
    isReadableFile(path: string): boolean {
      return files.has(path);
    },
    writeFile(path: string, content: string): void {
      files.set(path, content);
    },
    mkdir(): void {},
    rm(path: string): void {
      files.delete(path);
      executableFiles.delete(path);
    },
    isExecutableFile(path: string): boolean {
      return executableFiles.has(path);
    },
    chmodExecutable(path: string): void {
      executableFiles.add(path);
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
