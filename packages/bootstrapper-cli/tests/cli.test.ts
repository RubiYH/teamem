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
import {
  TEAMEM_STATUSLINE_COMMAND,
  renderClaudeStatusline,
  renderFallbackStatusline
} from '../src/claude-statusline.js';
import {
  TEAMEM_STATUSLINE_CACHE_RELATIVE_PATH,
  readStatuslineDisplayCache
} from '../src/statusline-display-cache.js';
import type { CliEnvironment } from '../src/cli.js';
import type {
  GitHookInstaller,
  GitHookInstallResult,
  GitHookPrompter
} from '../src/git-hooks.js';
import type {
  CommandProbeResult,
  CommandRunner
} from '../src/prerequisites.js';
import type { DevProfileFileSystem } from '../src/dev-profiles.js';
import type { DevSourceFileSystem } from '../src/dev-source.js';
import type { BootstrapperFileSystem } from '../src/plugin-installer.js';
import type {
  ScopePrompter,
  ClaudeLaunchProcessRunner,
  DevClaudeProcessRunner,
  ClaudeLauncherFileSystem,
  LocalStateFileSystem,
  SetupCommandRunner,
  SetupInvocation,
  DevSetupRunner,
  DevBundleFreshnessChecker,
  DevBundleFreshnessReport,
  DevCredentialsReader,
  DevPluginBuilder,
  DevServerHealthChecker,
  DevProfileActiveSessionDetector
} from '../src/index.js';

const PACKAGE_ROOT = resolve(import.meta.dir, '..');
const BIN_PATH = join(PACKAGE_ROOT, 'src/bin/teamem.ts');
const ANSI_RESET = '\x1b[0m';
const ANSI_TEAMEM_BROWN = '\x1b[38;2;139;94;52m';
const ANSI_SPACE_CYAN = '\x1b[38;2;34;211;238m';
const ANSI_DIM_GRAY = '\x1b[2;38;2;156;163;175m';
const ANSI_CONTEXT_GREEN = '\x1b[38;2;34;197;94m';
const ANSI_CONTEXT_YELLOW = '\x1b[38;2;234;179;8m';
const ANSI_CONTEXT_RED = '\x1b[38;2;239;68;68m';
const statuslineSeparator = ` ${ANSI_DIM_GRAY}|${ANSI_RESET} `;
const colorStatusline = (value: string, color: string): string =>
  `${color}${value}${ANSI_RESET}`;

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

  it('parses project Claude statusline lifecycle commands', () => {
    expect(parseCliArgs(['claude', 'statusline', 'install'])).toEqual({
      ok: true,
      value: {
        command: 'claude',
        dryRun: false,
        help: false,
        scope: undefined,
        cc: undefined,
        claude: {
          lifecycleCommand: 'statusline',
          statuslineCommand: 'install'
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
    expect(parseCliArgs(['claude', 'statusline', 'status'])).toEqual({
      ok: true,
      value: {
        command: 'claude',
        dryRun: false,
        help: false,
        scope: undefined,
        cc: undefined,
        claude: {
          lifecycleCommand: 'statusline',
          statuslineCommand: 'status'
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
    expect(parseCliArgs(['claude', 'statusline', 'uninstall'])).toEqual({
      ok: true,
      value: {
        command: 'claude',
        dryRun: false,
        help: false,
        scope: undefined,
        cc: undefined,
        claude: {
          lifecycleCommand: 'statusline',
          statuslineCommand: 'uninstall'
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
      parseCliArgs(['claude', 'statusline', 'install', '--scope', 'user'])
    ).toEqual({
      ok: true,
      value: {
        command: 'claude',
        dryRun: false,
        help: false,
        scope: 'user',
        cc: undefined,
        claude: {
          lifecycleCommand: 'statusline',
          statuslineCommand: 'install'
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
      parseCliArgs(['claude', 'statusline', 'install', '--force'])
    ).toEqual({
      ok: false,
      error: 'Unknown option for claude statusline install: --force'
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
    expect(
      parseCliArgs([
        'dev',
        'claude',
        '--profile',
        'alice',
        '--install-git-hooks',
        '--skip-git-hooks'
      ])
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
    expect(parseCliArgs(['init', '--install-claude-statusline'])).toMatchObject(
      {
        ok: true,
        value: {
          command: 'init',
          claudeStatusline: 'install'
        }
      }
    );
    expect(parseCliArgs(['init', '--skip-claude-statusline'])).toMatchObject({
      ok: true,
      value: {
        command: 'init',
        claudeStatusline: 'skip'
      }
    });
    expect(
      parseCliArgs([
        'init',
        '--install-claude-statusline',
        '--skip-claude-statusline'
      ])
    ).toEqual({
      ok: false,
      error:
        'Choose only one Claude statusline mode: --install-claude-statusline or --skip-claude-statusline'
    });
  });

  it('parses Teamem dev command namespace and profile flags', () => {
    expect(parseCliArgs(['dev', 'claude', '--profile', 'alice'])).toEqual({
      ok: true,
      value: {
        command: 'dev',
        dryRun: false,
        help: false,
        scope: undefined,
        gitHooks: undefined,
        claudeLauncher: undefined,
        cc: undefined,
        claude: undefined,
        dev: {
          subcommand: 'claude',
          profile: 'alice',
          teamemRoot: undefined,
          cwd: undefined,
          buildPlugin: false,
          claudeArgs: []
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
    expect(parseCliArgs(['dev', 'status'])).toMatchObject({
      ok: true,
      value: {
        command: 'dev',
        dev: {
          subcommand: 'status',
          profile: undefined
        }
      }
    });
    expect(parseCliArgs(['dev', 'delete', '--profile', 'bob_2'])).toMatchObject(
      {
        ok: true,
        value: {
          command: 'dev',
          dev: {
            subcommand: 'delete',
            profile: 'bob_2'
          }
        }
      }
    );
    expect(
      parseCliArgs(['dev', 'delete', '--profile', 'bob_2', '--yes', '--force'])
    ).toMatchObject({
      ok: true,
      value: {
        dev: {
          subcommand: 'delete',
          profile: 'bob_2',
          yes: true,
          force: true
        }
      }
    });
    expect(
      parseCliArgs([
        'dev',
        'claude',
        '--profile',
        'alice',
        '--build-plugin',
        '--',
        '--model',
        'opus',
        '--name',
        'kept'
      ])
    ).toMatchObject({
      ok: true,
      value: {
        dev: {
          subcommand: 'claude',
          profile: 'alice',
          buildPlugin: true,
          claudeArgs: ['--model', 'opus', '--name', 'kept']
        }
      }
    });
  });

  it('parses Teamem dev source root and launch cwd flags', () => {
    expect(
      parseCliArgs([
        'dev',
        'claude',
        '--profile',
        'alice',
        '--teamem-root',
        '/src/teamem',
        '--cwd',
        '/work/project'
      ])
    ).toMatchObject({
      ok: true,
      value: {
        command: 'dev',
        dev: {
          subcommand: 'claude',
          profile: 'alice',
          teamemRoot: '/src/teamem',
          cwd: '/work/project'
        }
      }
    });
  });

  it('rejects invalid Teamem dev profile names during parsing', () => {
    expect(parseCliArgs(['dev', 'claude'])).toMatchObject({
      ok: true,
      value: {
        command: 'dev',
        dev: {
          subcommand: 'claude',
          profile: undefined,
          teamemRoot: undefined,
          cwd: undefined,
          buildPlugin: false
        }
      }
    });
    expect(parseCliArgs(['dev', 'claude', '--profile', '../alice'])).toEqual({
      ok: false,
      error:
        'Invalid value for --profile. Use a lowercase slug with letters, numbers, hyphens, or underscores, up to 64 characters.'
    });
    expect(parseCliArgs(['dev', 'repair'])).toEqual({
      ok: false,
      error:
        'Unknown teamem dev subcommand: repair. Expected one of: claude, status, delete'
    });
    expect(parseCliArgs(['dev', 'reset'])).toEqual({
      ok: false,
      error:
        'Unknown teamem dev subcommand: reset. Expected one of: claude, status, delete'
    });
    expect(parseCliArgs(['dev', 'claude', '--yes'])).toEqual({
      ok: false,
      error: 'Unknown option for dev claude: --yes'
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
    expect(help).toContain('claude statusline install');
    expect(help).toContain('claude statusline status');
    expect(help).toContain('claude statusline uninstall');
    expect(help).toContain('Teamem-aware Claude launcher');
    expect(help).toContain('opt-in `claude` shim');
    expect(help).toContain('Teamem Claude statusline');
  });

  it('lists dev profiles when status has no profile', () => {
    const writes: string[] = [];
    const exitCode = runCli(
      ['dev', 'status'],
      {
        stdout: {
          write(text: string) {
            writes.push(text);
          }
        },
        stderr: { write() {} }
      },
      createDevCliEnvironment({
        devProfileFileSystem: createDevProfileFileSystem({
          directories: [
            '/tmp/home/.teamem/dev-profiles/alice',
            '/tmp/home/.teamem/dev-profiles/bob_2'
          ]
        }),
        homeDir: '/tmp/home'
      })
    );

    expect(exitCode).toBe(0);
    expect(writes.join('')).toContain('Teamem dev profiles');
    expect(writes.join('')).toContain('alice');
    expect(writes.join('')).toContain('bob_2');
  });

  it('reports profile-owned paths for status with a profile', () => {
    const writes: string[] = [];
    const fileSystem = createDevProfileFileSystem({
      directories: ['/tmp/home/.teamem/dev-profiles/alice'],
      files: [
        '/tmp/home/.teamem/dev-profiles/alice/credentials.json',
        '/tmp/home/.teamem/dev-profiles/alice/mcp.json'
      ]
    });
    const exitCode = runCli(
      ['dev', 'status', '--profile', 'alice'],
      {
        stdout: {
          write(text: string) {
            writes.push(text);
          }
        },
        stderr: { write() {} }
      },
      createDevCliEnvironment({
        devProfileFileSystem: fileSystem,
        homeDir: '/tmp/home'
      })
    );

    expect(exitCode).toBe(0);
    expect(writes.join('')).toContain('Profile: alice');
    expect(writes.join('')).toContain(
      'Profile path: /tmp/home/.teamem/dev-profiles/alice'
    );
    expect(writes.join('')).toContain(
      'Claude config root: /tmp/home/.teamem/dev-profiles/alice/claude'
    );
    expect(writes.join('')).toContain(
      'Plugin cache root: /tmp/home/.teamem/dev-profiles/alice/claude/plugins'
    );
    expect(writes.join('')).toContain(
      'Plugin data root: /tmp/home/.teamem/dev-profiles/alice/plugin-data/teamem'
    );
    expect(writes.join('')).toContain(
      'Teamem credentials path: /tmp/home/.teamem/dev-profiles/alice/credentials.json'
    );
    expect(writes.join('')).toContain(
      'Generated MCP config: /tmp/home/.teamem/dev-profiles/alice/mcp.json'
    );
    expect(writes.join('')).toContain('Generated MCP config status: present');
    expect(writes.join('')).toContain(
      'MCP isolation mode: strict profile MCP config (--strict-mcp-config)'
    );
    expect(writes.join('')).toContain('Channel source: server:teamem-channel');
    expect(writes.join('')).toContain('Marketplace plugin ignored: yes');
    expect(writes.join('')).toContain('Source checkout: /src/teamem');
    expect(writes.join('')).toContain('Launch cwd: /src/teamem');
    expect(writes.join('')).toContain(
      'Logs: /tmp/home/.teamem/dev-profiles/alice/logs'
    );
  });

  it('fails status for a missing requested profile without creating state', () => {
    const stderr: string[] = [];
    const fileSystem = createDevProfileFileSystem({
      directories: ['/tmp/home/.teamem/dev-profiles/alice']
    });
    const exitCode = runCli(
      ['dev', 'status', '--profile', 'missing'],
      {
        stdout: { write() {} },
        stderr: {
          write(text: string) {
            stderr.push(text);
          }
        }
      },
      createDevCliEnvironment({
        devProfileFileSystem: fileSystem,
        homeDir: '/tmp/home'
      })
    );

    expect(exitCode).toBe(1);
    expect(fileSystem.mkdirCalls).toEqual([]);
    expect(fileSystem.writeFileCalls).toEqual([]);
    expect(fileSystem.directories).not.toContain(
      '/tmp/home/.teamem/dev-profiles/missing'
    );
    expect(stderr.join('')).toContain('Dev profile does not exist: missing');
    expect(stderr.join('')).toContain(
      'Create the profile with `teamem dev claude --profile missing`'
    );
  });

  it('reports profile status preflight summaries when source checkout resolves', () => {
    const writes: string[] = [];
    const dirtyStatus = ' M src/bridge/index.ts\n?? scratch.txt\n';
    const bundleChecker = createDevBundleFreshnessCheckerStub();
    const healthChecker = createDevServerHealthCheckerStub(true);
    const fileSystem = createDevProfileFileSystem({
      directories: ['/tmp/home/.teamem/dev-profiles/alice'],
      files: [
        '/tmp/home/.teamem/dev-profiles/alice/credentials.json',
        '/tmp/home/.teamem/dev-profiles/alice/mcp.json'
      ]
    });
    const exitCode = runCli(
      ['dev', 'status', '--profile', 'alice'],
      {
        stdout: {
          write(text: string) {
            writes.push(text);
          }
        },
        stderr: { write() {} }
      },
      createDevCliEnvironment({
        commandRunner: createDevSourceCommandRunner({
          sourceRoot: '/src/teamem',
          dirtyStatus
        }),
        devProfileFileSystem: fileSystem,
        devBundleFreshnessChecker: bundleChecker,
        devServerHealthChecker: healthChecker,
        homeDir: '/tmp/home'
      })
    );

    expect(exitCode).toBe(0);
    expect(writes.join('')).toContain('Profile: alice');
    expect(writes.join('')).toContain('Source checkout: /src/teamem');
    expect(writes.join('')).toContain('Source checkout has 2 dirty path(s)');
    expect(writes.join('')).toContain('Plugin bundle freshness');
    expect(writes.join('')).toContain(
      'Server health: reachable (https://teamem.example/health)'
    );
    expect(bundleChecker.checks).toEqual(['/src/teamem']);
    expect(healthChecker.checkedUrls).toEqual([
      'https://teamem.example/health'
    ]);
  });

  it('keeps dev status read-only for existing profiles', () => {
    const fileSystem = createDevProfileFileSystem({
      directories: ['/tmp/home/.teamem/dev-profiles/alice'],
      files: [
        '/tmp/home/.teamem/dev-profiles/alice/credentials.json',
        '/tmp/home/.teamem/dev-profiles/alice/mcp.json'
      ]
    });
    const setupRunner = createDevSetupRunnerStub();
    const launcher = createDevClaudeLaunchRecorder();

    const exitCode = runCli(
      ['dev', 'status', '--profile', 'alice'],
      { stdout: { write() {} }, stderr: { write() {} } },
      createDevCliEnvironment({
        devProfileFileSystem: fileSystem,
        devSetupRunner: setupRunner,
        devClaudeProcessRunner: launcher,
        homeDir: '/tmp/home'
      })
    );

    expect(exitCode).toBe(0);
    expect(fileSystem.mkdirCalls).toEqual([]);
    expect(fileSystem.writeFileCalls).toEqual([]);
    expect(setupRunner.invocations).toEqual([]);
    expect(launcher.invocations).toEqual([]);
  });

  it('reports partial dev profile status without mutating state', () => {
    const writes: string[] = [];
    const fileSystem = createDevProfileFileSystem({
      directories: ['/tmp/home/.teamem/dev-profiles/alice']
    });
    const bundleChecker = createDevBundleFreshnessCheckerStub();
    const healthChecker = createDevServerHealthCheckerStub(true);

    const exitCode = runCli(
      [
        'dev',
        'status',
        '--profile',
        'alice',
        '--teamem-root',
        '/missing/teamem'
      ],
      {
        stdout: {
          write(text: string) {
            writes.push(text);
          }
        },
        stderr: { write() {} }
      },
      createDevCliEnvironment({
        devProfileFileSystem: fileSystem,
        devSourceFileSystem: createDevSourceFileSystem({
          roots: [],
          executableFiles: ['/opt/claude/bin/claude']
        }),
        devCredentialsReader: createDevCredentialsReaderStub(null),
        devBundleFreshnessChecker: bundleChecker,
        devServerHealthChecker: healthChecker,
        homeDir: '/tmp/home'
      })
    );

    expect(exitCode).toBe(0);
    expect(fileSystem.mkdirCalls).toEqual([]);
    expect(fileSystem.writeFileCalls).toEqual([]);
    expect(bundleChecker.checks).toEqual([]);
    expect(healthChecker.checkedUrls).toEqual([]);
    expect(writes.join('')).toContain(
      'Teamem credentials status: missing or unusable'
    );
    expect(writes.join('')).toContain('Generated MCP config status: missing');
    expect(writes.join('')).toContain('Source checkout: missing');
    expect(writes.join('')).toContain(
      'Explicit --teamem-root is not a Teamem source checkout'
    );
    expect(writes.join('')).toContain(
      'Server health: not checked (Profile credentials are missing'
    );
  });

  it('requires --profile for non-interactive dev claude', () => {
    const stderr: string[] = [];
    const exitCode = runCli(
      ['dev', 'claude'],
      {
        stdout: { write() {} },
        stderr: {
          write(text: string) {
            stderr.push(text);
          }
        }
      },
      createDevCliEnvironment({
        homeDir: '/tmp/home',
        promptEnvironment: {
          isInteractive: () => false,
          prompt: () => {
            throw new Error('should not prompt');
          }
        }
      })
    );

    expect(exitCode).toBe(1);
    expect(stderr.join('')).toContain(
      'Non-interactive `teamem dev claude` requires --profile.'
    );
  });

  it('reports missing source checkout before non-interactive dev claude profile requirements', () => {
    const writes: string[] = [];
    const stderr: string[] = [];
    const fileSystem = createDevProfileFileSystem();
    const exitCode = runCli(
      ['dev', 'claude', '--dry-run'],
      {
        stdout: {
          write(text: string) {
            writes.push(text);
          }
        },
        stderr: {
          write(text: string) {
            stderr.push(text);
          }
        }
      },
      createDevCliEnvironment({
        cwd: '/work/consumer',
        devSourceFileSystem: createDevSourceFileSystem({
          roots: [],
          executableFiles: ['/opt/claude/bin/claude']
        }),
        devProfileFileSystem: fileSystem,
        homeDir: '/tmp/home',
        promptEnvironment: {
          isInteractive: () => false
        }
      })
    );

    expect(exitCode).toBe(1);
    expect(fileSystem.mkdirCalls).toEqual([]);
    expect(writes.join('')).toContain('source-checkout-required');
    expect(writes.join('')).toContain('No Teamem source checkout');
    expect(stderr.join('')).not.toContain('requires --profile');
  });

  it('creates a named dev profile skeleton for non-interactive dev claude', () => {
    const writes: string[] = [];
    const fileSystem = createDevProfileFileSystem();
    const devSetupRunner = createDevSetupRunnerStub();
    const gitHookInstaller = createGitHookInstallerStub();
    const gitHookPrompter: GitHookPrompter = () => true;
    const exitCode = runCli(
      ['dev', 'claude', '--profile', 'alice', '--teamem-root', '/src/teamem'],
      {
        stdout: {
          write(text: string) {
            writes.push(text);
          }
        },
        stderr: { write() {} }
      },
      createDevCliEnvironment({
        devProfileFileSystem: fileSystem,
        devSetupRunner,
        gitHookInstaller,
        gitHookPrompter,
        cwd: '/work/project',
        homeDir: '/tmp/home',
        now: () => new Date('2026-05-29T00:00:00.000Z'),
        promptEnvironment: {
          isInteractive: () => false
        }
      })
    );

    expect(exitCode).toBe(0);
    expect(devSetupRunner.invocations).toHaveLength(1);
    expect(devSetupRunner.invocations[0]?.profile.credentialsPath).toBe(
      '/tmp/home/.teamem/dev-profiles/alice/credentials.json'
    );
    expect(fileSystem.directories).toContain(
      '/tmp/home/.teamem/dev-profiles/alice'
    );
    const generatedMcp = fileSystem.files.get(
      '/tmp/home/.teamem/dev-profiles/alice/mcp.json'
    );
    expect(generatedMcp).toContain('/src/teamem/plugin/lib/bridge.js');
    expect(generatedMcp).toContain('/src/teamem/plugin/lib/channel.js');
    expect(generatedMcp).toContain(
      '"TEAMEM_CREDENTIALS": "/tmp/home/.teamem/dev-profiles/alice/credentials.json"'
    );
    expect(generatedMcp).toContain(
      '"CLAUDE_PLUGIN_DATA": "/tmp/home/.teamem/dev-profiles/alice/plugin-data/teamem"'
    );
    expect(generatedMcp).toContain(
      '"CLAUDE_PLUGIN_ROOT": "/src/teamem/plugin"'
    );
    expect(generatedMcp).not.toContain('${CLAUDE_PLUGIN_ROOT}');
    expect(generatedMcp).not.toContain('/cache/teamem');
    expect(gitHookInstaller.invocations).toEqual([
      { scope: 'local', pluginRoot: '/src/teamem/plugin' }
    ]);
    expect(writes.join('')).toContain('Profile skeleton created.');
    expect(writes.join('')).toContain('Profile-scoped Teamem setup completed.');
    expect(writes.join('')).toContain(
      'Generated profile MCP config: /tmp/home/.teamem/dev-profiles/alice/mcp.json'
    );
    expect(writes.join('')).toContain('Installed Teamem git hooks');
    expect(writes.join('')).toContain('Source checkout: /src/teamem');
  });

  it('forces git hook install after first-launch dev claude setup', () => {
    const gitHookInstaller = createGitHookInstallerStub();
    const gitHookPrompter: GitHookPrompter = () => false;
    const exitCode = runCli(
      [
        'dev',
        'claude',
        '--profile',
        'alice',
        '--teamem-root',
        '/src/teamem',
        '--install-git-hooks'
      ],
      {
        stdout: { write() {} },
        stderr: { write() {} }
      },
      createDevCliEnvironment({
        gitHookInstaller,
        gitHookPrompter,
        cwd: '/work/project',
        homeDir: '/tmp/home',
        promptEnvironment: {
          isInteractive: () => false
        }
      })
    );

    expect(exitCode).toBe(0);
    expect(gitHookInstaller.invocations).toEqual([
      { scope: 'local', pluginRoot: '/src/teamem/plugin' }
    ]);
  });

  it('forces git hook skip after first-launch dev claude setup', () => {
    const writes: string[] = [];
    const gitHookInstaller = createGitHookInstallerStub();
    const gitHookPrompter: GitHookPrompter = () => true;
    const exitCode = runCli(
      ['dev', 'claude', '--profile', 'alice', '--skip-git-hooks'],
      {
        stdout: {
          write(text: string) {
            writes.push(text);
          }
        },
        stderr: { write() {} }
      },
      createDevCliEnvironment({
        gitHookInstaller,
        gitHookPrompter,
        homeDir: '/tmp/home',
        promptEnvironment: {
          isInteractive: () => false
        }
      })
    );

    expect(exitCode).toBe(0);
    expect(gitHookInstaller.invocations).toEqual([]);
    expect(writes.join('')).toContain('Git hooks skipped by --skip-git-hooks.');
  });

  it('runs first-launch dev claude git hook setup before server health can fail', () => {
    const events: string[] = [];
    const gitHookInstaller = createGitHookInstallerStub();
    const healthChecker = createDevServerHealthCheckerStub(false);
    const devSetupRunner = createDevSetupRunnerStub();
    const exitCode = runCli(
      ['dev', 'claude', '--profile', 'alice'],
      {
        stdout: { write() {} },
        stderr: { write() {} }
      },
      createDevCliEnvironment({
        devSetupRunner: {
          run(invocation) {
            events.push('setup');
            return devSetupRunner.run(invocation);
          }
        },
        gitHookInstaller: {
          install(invocation) {
            events.push('git-hooks');
            return gitHookInstaller.install(invocation);
          },
          uninstall() {
            return gitHookInstaller.uninstall();
          }
        },
        gitHookPrompter() {
          events.push('prompt');
          return true;
        },
        devServerHealthChecker: {
          check(url) {
            events.push('health');
            return healthChecker.check(url);
          }
        },
        homeDir: '/tmp/home',
        promptEnvironment: {
          isInteractive: () => false
        }
      })
    );

    expect(exitCode).toBe(1);
    expect(events).toEqual(['setup', 'prompt', 'git-hooks', 'health']);
    expect(gitHookInstaller.invocations).toEqual([
      { scope: 'local', pluginRoot: '/src/teamem/plugin' }
    ]);
  });

  it('skips profile setup when selected dev profile credentials already exist', () => {
    const writes: string[] = [];
    const fileSystem = createDevProfileFileSystem({
      directories: ['/tmp/home/.teamem/dev-profiles/alice'],
      files: ['/tmp/home/.teamem/dev-profiles/alice/credentials.json']
    });
    const devSetupRunner = createDevSetupRunnerStub();
    const gitHookInstaller = createGitHookInstallerStub();
    const exitCode = runCli(
      ['dev', 'claude', '--profile', 'alice'],
      {
        stdout: {
          write(text: string) {
            writes.push(text);
          }
        },
        stderr: { write() {} }
      },
      createDevCliEnvironment({
        devProfileFileSystem: fileSystem,
        devSetupRunner,
        gitHookInstaller,
        homeDir: '/tmp/home',
        promptEnvironment: {
          isInteractive: () => false
        }
      })
    );

    expect(exitCode).toBe(0);
    expect(devSetupRunner.invocations).toEqual([]);
    expect(gitHookInstaller.invocations).toEqual([]);
    expect(
      fileSystem.files.get('/tmp/home/.teamem/dev-profiles/alice/mcp.json')
    ).toContain('/src/teamem/plugin/lib/bridge.js');
    expect(writes.join('')).toContain(
      'Profile credentials already exist; setup skipped.'
    );
    expect(writes.join('')).toContain('Teamem dev Claude launch');
    expect(writes.join('')).toContain('Real Claude: /opt/claude/bin/claude');
  });

  it('stops dev claude before launch planning when profile setup fails', () => {
    const writes: string[] = [];
    const stderr: string[] = [];
    const devSetupRunner = createDevSetupRunnerStub(130);
    const gitHookInstaller = createGitHookInstallerStub();
    const gitHookPrompter: GitHookPrompter = () => true;
    const exitCode = runCli(
      ['dev', 'claude', '--profile', 'alice'],
      {
        stdout: {
          write(text: string) {
            writes.push(text);
          }
        },
        stderr: {
          write(text: string) {
            stderr.push(text);
          }
        }
      },
      createDevCliEnvironment({
        devSetupRunner,
        gitHookInstaller,
        gitHookPrompter,
        homeDir: '/tmp/home',
        promptEnvironment: {
          isInteractive: () => false
        }
      })
    );

    expect(exitCode).toBe(130);
    expect(devSetupRunner.invocations).toHaveLength(1);
    expect(gitHookInstaller.invocations).toEqual([]);
    expect(stderr.join('')).toContain(
      'Profile-scoped Teamem setup exited with code 130.'
    );
    expect(writes.join('')).not.toContain('Launch planning is not implemented');
  });

  it('keeps Teamem source root and Claude launch cwd separate for dev claude', () => {
    const writes: string[] = [];
    const exitCode = runCli(
      [
        'dev',
        'claude',
        '--profile',
        'alice',
        '--teamem-root',
        '/src/teamem',
        '--cwd',
        '/work/launch-repo',
        '--dry-run'
      ],
      {
        stdout: {
          write(text: string) {
            writes.push(text);
          }
        },
        stderr: { write() {} }
      },
      createDevCliEnvironment({
        homeDir: '/tmp/home',
        promptEnvironment: {
          isInteractive: () => false
        }
      })
    );

    expect(exitCode).toBe(0);
    expect(writes.join('')).toContain('Source checkout: /src/teamem');
    expect(writes.join('')).toContain('Plugin source: /src/teamem/plugin');
    expect(writes.join('')).toContain('Launch cwd: /work/launch-repo');
  });

  it('fails dev claude without falling back to marketplace when source checkout is missing', () => {
    const writes: string[] = [];
    const fileSystem = createDevProfileFileSystem();
    const exitCode = runCli(
      ['dev', 'claude', '--profile', 'alice', '--dry-run'],
      {
        stdout: {
          write(text: string) {
            writes.push(text);
          }
        },
        stderr: { write() {} }
      },
      createDevCliEnvironment({
        cwd: '/work/consumer',
        devSourceFileSystem: createDevSourceFileSystem({
          roots: [],
          executableFiles: ['/opt/claude/bin/claude']
        }),
        devProfileFileSystem: fileSystem,
        homeDir: '/tmp/home',
        promptEnvironment: {
          isInteractive: () => false
        }
      })
    );

    expect(exitCode).toBe(1);
    expect(fileSystem.mkdirCalls).toEqual([]);
    expect(writes.join('')).toContain('source-checkout-required');
    expect(writes.join('')).toContain(
      'did not fall back to marketplace plugin behavior'
    );
  });

  it('dry-runs named dev claude profile creation without writing profile state', () => {
    const writes: string[] = [];
    const fileSystem = createDevProfileFileSystem();
    const runner = createDevClaudeLaunchRecorder();
    const exitCode = runCli(
      [
        'dev',
        'claude',
        '--profile',
        'alice',
        '--dry-run',
        '--',
        '--model',
        'opus'
      ],
      {
        stdout: {
          write(text: string) {
            writes.push(text);
          }
        },
        stderr: { write() {} }
      },
      createDevCliEnvironment({
        devProfileFileSystem: fileSystem,
        devClaudeProcessRunner: runner,
        homeDir: '/tmp/home',
        promptEnvironment: {
          isInteractive: () => false
        }
      })
    );

    expect(exitCode).toBe(0);
    expect(fileSystem.mkdirCalls).toEqual([]);
    expect(fileSystem.writeFileCalls).toEqual([]);
    expect(fileSystem.directories).not.toContain(
      '/tmp/home/.teamem/dev-profiles/alice'
    );
    expect(
      fileSystem.files.has('/tmp/home/.teamem/dev-profiles/alice/metadata.json')
    ).toBe(false);
    expect(writes.join('')).toContain('teamem dev');
    expect(writes.join('')).toContain(
      'dry-run: profile skeleton would be created if the command runs without --dry-run.'
    );
    expect(writes.join('')).toContain(
      'dry-run: profile-scoped Teamem setup would run with TEAMEM_CREDENTIALS=/tmp/home/.teamem/dev-profiles/alice/credentials.json.'
    );
    expect(writes.join('')).toContain(
      'dry-run: profile MCP config would be written to /tmp/home/.teamem/dev-profiles/alice/mcp.json from /src/teamem/plugin/.mcp.json.'
    );
    expect(writes.join('')).toContain(
      'dry-run: launch workspace MCP config would be written to /src/teamem/.mcp.json with Teamem dev channel servers.'
    );
    expect(writes.join('')).toContain('Teamem dev Claude launch plan');
    expect(writes.join('')).toContain('Command: /opt/claude/bin/claude');
    expect(writes.join('')).not.toContain('--channels server:teamem-channel');
    expect(writes.join('')).toContain(
      '--dangerously-load-development-channels server:teamem-channel'
    );
    expect(writes.join('')).toContain('--model opus');
    expect(writes.join('')).toContain(
      'Env keys: CLAUDE_CONFIG_DIR, CLAUDE_CODE_PLUGIN_CACHE_DIR, CLAUDE_CODE_MCP_ALLOWLIST_ENV, CLAUDE_PLUGIN_DATA, CLAUDE_PLUGIN_ROOT, TEAMEM_CREDENTIALS, TEAMEM_CLAUDE_LAUNCH_INTENT'
    );
    expect(writes.join('')).toContain(
      'Marketplace plugin ignored: teamem@teamem-alpha is not loaded for dev launch.'
    );
    expect(writes.join('')).not.toContain('plugin:teamem@teamem-alpha');
    expect(runner.invocations).toEqual([]);
  });

  it('does not run bundle or server probes during dev claude dry-run', () => {
    const writes: string[] = [];
    const bundleChecker = createDevBundleFreshnessCheckerStub();
    const healthChecker = createDevServerHealthCheckerStub(true);
    const exitCode = runCli(
      ['dev', 'claude', '--profile', 'alice', '--dry-run'],
      {
        stdout: {
          write(text: string) {
            writes.push(text);
          }
        },
        stderr: { write() {} }
      },
      createDevCliEnvironment({
        devBundleFreshnessChecker: bundleChecker,
        devServerHealthChecker: healthChecker,
        homeDir: '/tmp/home',
        promptEnvironment: { isInteractive: () => false }
      })
    );

    expect(exitCode).toBe(0);
    expect(bundleChecker.checks).toEqual([]);
    expect(healthChecker.checkedUrls).toEqual([]);
    expect(writes.join('')).toContain(
      'dry-run: plugin bundle freshness would be checked for /src/teamem before launch.'
    );
    expect(writes.join('')).toContain(
      'dry-run: server health would be checked at https://teamem.example/health before launch.'
    );
  });

  it('launches dev claude through the real binary with isolated profile env and passthrough args', () => {
    const runner = createDevClaudeLaunchRecorder();
    const fileSystem = createDevProfileFileSystem({
      directories: ['/tmp/home/.teamem/dev-profiles/alice'],
      files: ['/tmp/home/.teamem/dev-profiles/alice/credentials.json']
    });
    const sourceFileSystem = createDevSourceFileSystem({
      roots: ['/src/teamem'],
      executableFiles: [
        '/tmp/home/.teamem/bin/claude',
        '/opt/claude/bin/claude'
      ]
    });
    sourceFileSystem.writeFile(
      '/work/launch-repo/.mcp.json',
      `${JSON.stringify({
        mcpServers: {
          existing: {
            command: 'node',
            args: ['existing.js']
          }
        }
      })}\n`
    );
    const exitCode = runCli(
      [
        'dev',
        'claude',
        '--profile',
        'alice',
        '--cwd',
        '/work/launch-repo',
        '--',
        '--model',
        'opus',
        '--name',
        'kept'
      ],
      {
        stdout: { write() {} },
        stderr: { write() {} }
      },
      createDevCliEnvironment({
        devProfileFileSystem: fileSystem,
        devClaudeProcessRunner: runner,
        homeDir: '/tmp/home',
        env: {
          PATH: '/tmp/home/.teamem/bin:/opt/claude/bin',
          PRESERVED: '1',
          CLAUDE_PLUGIN_DATA: '/tmp/home/.claude/plugins/data/teamem',
          CLAUDE_PLUGIN_ROOT: '/tmp/home/.claude/plugins/cache/teamem-alpha',
          CLAUDE_SESSION_ID: 'stale-session',
          CLAUDE_PLUGIN_OPTION_DEFAULT_SPACE: 'stale-default',
          TEAMEM_SPACE: 'stale-space',
          TEAMEM_SPACE_ID: 'stale-space-id',
          TEAMEM_DEFAULT_SPACE: 'stale-teamem-default',
          TEAMEM_CLAUDE_LAUNCH_SPACE: 'stale-launch-space'
        },
        promptEnvironment: {
          isInteractive: () => false
        },
        devSourceFileSystem: sourceFileSystem
      })
    );

    expect(exitCode).toBe(0);
    expect(runner.invocations).toHaveLength(1);
    expect(runner.invocations[0]).toMatchObject({
      command: '/opt/claude/bin/claude',
      cwd: '/work/launch-repo'
    });
    expect(runner.invocations[0]?.args).toEqual([
      '--plugin-dir',
      '/src/teamem/plugin',
      '--mcp-config',
      '/tmp/home/.teamem/dev-profiles/alice/mcp.json',
      '--strict-mcp-config',
      '--dangerously-load-development-channels',
      'server:teamem-channel',
      '--model',
      'opus',
      '--name',
      'kept'
    ]);
    expect(runner.invocations[0]?.args).not.toContain(
      'plugin:teamem@teamem-alpha'
    );
    expect(runner.invocations[0]?.args).not.toContain('--setting-sources');
    expect(runner.invocations[0]?.args).not.toContain('--bare');
    expect(runner.invocations[0]?.env).toMatchObject({
      PATH: '/tmp/home/.teamem/bin:/opt/claude/bin',
      PRESERVED: '1',
      CLAUDE_CONFIG_DIR: '/tmp/home/.teamem/dev-profiles/alice/claude',
      CLAUDE_CODE_PLUGIN_CACHE_DIR:
        '/tmp/home/.teamem/dev-profiles/alice/claude/plugins',
      CLAUDE_CODE_MCP_ALLOWLIST_ENV: '1',
      CLAUDE_PLUGIN_DATA:
        '/tmp/home/.teamem/dev-profiles/alice/plugin-data/teamem',
      CLAUDE_PLUGIN_ROOT: '/src/teamem/plugin',
      TEAMEM_CREDENTIALS:
        '/tmp/home/.teamem/dev-profiles/alice/credentials.json',
      TEAMEM_CLAUDE_LAUNCH_INTENT: 'activate'
    });
    expect(runner.invocations[0]?.env.CLAUDE_SESSION_ID).toBeUndefined();
    expect(
      runner.invocations[0]?.env.CLAUDE_PLUGIN_OPTION_DEFAULT_SPACE
    ).toBeUndefined();
    expect(runner.invocations[0]?.env.TEAMEM_SPACE).toBeUndefined();
    expect(runner.invocations[0]?.env.TEAMEM_SPACE_ID).toBeUndefined();
    expect(runner.invocations[0]?.env.TEAMEM_DEFAULT_SPACE).toBeUndefined();
    expect(
      runner.invocations[0]?.env.TEAMEM_CLAUDE_LAUNCH_SPACE
    ).toBeUndefined();
    expect(JSON.stringify(runner.invocations[0]?.env)).not.toContain(
      '/tmp/home/.claude/plugins/data/teamem'
    );
    expect(JSON.stringify(runner.invocations[0]?.env)).not.toContain(
      '/tmp/home/.claude/plugins/cache/teamem-alpha'
    );
    const launchWorkspaceMcp = JSON.parse(
      sourceFileSystem.files.get('/work/launch-repo/.mcp.json') ?? '{}'
    ) as {
      mcpServers?: Record<string, { command?: string; args?: string[] }>;
    };
    expect(Object.keys(launchWorkspaceMcp.mcpServers ?? {})).toEqual([
      'existing',
      'teamem',
      'teamem-channel'
    ]);
    expect(launchWorkspaceMcp.mcpServers?.existing).toEqual({
      command: 'node',
      args: ['existing.js']
    });
    expect(launchWorkspaceMcp.mcpServers?.teamem?.args).toEqual([
      'run',
      '/src/teamem/plugin/lib/bridge.js'
    ]);
    expect(launchWorkspaceMcp.mcpServers?.['teamem-channel']?.args).toEqual([
      'run',
      '/src/teamem/plugin/lib/channel.js'
    ]);
  });

  it('checks profile server health before launching dev claude', () => {
    const runner = createDevClaudeLaunchRecorder();
    const healthChecker = createDevServerHealthCheckerStub(true);
    const fileSystem = createDevProfileFileSystem({
      directories: ['/tmp/home/.teamem/dev-profiles/alice'],
      files: ['/tmp/home/.teamem/dev-profiles/alice/credentials.json']
    });

    const exitCode = runCli(
      ['dev', 'claude', '--profile', 'alice'],
      { stdout: { write() {} }, stderr: { write() {} } },
      createDevCliEnvironment({
        devProfileFileSystem: fileSystem,
        devClaudeProcessRunner: runner,
        devServerHealthChecker: healthChecker,
        homeDir: '/tmp/home',
        promptEnvironment: { isInteractive: () => false }
      })
    );

    expect(exitCode).toBe(0);
    expect(healthChecker.checkedUrls).toEqual([
      'https://teamem.example/health'
    ]);
    expect(runner.invocations).toHaveLength(1);
  });

  it('blocks dev claude and prints the checked URL when server health is unreachable', () => {
    const writes: string[] = [];
    const stderr: string[] = [];
    const runner = createDevClaudeLaunchRecorder();
    const healthChecker = createDevServerHealthCheckerStub(false);
    const fileSystem = createDevProfileFileSystem({
      directories: ['/tmp/home/.teamem/dev-profiles/alice'],
      files: ['/tmp/home/.teamem/dev-profiles/alice/credentials.json']
    });

    const exitCode = runCli(
      ['dev', 'claude', '--profile', 'alice'],
      {
        stdout: {
          write(text: string) {
            writes.push(text);
          }
        },
        stderr: {
          write(text: string) {
            stderr.push(text);
          }
        }
      },
      createDevCliEnvironment({
        devProfileFileSystem: fileSystem,
        devClaudeProcessRunner: runner,
        devServerHealthChecker: healthChecker,
        homeDir: '/tmp/home',
        promptEnvironment: { isInteractive: () => false }
      })
    );

    expect(exitCode).toBe(1);
    expect(runner.invocations).toEqual([]);
    expect(writes.join('')).toContain(
      'Server health: unreachable (https://teamem.example/health)'
    );
    expect(stderr.join('')).toContain(
      'Teamem server is unreachable at https://teamem.example/health'
    );
  });

  it('does not auto-start local servers or Docker during dev claude preflight', () => {
    const commandRunner = createRecordingRunner({
      'bun --version': ok('1.2.0\n'),
      'git -C /src/teamem branch --show-current': ok('master\n'),
      'git -C /src/teamem status --short': ok(''),
      'git rev-parse --is-inside-work-tree': ok('true\n')
    });

    const exitCode = runCli(
      ['dev', 'claude', '--profile', 'alice'],
      { stdout: { write() {} }, stderr: { write() {} } },
      createDevCliEnvironment({
        commandRunner,
        homeDir: '/tmp/home',
        promptEnvironment: { isInteractive: () => false }
      })
    );

    expect(exitCode).toBe(0);
    expect(commandRunner.invocations.join('\n')).not.toContain('docker');
    expect(commandRunner.invocations.join('\n')).not.toContain('server');
  });

  it('discloses dirty source checkout state in dry-run and launch output without blocking', () => {
    const dryRunWrites: string[] = [];
    const launchWrites: string[] = [];
    const dirtyStatus = ' M src/bridge/index.ts\n?? scratch.txt\n';

    const dryRunExitCode = runCli(
      ['dev', 'claude', '--profile', 'alice', '--dry-run'],
      {
        stdout: {
          write(text: string) {
            dryRunWrites.push(text);
          }
        },
        stderr: { write() {} }
      },
      createDevCliEnvironment({
        commandRunner: createDevSourceCommandRunner({
          sourceRoot: '/src/teamem',
          dirtyStatus
        }),
        homeDir: '/tmp/home',
        promptEnvironment: { isInteractive: () => false }
      })
    );

    const launchExitCode = runCli(
      ['dev', 'claude', '--profile', 'alice'],
      {
        stdout: {
          write(text: string) {
            launchWrites.push(text);
          }
        },
        stderr: { write() {} }
      },
      createDevCliEnvironment({
        commandRunner: createDevSourceCommandRunner({
          sourceRoot: '/src/teamem',
          dirtyStatus
        }),
        homeDir: '/tmp/home',
        promptEnvironment: { isInteractive: () => false }
      })
    );

    expect(dryRunExitCode).toBe(0);
    expect(launchExitCode).toBe(0);
    expect(dryRunWrites.join('')).toContain(
      'Source checkout has 2 dirty path(s)'
    );
    expect(launchWrites.join('')).toContain(
      'Source checkout has 2 dirty path(s)'
    );
  });

  it('reports fresh plugin bundles before launching dev claude', () => {
    const writes: string[] = [];
    const runner = createDevClaudeLaunchRecorder();
    const bundleChecker = createDevBundleFreshnessCheckerStub();

    const exitCode = runCli(
      ['dev', 'claude', '--profile', 'alice'],
      {
        stdout: {
          write(text: string) {
            writes.push(text);
          }
        },
        stderr: { write() {} }
      },
      createDevCliEnvironment({
        devBundleFreshnessChecker: bundleChecker,
        devClaudeProcessRunner: runner,
        homeDir: '/tmp/home',
        promptEnvironment: { isInteractive: () => false }
      })
    );

    expect(exitCode).toBe(0);
    expect(bundleChecker.checks).toEqual(['/src/teamem']);
    expect(writes.join('')).toContain(
      'Bundle freshness passed: committed plugin/lib bundles match source builds byte-for-byte.'
    );
    expect(runner.invocations).toHaveLength(1);
  });

  it('blocks non-interactive dev claude when plugin bundles are stale or missing', () => {
    const staleRunner = createDevClaudeLaunchRecorder();
    const missingRunner = createDevClaudeLaunchRecorder();
    const staleSetupRunner = createDevSetupRunnerStub();
    const missingSetupRunner = createDevSetupRunnerStub();
    const staleExitCode = runCli(
      ['dev', 'claude', '--profile', 'alice'],
      { stdout: { write() {} }, stderr: { write() {} } },
      createDevCliEnvironment({
        devBundleFreshnessChecker: createDevBundleFreshnessCheckerStub([
          createStaleBundleReport('stale')
        ]),
        devSetupRunner: staleSetupRunner,
        devClaudeProcessRunner: staleRunner,
        homeDir: '/tmp/home',
        promptEnvironment: { isInteractive: () => false }
      })
    );
    const missingExitCode = runCli(
      ['dev', 'claude', '--profile', 'alice'],
      { stdout: { write() {} }, stderr: { write() {} } },
      createDevCliEnvironment({
        devBundleFreshnessChecker: createDevBundleFreshnessCheckerStub([
          createStaleBundleReport('missing')
        ]),
        devSetupRunner: missingSetupRunner,
        devClaudeProcessRunner: missingRunner,
        homeDir: '/tmp/home',
        promptEnvironment: { isInteractive: () => false }
      })
    );

    expect(staleExitCode).toBe(1);
    expect(missingExitCode).toBe(1);
    expect(staleRunner.invocations).toEqual([]);
    expect(missingRunner.invocations).toEqual([]);
    expect(staleSetupRunner.invocations).toEqual([]);
    expect(missingSetupRunner.invocations).toEqual([]);
  });

  it('runs build-plugin and rechecks bundles before dev claude launch when requested', () => {
    const runner = createDevClaudeLaunchRecorder();
    const builder = createDevPluginBuilderStub();
    const checker = createDevBundleFreshnessCheckerStub([
      createStaleBundleReport('stale'),
      createFreshBundleReport()
    ]);

    const exitCode = runCli(
      ['dev', 'claude', '--profile', 'alice', '--build-plugin'],
      { stdout: { write() {} }, stderr: { write() {} } },
      createDevCliEnvironment({
        devBundleFreshnessChecker: checker,
        devPluginBuilder: builder,
        devClaudeProcessRunner: runner,
        homeDir: '/tmp/home',
        promptEnvironment: { isInteractive: () => false }
      })
    );

    expect(exitCode).toBe(0);
    expect(builder.builds).toEqual(['/src/teamem']);
    expect(checker.checks).toEqual(['/src/teamem', '/src/teamem']);
    expect(runner.invocations).toHaveLength(1);
  });

  it('runs build-plugin and rechecks bundles even when the initial report is fresh', () => {
    const runner = createDevClaudeLaunchRecorder();
    const builder = createDevPluginBuilderStub();
    const checker = createDevBundleFreshnessCheckerStub([
      createFreshBundleReport(),
      createFreshBundleReport()
    ]);

    const exitCode = runCli(
      ['dev', 'claude', '--profile', 'alice', '--build-plugin'],
      { stdout: { write() {} }, stderr: { write() {} } },
      createDevCliEnvironment({
        devBundleFreshnessChecker: checker,
        devPluginBuilder: builder,
        devClaudeProcessRunner: runner,
        homeDir: '/tmp/home',
        promptEnvironment: { isInteractive: () => false }
      })
    );

    expect(exitCode).toBe(0);
    expect(builder.builds).toEqual(['/src/teamem']);
    expect(checker.checks).toEqual(['/src/teamem', '/src/teamem']);
    expect(runner.invocations).toHaveLength(1);
  });

  it('offers interactive bundle rebuild and launches only when accepted', () => {
    const acceptedRunner = createDevClaudeLaunchRecorder();
    const declinedRunner = createDevClaudeLaunchRecorder();
    const acceptedBuilder = createDevPluginBuilderStub();
    const declinedBuilder = createDevPluginBuilderStub();

    const acceptedExitCode = runCli(
      ['dev', 'claude', '--profile', 'alice'],
      { stdout: { write() {} }, stderr: { write() {} } },
      createDevCliEnvironment({
        devBundleFreshnessChecker: createDevBundleFreshnessCheckerStub([
          createStaleBundleReport('stale'),
          createFreshBundleReport()
        ]),
        devPluginBuilder: acceptedBuilder,
        devClaudeProcessRunner: acceptedRunner,
        homeDir: '/tmp/home',
        promptEnvironment: { isInteractive: () => true, prompt: () => 'yes' }
      })
    );
    const declinedExitCode = runCli(
      ['dev', 'claude', '--profile', 'alice'],
      { stdout: { write() {} }, stderr: { write() {} } },
      createDevCliEnvironment({
        devBundleFreshnessChecker: createDevBundleFreshnessCheckerStub([
          createStaleBundleReport('stale')
        ]),
        devPluginBuilder: declinedBuilder,
        devClaudeProcessRunner: declinedRunner,
        homeDir: '/tmp/home',
        promptEnvironment: { isInteractive: () => true, prompt: () => 'no' }
      })
    );

    expect(acceptedExitCode).toBe(0);
    expect(acceptedBuilder.builds).toEqual(['/src/teamem']);
    expect(acceptedRunner.invocations).toHaveLength(1);
    expect(declinedExitCode).toBe(1);
    expect(declinedBuilder.builds).toEqual([]);
    expect(declinedRunner.invocations).toEqual([]);
  });

  it('bypasses a Teamem-owned claude shim and adds a profile-derived session name', () => {
    const runner = createDevClaudeLaunchRecorder();
    const exitCode = runCli(
      ['dev', 'claude', '--profile', 'alice', '--', '--continue'],
      {
        stdout: { write() {} },
        stderr: { write() {} }
      },
      createDevCliEnvironment({
        devClaudeProcessRunner: runner,
        homeDir: '/tmp/home',
        pathEnv: '/tmp/home/.teamem/bin:/opt/claude/bin',
        devSourceFileSystem: createDevSourceFileSystem({
          roots: ['/src/teamem'],
          executableFiles: [
            '/tmp/home/.teamem/bin/claude',
            '/opt/claude/bin/claude'
          ]
        }),
        promptEnvironment: {
          isInteractive: () => false
        }
      })
    );

    expect(exitCode).toBe(0);
    expect(runner.invocations[0]?.command).toBe('/opt/claude/bin/claude');
    expect(runner.invocations[0]?.args).toEqual([
      '--plugin-dir',
      '/src/teamem/plugin',
      '--mcp-config',
      '/tmp/home/.teamem/dev-profiles/alice/mcp.json',
      '--strict-mcp-config',
      '--dangerously-load-development-channels',
      'server:teamem-channel',
      '--name',
      'teamem-alice',
      '--continue'
    ]);
  });

  it('preserves compact user-provided dev claude session names', () => {
    const equalsRunner = createDevClaudeLaunchRecorder();
    const compactRunner = createDevClaudeLaunchRecorder();

    const equalsExitCode = runCli(
      ['dev', 'claude', '--profile', 'alice', '--', '--name=custom'],
      { stdout: { write() {} }, stderr: { write() {} } },
      createDevCliEnvironment({
        devClaudeProcessRunner: equalsRunner,
        homeDir: '/tmp/home',
        promptEnvironment: { isInteractive: () => false }
      })
    );
    const compactExitCode = runCli(
      ['dev', 'claude', '--profile', 'alice', '--', '-n=short'],
      { stdout: { write() {} }, stderr: { write() {} } },
      createDevCliEnvironment({
        devClaudeProcessRunner: compactRunner,
        homeDir: '/tmp/home',
        promptEnvironment: { isInteractive: () => false }
      })
    );

    expect(equalsExitCode).toBe(0);
    expect(compactExitCode).toBe(0);
    expect(equalsRunner.invocations[0]?.args).toContain('--name=custom');
    expect(compactRunner.invocations[0]?.args).toContain('-n=short');
    expect(equalsRunner.invocations[0]?.args).not.toContain('teamem-alice');
    expect(compactRunner.invocations[0]?.args).not.toContain('teamem-alice');
  });

  it('blocks dev claude when the selected plugin MCP declaration is invalid', () => {
    const stderr: string[] = [];
    const profileFileSystem = createDevProfileFileSystem();
    const devSetupRunner = createDevSetupRunnerStub();
    const sourceFileSystem = createDevSourceFileSystem({
      roots: ['/src/teamem'],
      executableFiles: [
        '/tmp/home/.teamem/bin/claude',
        '/opt/claude/bin/claude'
      ]
    });
    sourceFileSystem.files.set(
      '/src/teamem/plugin/.mcp.json',
      JSON.stringify({
        mcpServers: {
          teamem: {
            command: 'bun',
            args: ['run', '${CLAUDE_PLUGIN_ROOT}/lib/bridge.js'],
            env: {
              BAD: 123
            }
          },
          'teamem-channel': {
            command: 'bun',
            args: ['run', '${CLAUDE_PLUGIN_ROOT}/lib/channel.js']
          }
        }
      })
    );

    const exitCode = runCli(
      ['dev', 'claude', '--profile', 'alice'],
      {
        stdout: { write() {} },
        stderr: {
          write(text: string) {
            stderr.push(text);
          }
        }
      },
      createDevCliEnvironment({
        devProfileFileSystem: profileFileSystem,
        devSourceFileSystem: sourceFileSystem,
        devSetupRunner,
        homeDir: '/tmp/home',
        promptEnvironment: {
          isInteractive: () => false
        }
      })
    );

    expect(exitCode).toBe(1);
    expect(stderr.join('')).toContain(
      'Plugin MCP server env must be a string map: teamem'
    );
    expect(devSetupRunner.invocations).toEqual([]);
    expect(
      profileFileSystem.files.has(
        '/tmp/home/.teamem/dev-profiles/alice/mcp.json'
      )
    ).toBe(false);
  });

  it('dry-runs prompted dev claude profile creation without writing profile state', () => {
    const writes: string[] = [];
    const fileSystem = createDevProfileFileSystem();
    const exitCode = runCli(
      ['dev', 'claude', '--dry-run'],
      {
        stdout: {
          write(text: string) {
            writes.push(text);
          }
        },
        stderr: { write() {} }
      },
      createDevCliEnvironment({
        devProfileFileSystem: fileSystem,
        homeDir: '/tmp/home',
        promptEnvironment: {
          isInteractive: () => true,
          prompt: () => 'alice'
        }
      })
    );

    expect(exitCode).toBe(0);
    expect(fileSystem.mkdirCalls).toEqual([]);
    expect(fileSystem.writeFileCalls).toEqual([]);
    expect(fileSystem.directories).not.toContain(
      '/tmp/home/.teamem/dev-profiles/alice'
    );
    expect(writes.join('')).toContain('Selected dev profile: alice');
  });

  it('dry-runs prompted dev claude existing-profile selection without writing profile state', () => {
    const writes: string[] = [];
    const promptMessages: string[] = [];
    const fileSystem = createDevProfileFileSystem({
      directories: [
        '/tmp/home/.teamem/dev-profiles/alice',
        '/tmp/home/.teamem/dev-profiles/bob'
      ],
      files: ['/tmp/home/.teamem/dev-profiles/alice/credentials.json']
    });
    const exitCode = runCli(
      ['dev', 'claude', '--dry-run'],
      {
        stdout: {
          write(text: string) {
            writes.push(text);
          }
        },
        stderr: { write() {} }
      },
      createDevCliEnvironment({
        devProfileFileSystem: fileSystem,
        homeDir: '/tmp/home',
        promptEnvironment: {
          isInteractive: () => true,
          prompt: (message) => {
            promptMessages.push(message);
            return '1';
          }
        }
      })
    );

    expect(exitCode).toBe(0);
    expect(promptMessages.join('')).toContain('1. alice');
    expect(promptMessages.join('')).toContain('2. bob');
    expect(fileSystem.mkdirCalls).toEqual([]);
    expect(fileSystem.writeFileCalls).toEqual([]);
    expect(writes.join('')).toContain('Selected dev profile: alice');
    expect(writes.join('')).toContain(
      'dry-run: existing profile would be used without launching Claude Code.'
    );
  });

  it('dry-runs prompted dev claude new slug planning without creating the profile', () => {
    const writes: string[] = [];
    const promptMessages: string[] = [];
    const fileSystem = createDevProfileFileSystem({
      directories: ['/tmp/home/.teamem/dev-profiles/alice']
    });
    const exitCode = runCli(
      ['dev', 'claude', '--dry-run'],
      {
        stdout: {
          write(text: string) {
            writes.push(text);
          }
        },
        stderr: { write() {} }
      },
      createDevCliEnvironment({
        devProfileFileSystem: fileSystem,
        homeDir: '/tmp/home',
        promptEnvironment: {
          isInteractive: () => true,
          prompt: (message) => {
            promptMessages.push(message);
            return 'charlie';
          }
        }
      })
    );

    expect(exitCode).toBe(0);
    expect(promptMessages.join('')).toContain('1. alice');
    expect(promptMessages.join('')).toContain('Or enter a new profile slug.');
    expect(fileSystem.mkdirCalls).toEqual([]);
    expect(fileSystem.writeFileCalls).toEqual([]);
    expect(fileSystem.directories).not.toContain(
      '/tmp/home/.teamem/dev-profiles/charlie'
    );
    expect(writes.join('')).toContain('Selected dev profile: charlie');
    expect(writes.join('')).toContain(
      'dry-run: profile skeleton would be created if the command runs without --dry-run.'
    );
  });

  it('lets interactive dev claude create a selected profile skeleton', () => {
    const writes: string[] = [];
    const fileSystem = createDevProfileFileSystem();
    const exitCode = runCli(
      ['dev', 'claude'],
      {
        stdout: {
          write(text: string) {
            writes.push(text);
          }
        },
        stderr: { write() {} }
      },
      createDevCliEnvironment({
        devProfileFileSystem: fileSystem,
        homeDir: '/tmp/home',
        now: () => new Date('2026-05-29T00:00:00.000Z'),
        promptEnvironment: {
          isInteractive: () => true,
          prompt: () => 'alice'
        }
      })
    );

    expect(exitCode).toBe(0);
    expect(fileSystem.directories).toContain(
      '/tmp/home/.teamem/dev-profiles/alice'
    );
    expect(
      fileSystem.files.has('/tmp/home/.teamem/dev-profiles/alice/metadata.json')
    ).toBe(true);
    expect(writes.join('')).toContain('Selected dev profile: alice');
    expect(writes.join('')).toContain('Teamem dev Claude launch');
  });

  it('does not create profiles for interactive dev delete selection', () => {
    const stderr: string[] = [];
    const fileSystem = createDevProfileFileSystem({
      directories: ['/tmp/home/.teamem/dev-profiles/alice']
    });
    const exitCode = runCli(
      ['dev', 'delete'],
      {
        stdout: { write() {} },
        stderr: {
          write(text: string) {
            stderr.push(text);
          }
        }
      },
      createDevCliEnvironment({
        devProfileFileSystem: fileSystem,
        homeDir: '/tmp/home',
        promptEnvironment: {
          isInteractive: () => true,
          prompt: () => 'bob'
        }
      })
    );

    expect(exitCode).toBe(1);
    expect(fileSystem.directories).not.toContain(
      '/tmp/home/.teamem/dev-profiles/bob'
    );
    expect(stderr.join('')).toContain('Creation is not allowed');
  });

  it('rejects missing requested dev delete profiles without creating state', () => {
    const stderr: string[] = [];
    const fileSystem = createDevProfileFileSystem({
      directories: ['/tmp/home/.teamem/dev-profiles/alice']
    });
    const exitCode = runCli(
      ['dev', 'delete', '--profile', 'missing', '--yes'],
      {
        stdout: { write() {} },
        stderr: {
          write(text: string) {
            stderr.push(text);
          }
        }
      },
      createDevCliEnvironment({
        devProfileFileSystem: fileSystem,
        homeDir: '/tmp/home',
        promptEnvironment: {
          isInteractive: () => false
        }
      })
    );

    expect(exitCode).toBe(1);
    expect(fileSystem.mkdirCalls).toEqual([]);
    expect(fileSystem.writeFileCalls).toEqual([]);
    expect(stderr.join('')).toContain('Dev profile does not exist: missing');
  });

  it('requires --yes for non-interactive dev delete', () => {
    const stderr: string[] = [];
    const fileSystem = createDevProfileFileSystem({
      directories: ['/tmp/home/.teamem/dev-profiles/alice']
    });
    const exitCode = runCli(
      ['dev', 'delete', '--profile', 'alice'],
      {
        stdout: { write() {} },
        stderr: {
          write(text: string) {
            stderr.push(text);
          }
        }
      },
      createDevCliEnvironment({
        devProfileFileSystem: fileSystem,
        homeDir: '/tmp/home',
        promptEnvironment: { isInteractive: () => false }
      })
    );

    expect(exitCode).toBe(1);
    expect(stderr.join('')).toContain(
      'Non-interactive `teamem dev delete` requires --yes.'
    );
    expect(fileSystem.removeDirectoryCalls).toEqual([]);
  });

  it('deletes only the selected dev profile with --yes', () => {
    const writes: string[] = [];
    const fileSystem = createDevProfileFileSystem({
      directories: [
        '/tmp/home/.teamem/dev-profiles/alice/claude/plugins',
        '/tmp/home/.teamem/dev-profiles/bob',
        '/tmp/home/.claude',
        '/src/teamem/plugin',
        '/tmp/home/.config/claude/plugins'
      ],
      files: [
        '/tmp/home/.teamem/dev-profiles/alice/credentials.json',
        '/tmp/home/.teamem/credentials.json'
      ]
    });

    const exitCode = runCli(
      ['dev', 'delete', '--profile', 'alice', '--yes'],
      {
        stdout: {
          write(text: string) {
            writes.push(text);
          }
        },
        stderr: { write() {} }
      },
      createDevCliEnvironment({
        devProfileFileSystem: fileSystem,
        homeDir: '/tmp/home',
        promptEnvironment: { isInteractive: () => false }
      })
    );

    expect(exitCode).toBe(0);
    expect(writes.join('')).toContain(
      'Profile root: /tmp/home/.teamem/dev-profiles/alice'
    );
    expect(writes.join('')).toContain('Deleted dev profile: alice');
    expect(fileSystem.removeDirectoryCalls).toEqual([
      '/tmp/home/.teamem/dev-profiles/alice'
    ]);
    expect(fileSystem.directories).not.toContain(
      '/tmp/home/.teamem/dev-profiles/alice'
    );
    expect(
      fileSystem.files.has(
        '/tmp/home/.teamem/dev-profiles/alice/credentials.json'
      )
    ).toBe(false);
    expect(fileSystem.directories).toContain(
      '/tmp/home/.teamem/dev-profiles/bob'
    );
    expect(fileSystem.directories).toContain('/tmp/home/.claude');
    expect(fileSystem.files.has('/tmp/home/.teamem/credentials.json')).toBe(
      true
    );
    expect(fileSystem.directories).toContain('/src/teamem/plugin');
    expect(fileSystem.directories).toContain(
      '/tmp/home/.config/claude/plugins'
    );
  });

  it('requires exact interactive confirmation before dev delete', () => {
    const prompts: string[] = [];
    const fileSystem = createDevProfileFileSystem({
      directories: ['/tmp/home/.teamem/dev-profiles/alice']
    });
    const cancelledExitCode = runCli(
      ['dev', 'delete', '--profile', 'alice'],
      { stdout: { write() {} }, stderr: { write() {} } },
      createDevCliEnvironment({
        devProfileFileSystem: fileSystem,
        homeDir: '/tmp/home',
        promptEnvironment: {
          isInteractive: () => true,
          prompt: (message) => {
            prompts.push(message);
            return 'no';
          }
        }
      })
    );
    const confirmedExitCode = runCli(
      ['dev', 'delete', '--profile', 'alice'],
      { stdout: { write() {} }, stderr: { write() {} } },
      createDevCliEnvironment({
        devProfileFileSystem: fileSystem,
        homeDir: '/tmp/home',
        promptEnvironment: {
          isInteractive: () => true,
          prompt: (message) => {
            prompts.push(message);
            return 'alice';
          }
        }
      })
    );

    expect(cancelledExitCode).toBe(1);
    expect(confirmedExitCode).toBe(0);
    expect(prompts.join('\n')).toContain(
      '/tmp/home/.teamem/dev-profiles/alice'
    );
    expect(fileSystem.removeDirectoryCalls).toEqual([
      '/tmp/home/.teamem/dev-profiles/alice'
    ]);
  });

  it('lets dev delete without --profile select existing profiles without creation', () => {
    const prompts: string[] = [];
    const fileSystem = createDevProfileFileSystem({
      directories: [
        '/tmp/home/.teamem/dev-profiles/alice',
        '/tmp/home/.teamem/dev-profiles/bob'
      ]
    });
    const exitCode = runCli(
      ['dev', 'delete'],
      { stdout: { write() {} }, stderr: { write() {} } },
      createDevCliEnvironment({
        devProfileFileSystem: fileSystem,
        homeDir: '/tmp/home',
        promptEnvironment: {
          isInteractive: () => true,
          prompt: (message) => {
            prompts.push(message);
            return prompts.length === 1 ? '2' : 'bob';
          }
        }
      })
    );

    expect(exitCode).toBe(0);
    expect(prompts[0]).toContain('Select Teamem dev profile:');
    expect(prompts[0]).not.toContain('Or enter a new profile slug.');
    expect(fileSystem.directories).not.toContain(
      '/tmp/home/.teamem/dev-profiles/bob'
    );
    expect(fileSystem.mkdirCalls).toEqual([]);
  });

  it('blocks dev delete when an active profiled Claude process is detected unless forced', () => {
    const blockedFileSystem = createDevProfileFileSystem({
      directories: ['/tmp/home/.teamem/dev-profiles/alice']
    });
    const forcedFileSystem = createDevProfileFileSystem({
      directories: ['/tmp/home/.teamem/dev-profiles/alice']
    });
    const detector = createDevProfileActiveSessionDetectorStub({
      status: 'active',
      message: 'Found running Claude process for profile alice: 123 claude'
    });

    const blockedExitCode = runCli(
      ['dev', 'delete', '--profile', 'alice', '--yes'],
      { stdout: { write() {} }, stderr: { write() {} } },
      createDevCliEnvironment({
        devProfileFileSystem: blockedFileSystem,
        devProfileActiveSessionDetector: detector,
        homeDir: '/tmp/home',
        promptEnvironment: { isInteractive: () => false }
      })
    );
    const forcedExitCode = runCli(
      ['dev', 'delete', '--profile', 'alice', '--yes', '--force'],
      { stdout: { write() {} }, stderr: { write() {} } },
      createDevCliEnvironment({
        devProfileFileSystem: forcedFileSystem,
        devProfileActiveSessionDetector: detector,
        homeDir: '/tmp/home',
        promptEnvironment: { isInteractive: () => false }
      })
    );

    expect(blockedExitCode).toBe(1);
    expect(forcedExitCode).toBe(0);
    expect(blockedFileSystem.removeDirectoryCalls).toEqual([]);
    expect(forcedFileSystem.removeDirectoryCalls).toEqual([
      '/tmp/home/.teamem/dev-profiles/alice'
    ]);
  });

  it('warns and still requires confirmation when dev delete process detection is inconclusive', () => {
    const stderr: string[] = [];
    const fileSystem = createDevProfileFileSystem({
      directories: ['/tmp/home/.teamem/dev-profiles/alice']
    });
    const exitCode = runCli(
      ['dev', 'delete', '--profile', 'alice'],
      {
        stdout: { write() {} },
        stderr: {
          write(text: string) {
            stderr.push(text);
          }
        }
      },
      createDevCliEnvironment({
        devProfileFileSystem: fileSystem,
        devProfileActiveSessionDetector:
          createDevProfileActiveSessionDetectorStub({
            status: 'inconclusive',
            message: 'pgrep is unavailable'
          }),
        homeDir: '/tmp/home',
        promptEnvironment: {
          isInteractive: () => true,
          prompt: () => 'alice'
        }
      })
    );

    expect(exitCode).toBe(0);
    expect(stderr.join('')).toContain('Warning: pgrep is unavailable');
    expect(fileSystem.removeDirectoryCalls).toEqual([
      '/tmp/home/.teamem/dev-profiles/alice'
    ]);
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
    expect(writes.join('')).toContain('not affiliated with Anthropic');
    expect(writes.join('')).toContain('does not handle Claude credentials');
    expect(writes.join('')).toContain('teamem claude uninstall');
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

  it('installs project Claude statusline settings with the stable Teamem wrapper command', () => {
    const writes: string[] = [];
    const launcherFileSystem = createLauncherFileSystem();

    const exitCode = runCli(
      ['claude', 'statusline', 'install'],
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
        homeDir: '/tmp/home',
        cwd: '/tmp/project'
      })
    );

    expect(exitCode).toBe(0);
    const settings = launcherFileSystem.files.get(
      '/tmp/project/.claude/settings.json'
    );
    expect(settings).toBe(
      `{\n  "statusLine": {\n    "type": "command",\n    "command": "${TEAMEM_STATUSLINE_COMMAND}"\n  }\n}\n`
    );
    expect(settings).toContain('teamem claude statusline render');
    expect(settings).not.toContain('.claude-plugin');
    expect(settings).not.toContain('.teamem-backup');
    expect(writes.join('')).toContain('Status: installed');
    expect(writes.join('')).toContain('Scope: project');
  });

  it('installs Claude statusline settings only at the explicitly selected scope', () => {
    const writes: string[] = [];
    const launcherFileSystem = createLauncherFileSystem({
      files: {
        '/tmp/project/.claude/settings.json':
          '{"statusLine":{"type":"command","command":"project-status"}}\n',
        '/tmp/project/.claude/settings.local.json':
          '{"statusLine":{"type":"command","command":"local-status"}}\n'
      }
    });

    const exitCode = runCli(
      ['claude', 'statusline', 'install', '--scope', 'user'],
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
        homeDir: '/tmp/home',
        cwd: '/tmp/project'
      })
    );

    expect(exitCode).toBe(0);
    expect(
      launcherFileSystem.files.get('/tmp/home/.claude/settings.json')
    ).toContain(TEAMEM_STATUSLINE_COMMAND);
    expect(
      launcherFileSystem.files.get('/tmp/project/.claude/settings.json')
    ).toBe('{"statusLine":{"type":"command","command":"project-status"}}\n');
    expect(
      launcherFileSystem.files.get('/tmp/project/.claude/settings.local.json')
    ).toBe('{"statusLine":{"type":"command","command":"local-status"}}\n');
    expect(writes.join('')).toContain('Scope: user');
    expect(writes.join('')).toContain('Selected effective: no');
  });

  it('defaults Claude statusline install to user scope outside a git repository', () => {
    const launcherFileSystem = createLauncherFileSystem();

    const exitCode = runCli(
      ['claude', 'statusline', 'install'],
      { stdout: { write() {} }, stderr: { write() {} } },
      createLauncherCliEnvironment({
        launcherFileSystem,
        commandRunner: createFakeRunner({
          'git rev-parse --is-inside-work-tree': fail('not a repo')
        }),
        pathEnv: '/opt/claude/bin',
        homeDir: '/tmp/home',
        cwd: '/tmp/outside'
      })
    );

    expect(exitCode).toBe(0);
    expect(
      launcherFileSystem.files.get('/tmp/home/.claude/settings.json')
    ).toContain(TEAMEM_STATUSLINE_COMMAND);
    expect(
      launcherFileSystem.files.has('/tmp/outside/.claude/settings.json')
    ).toBe(false);
  });

  it('refuses foreign project Claude statusline settings and reports conflict status', () => {
    const installWrites: string[] = [];
    const launcherFileSystem = createLauncherFileSystem({
      files: {
        '/tmp/project/.claude/settings.json':
          '{"statusLine":{"type":"command","command":"custom-status"}}\n'
      }
    });

    const installExitCode = runCli(
      ['claude', 'statusline', 'install'],
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
        homeDir: '/tmp/home',
        cwd: '/tmp/project'
      })
    );

    expect(installExitCode).toBe(1);
    expect(installWrites.join('')).toContain('Status: foreign');
    expect(installWrites.join('')).toContain('Refusing to overwrite');
    expect(installWrites.join('')).toContain('does not provide --force');
    expect(
      launcherFileSystem.files.get('/tmp/project/.claude/settings.json')
    ).toBe('{"statusLine":{"type":"command","command":"custom-status"}}\n');

    const statusWrites: string[] = [];
    const statusExitCode = runCli(
      ['claude', 'statusline', 'status'],
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
        pathEnv: '/opt/claude/bin',
        homeDir: '/tmp/home',
        cwd: '/tmp/project'
      })
    );

    expect(statusExitCode).toBe(1);
    expect(statusWrites.join('')).toContain('Status: foreign');
  });

  it('reports missing and installed project Claude statusline status states', () => {
    const launcherFileSystem = createLauncherFileSystem();
    const missingWrites: string[] = [];
    const missingExitCode = runCli(
      ['claude', 'statusline', 'status'],
      {
        stdout: {
          write(text: string) {
            missingWrites.push(text);
          }
        },
        stderr: { write() {} }
      },
      createLauncherCliEnvironment({
        launcherFileSystem,
        pathEnv: '/opt/claude/bin',
        homeDir: '/tmp/home',
        cwd: '/tmp/project'
      })
    );

    expect(missingExitCode).toBe(0);
    expect(missingWrites.join('')).toContain('Status: missing');

    launcherFileSystem.files.set(
      '/tmp/project/.claude/settings.json',
      `${JSON.stringify({
        statusLine: {
          type: 'command',
          command: TEAMEM_STATUSLINE_COMMAND
        }
      })}\n`
    );
    const installedWrites: string[] = [];
    const installedExitCode = runCli(
      ['claude', 'statusline', 'status'],
      {
        stdout: {
          write(text: string) {
            installedWrites.push(text);
          }
        },
        stderr: { write() {} }
      },
      createLauncherCliEnvironment({
        launcherFileSystem,
        pathEnv: '/opt/claude/bin',
        homeDir: '/tmp/home',
        cwd: '/tmp/project'
      })
    );

    expect(installedExitCode).toBe(0);
    expect(installedWrites.join('')).toContain('Status: installed');
  });

  it('reports selected installation separately from effective Claude settings precedence', () => {
    const launcherFileSystem = createLauncherFileSystem({
      files: {
        '/tmp/home/.claude/settings.json': `${JSON.stringify({
          statusLine: {
            type: 'command',
            command: TEAMEM_STATUSLINE_COMMAND
          }
        })}\n`,
        '/tmp/project/.claude/settings.json':
          '{"statusLine":{"type":"command","command":"project-status"}}\n'
      }
    });
    const writes: string[] = [];

    const exitCode = runCli(
      ['claude', 'statusline', 'status', '--scope', 'user'],
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
        homeDir: '/tmp/home',
        cwd: '/tmp/project'
      })
    );

    expect(exitCode).toBe(1);
    expect(writes.join('')).toContain('Status: installed');
    expect(writes.join('')).toContain('Scope: user');
    expect(writes.join('')).toContain('Effective: no');
    expect(writes.join('')).toContain('Selected effective: no');
    expect(writes.join('')).toContain('Effective scope: project');
    expect(writes.join('')).toContain(
      'installed-but-overridden: project scope overrides selected user scope.'
    );
    expect(writes.join('')).toContain(
      'Overriding scope: project contains a non-Teamem statusline.'
    );
  });

  it('reports selected Teamem statusline as overridden by higher-precedence Teamem settings', () => {
    const launcherFileSystem = createLauncherFileSystem({
      files: {
        '/tmp/home/.claude/settings.json': `${JSON.stringify({
          statusLine: {
            type: 'command',
            command: TEAMEM_STATUSLINE_COMMAND
          }
        })}\n`,
        '/tmp/project/.claude/settings.json': `${JSON.stringify({
          statusLine: {
            type: 'command',
            command: TEAMEM_STATUSLINE_COMMAND
          }
        })}\n`
      }
    });
    const writes: string[] = [];

    const exitCode = runCli(
      ['claude', 'statusline', 'status', '--scope', 'user'],
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
        homeDir: '/tmp/home',
        cwd: '/tmp/project'
      })
    );

    expect(exitCode).toBe(1);
    expect(writes.join('')).toContain('Status: installed');
    expect(writes.join('')).toContain('Scope: user');
    expect(writes.join('')).toContain('Selected effective: no');
    expect(writes.join('')).toContain('Effective scope: project');
    expect(writes.join('')).toContain(
      'installed-but-overridden: project scope overrides selected user scope.'
    );
  });

  it('uninstalls only the exact Teamem project statusline command', () => {
    const launcherFileSystem = createLauncherFileSystem({
      files: {
        '/tmp/project/.claude/settings.json': `${JSON.stringify(
          {
            permissions: { allow: ['Bash(git status:*)'] },
            statusLine: {
              type: 'command',
              command: TEAMEM_STATUSLINE_COMMAND
            }
          },
          null,
          2
        )}\n`
      }
    });

    const exitCode = runCli(
      ['claude', 'statusline', 'uninstall'],
      { stdout: { write() {} }, stderr: { write() {} } },
      createLauncherCliEnvironment({
        launcherFileSystem,
        pathEnv: '/opt/claude/bin',
        homeDir: '/tmp/home',
        cwd: '/tmp/project'
      })
    );

    expect(exitCode).toBe(0);
    expect(
      launcherFileSystem.files.get('/tmp/project/.claude/settings.json')
    ).toBe(
      `{\n  "permissions": {\n    "allow": [\n      "Bash(git status:*)"\n    ]\n  }\n}\n`
    );

    launcherFileSystem.files.set(
      '/tmp/project/.claude/settings.json',
      '{"statusLine":{"type":"command","command":"teamem claude statusline render --edited"}}\n'
    );
    const skipWrites: string[] = [];
    const skipExitCode = runCli(
      ['claude', 'statusline', 'uninstall'],
      {
        stdout: {
          write(text: string) {
            skipWrites.push(text);
          }
        },
        stderr: { write() {} }
      },
      createLauncherCliEnvironment({
        launcherFileSystem,
        pathEnv: '/opt/claude/bin',
        homeDir: '/tmp/home',
        cwd: '/tmp/project'
      })
    );

    expect(skipExitCode).toBe(0);
    expect(skipWrites.join('')).toContain('Skipped cleanup');
    expect(
      launcherFileSystem.files.get('/tmp/project/.claude/settings.json')
    ).toBe(
      '{"statusLine":{"type":"command","command":"teamem claude statusline render --edited"}}\n'
    );
  });

  it('uninstalls only the selected scope exact Teamem statusline setting', () => {
    const launcherFileSystem = createLauncherFileSystem({
      files: {
        '/tmp/home/.claude/settings.json': `${JSON.stringify({
          statusLine: {
            type: 'command',
            command: TEAMEM_STATUSLINE_COMMAND
          }
        })}\n`,
        '/tmp/project/.claude/settings.json':
          '{"statusLine":{"type":"command","command":"project-status"}}\n',
        '/tmp/project/.claude/settings.local.json':
          '{"statusLine":{"type":"command","command":"teamem claude statusline render --edited"}}\n'
      }
    });

    const exitCode = runCli(
      ['claude', 'statusline', 'uninstall', '--scope', 'user'],
      { stdout: { write() {} }, stderr: { write() {} } },
      createLauncherCliEnvironment({
        launcherFileSystem,
        pathEnv: '/opt/claude/bin',
        homeDir: '/tmp/home',
        cwd: '/tmp/project'
      })
    );

    expect(exitCode).toBe(0);
    expect(
      launcherFileSystem.files.get('/tmp/home/.claude/settings.json')
    ).toBe('{}\n');
    expect(
      launcherFileSystem.files.get('/tmp/project/.claude/settings.json')
    ).toBe('{"statusLine":{"type":"command","command":"project-status"}}\n');
    expect(
      launcherFileSystem.files.get('/tmp/project/.claude/settings.local.json')
    ).toBe(
      '{"statusLine":{"type":"command","command":"teamem claude statusline render --edited"}}\n'
    );
  });

  it('renders a compact fallback Claude statusline without stack traces', () => {
    expect(
      renderFallbackStatusline(
        '{"model":{"display_name":"Opus"},"workspace":{"current_dir":"/tmp/project"}}'
      )
    ).toBe(
      [
        colorStatusline('Teamem', ANSI_TEAMEM_BROWN),
        colorStatusline('Opus', ANSI_DIM_GRAY),
        colorStatusline('project', ANSI_DIM_GRAY)
      ].join(statuslineSeparator)
    );
    expect(
      renderFallbackStatusline(
        JSON.stringify({
          model: { display_name: 'Opus\n\u001b[31mred\u0007' },
          workspace: { current_dir: '/tmp/project\r\n\u001b[2J' }
        })
      )
    ).toBe(
      [
        colorStatusline('Teamem', ANSI_TEAMEM_BROWN),
        colorStatusline('Opus red', ANSI_DIM_GRAY),
        colorStatusline('project', ANSI_DIM_GRAY)
      ].join(statuslineSeparator)
    );
    expect(renderFallbackStatusline('{not json')).toBe(
      'Teamem | status unavailable'
    );
  });

  it('reads only fresh matching Teamem statusline display cache records', () => {
    const work = mkdtempSync(join(tmpdir(), 'teamem-statusline-cache-'));
    const cachePath = join(work, TEAMEM_STATUSLINE_CACHE_RELATIVE_PATH);
    mkdirSync(join(work, 'statusline'), { recursive: true });
    try {
      writeFileSync(
        cachePath,
        `${JSON.stringify({
          format_version: 1,
          updated_at: '2026-06-07T00:00:00.000Z',
          fresh_until: '2026-06-07T00:05:00.000Z',
          identity: {
            project_key: 'proj-1',
            session_id: 'sess-1',
            workspace_current_dir: '/tmp/project'
          },
          space: { id: 'space-1', label: 'Alpha' }
        })}\n`
      );

      expect(
        readStatuslineDisplayCache(
          { session_id: 'sess-1', workspace_current_dir: '/tmp/project' },
          {
            candidatePaths: [cachePath],
            now: new Date('2026-06-07T00:01:00.000Z')
          }
        )
      ).toEqual({ space: { id: 'space-1', label: 'Alpha' } });

      expect(
        readStatuslineDisplayCache(
          { session_id: 'other', workspace_current_dir: '/tmp/project' },
          {
            candidatePaths: [cachePath],
            now: new Date('2026-06-07T00:01:00.000Z')
          }
        )
      ).toEqual({});

      expect(
        readStatuslineDisplayCache(
          { session_id: 'sess-1', workspace_current_dir: '/tmp/project' },
          {
            candidatePaths: [cachePath],
            now: new Date('2026-06-07T00:06:00.000Z')
          }
        )
      ).toEqual({});
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('returns empty display state for malformed Teamem statusline cache records', () => {
    const work = mkdtempSync(join(tmpdir(), 'teamem-statusline-malformed-'));
    const cachePath = join(work, TEAMEM_STATUSLINE_CACHE_RELATIVE_PATH);
    mkdirSync(join(work, 'statusline'), { recursive: true });
    try {
      writeFileSync(cachePath, '{not json');
      expect(
        readStatuslineDisplayCache(
          { session_id: 'sess-1', workspace_current_dir: '/tmp/project' },
          {
            candidatePaths: [cachePath],
            now: new Date('2026-06-07T00:01:00.000Z')
          }
        )
      ).toEqual({});
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('renders Space and Claude context only from a fresh valid local cache', () => {
    const work = mkdtempSync(join(tmpdir(), 'teamem-statusline-render-'));
    const cachePath = join(work, TEAMEM_STATUSLINE_CACHE_RELATIVE_PATH);
    mkdirSync(join(work, 'statusline'), { recursive: true });
    try {
      writeFileSync(
        cachePath,
        `${JSON.stringify({
          format_version: 1,
          updated_at: '2026-06-07T00:00:00.000Z',
          fresh_until: '2026-06-07T00:05:00.000Z',
          identity: {
            session_id: 'sess-1',
            workspace_current_dir: '/tmp/project'
          },
          space: { id: 'space-1', label: 'Alpha' },
          monitor: { state: 'running' },
          run: { state: 'active' }
        })}\n`
      );

      expect(
        renderFallbackStatusline(
          JSON.stringify({
            session_id: 'sess-1',
            model: { display_name: 'Opus' },
            workspace: { current_dir: '/tmp/project' },
            context_window: { percent_available: 0.42 }
          }),
          {
            candidatePaths: [cachePath],
            now: new Date('2026-06-07T00:01:00.000Z')
          }
        )
      ).toBe(
        [
          colorStatusline('Teamem', ANSI_TEAMEM_BROWN),
          colorStatusline('Alpha', ANSI_SPACE_CYAN),
          colorStatusline('ctx 42%', ANSI_CONTEXT_GREEN),
          colorStatusline('Opus', ANSI_DIM_GRAY),
          colorStatusline('project', ANSI_DIM_GRAY)
        ].join(statuslineSeparator)
      );

      expect(
        renderFallbackStatusline(
          JSON.stringify({
            session_id: 'sess-1',
            model: { display_name: 'Opus' },
            workspace: { current_dir: '/tmp/project' }
          }),
          {
            candidatePaths: [cachePath],
            now: new Date('2026-06-07T00:06:00.000Z')
          }
        )
      ).toBe(
        [
          colorStatusline('Teamem', ANSI_TEAMEM_BROWN),
          colorStatusline('Opus', ANSI_DIM_GRAY),
          colorStatusline('project', ANSI_DIM_GRAY)
        ].join(statuslineSeparator)
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('renders ctx from the documented Claude statusline context fields', () => {
    expect(
      renderFallbackStatusline(
        JSON.stringify({
          cwd: '/current/working/directory',
          session_id: 'abc123',
          model: {
            id: 'claude-opus-4-8',
            display_name: 'Opus'
          },
          workspace: {
            current_dir: '/current/working/directory',
            project_dir: '/original/project/directory',
            added_dirs: []
          },
          context_window: {
            total_input_tokens: 15500,
            total_output_tokens: 1200,
            context_window_size: 200000,
            used_percentage: 8,
            remaining_percentage: 92,
            current_usage: {
              input_tokens: 8500,
              output_tokens: 1200,
              cache_creation_input_tokens: 5000,
              cache_read_input_tokens: 2000
            }
          }
        })
      )
    ).toBe(
      [
        colorStatusline('Teamem', ANSI_TEAMEM_BROWN),
        colorStatusline('ctx 8%', ANSI_CONTEXT_GREEN),
        colorStatusline('Opus', ANSI_DIM_GRAY),
        colorStatusline('directory', ANSI_DIM_GRAY)
      ].join(statuslineSeparator)
    );

    expect(
      renderFallbackStatusline(
        JSON.stringify({
          session_id: 'abc123',
          model: { display_name: 'Sonnet' },
          workspace: { current_dir: '/tmp/project' },
          context_window: {
            context_window_size: 200000,
            current_usage: {
              input_tokens: 8000,
              output_tokens: 100000,
              cache_creation_input_tokens: 2000,
              cache_read_input_tokens: 0
            }
          }
        })
      )
    ).toBe(
      [
        colorStatusline('Teamem', ANSI_TEAMEM_BROWN),
        colorStatusline('ctx 5%', ANSI_CONTEXT_GREEN),
        colorStatusline('Sonnet', ANSI_DIM_GRAY),
        colorStatusline('project', ANSI_DIM_GRAY)
      ].join(statuslineSeparator)
    );
  });

  it('renders representative Claude statusline output with Teamem-owned ANSI colors', () => {
    const work = mkdtempSync(join(tmpdir(), 'teamem-statusline-color-'));
    const cachePath = join(work, TEAMEM_STATUSLINE_CACHE_RELATIVE_PATH);
    mkdirSync(join(work, 'statusline'), { recursive: true });
    try {
      writeFileSync(
        cachePath,
        `${JSON.stringify({
          format_version: 1,
          updated_at: '2026-06-07T00:00:00.000Z',
          fresh_until: '2026-06-07T00:05:00.000Z',
          identity: {
            session_id: 'sess-color',
            workspace_current_dir: '/tmp/project'
          },
          space: { id: 'space-1', label: 'Alpha' },
          sprint: {
            sprint_id: 'sprint-1',
            display_name: 'Launch Week'
          }
        })}\n`
      );

      expect(
        renderClaudeStatusline(
          JSON.stringify({
            session_id: 'sess-color',
            model: { display_name: 'Opus' },
            workspace: { current_dir: '/tmp/project' },
            context_window: { used_percentage: 72 }
          }),
          {
            candidatePaths: [cachePath],
            now: new Date('2026-06-07T00:01:00.000Z')
          }
        )
      ).toBe(
        `${[
          colorStatusline('Teamem', ANSI_TEAMEM_BROWN),
          colorStatusline('Alpha', ANSI_SPACE_CYAN),
          `${colorStatusline('Sprint', ANSI_DIM_GRAY)} Launch Week`,
          colorStatusline('ctx 72%', ANSI_CONTEXT_YELLOW),
          colorStatusline('Opus', ANSI_DIM_GRAY),
          colorStatusline('project', ANSI_DIM_GRAY)
        ].join(statuslineSeparator)}\n`
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('colors ctx thresholds from official context_window.used_percentage values', () => {
    const renderCtx = (usedPercentage: number) =>
      renderFallbackStatusline(
        JSON.stringify({
          workspace: { current_dir: '/tmp/project' },
          context_window: { used_percentage: usedPercentage }
        }),
        { candidatePaths: [] }
      );

    expect(renderCtx(69)).toBe(
      [
        colorStatusline('Teamem', ANSI_TEAMEM_BROWN),
        colorStatusline('ctx 69%', ANSI_CONTEXT_GREEN),
        colorStatusline('project', ANSI_DIM_GRAY)
      ].join(statuslineSeparator)
    );
    expect(renderCtx(70)).toBe(
      [
        colorStatusline('Teamem', ANSI_TEAMEM_BROWN),
        colorStatusline('ctx 70%', ANSI_CONTEXT_YELLOW),
        colorStatusline('project', ANSI_DIM_GRAY)
      ].join(statuslineSeparator)
    );
    expect(renderCtx(89)).toBe(
      [
        colorStatusline('Teamem', ANSI_TEAMEM_BROWN),
        colorStatusline('ctx 89%', ANSI_CONTEXT_YELLOW),
        colorStatusline('project', ANSI_DIM_GRAY)
      ].join(statuslineSeparator)
    );
    expect(renderCtx(90)).toBe(
      [
        colorStatusline('Teamem', ANSI_TEAMEM_BROWN),
        colorStatusline('ctx 90%', ANSI_CONTEXT_RED),
        colorStatusline('project', ANSI_DIM_GRAY)
      ].join(statuslineSeparator)
    );
  });

  it('sanitizes dynamic ANSI and control text before applying Teamem colors', () => {
    const work = mkdtempSync(join(tmpdir(), 'teamem-statusline-inject-'));
    const cachePath = join(work, TEAMEM_STATUSLINE_CACHE_RELATIVE_PATH);
    mkdirSync(join(work, 'statusline'), { recursive: true });
    try {
      writeFileSync(
        cachePath,
        `${JSON.stringify({
          format_version: 1,
          updated_at: '2026-06-07T00:00:00.000Z',
          fresh_until: '2026-06-07T00:05:00.000Z',
          identity: {
            session_id: 'sess-inject',
            workspace_current_dir: '/tmp/project'
          },
          space: { label: 'Alpha\u001b[31m red\u0007' },
          sprint: {
            display_name: 'Launch\u001b]0;owned\u0007 Week\nNext'
          }
        })}\n`
      );

      const rendered = renderFallbackStatusline(
        JSON.stringify({
          session_id: 'sess-inject',
          model: { display_name: 'Opus\u001b[31m red\u0007' },
          workspace: { current_dir: '/tmp/project\u001b[2J' },
          context_window: { used_percentage: 12 }
        }),
        {
          candidatePaths: [cachePath],
          now: new Date('2026-06-07T00:01:00.000Z')
        }
      );

      expect(rendered).toBe(
        [
          colorStatusline('Teamem', ANSI_TEAMEM_BROWN),
          colorStatusline('Alpha red', ANSI_SPACE_CYAN),
          `${colorStatusline('Sprint', ANSI_DIM_GRAY)} Launch Week Next`,
          colorStatusline('ctx 12%', ANSI_CONTEXT_GREEN),
          colorStatusline('Opus red', ANSI_DIM_GRAY),
          colorStatusline('project', ANSI_DIM_GRAY)
        ].join(statuslineSeparator)
      );
      expect(rendered).not.toContain('\x1b[31m');
      expect(rendered).not.toContain('\x1b[2J');
      expect(rendered).not.toContain('\x1b]0;owned');
      expect(rendered).not.toContain('\u0007');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('renders Sprint only from fresh matching Sprint-mode cache data', () => {
    const work = mkdtempSync(join(tmpdir(), 'teamem-statusline-sprint-'));
    const cachePath = join(work, TEAMEM_STATUSLINE_CACHE_RELATIVE_PATH);
    mkdirSync(join(work, 'statusline'), { recursive: true });
    const input = JSON.stringify({
      session_id: 'sess-sprint',
      model: { display_name: 'Opus' },
      workspace: { current_dir: '/tmp/project' }
    });
    const render = (now: string) =>
      renderFallbackStatusline(input, {
        candidatePaths: [cachePath],
        now: new Date(now)
      });
    try {
      writeFileSync(
        cachePath,
        `${JSON.stringify({
          format_version: 1,
          updated_at: '2026-06-07T00:00:00.000Z',
          fresh_until: '2026-06-07T00:05:00.000Z',
          identity: {
            session_id: 'sess-sprint',
            workspace_current_dir: '/tmp/project'
          },
          space: { id: 'space-1', label: 'Alpha' },
          sprint: {
            sprint_id: 'sprint-1',
            slug: 'launch-week',
            display_name: 'Launch Week'
          },
          monitor: { health: 'red', run_state: 'running' },
          run: { state: 'active', pid: 1234 }
        })}\n`
      );

      expect(render('2026-06-07T00:01:00.000Z')).toBe(
        [
          colorStatusline('Teamem', ANSI_TEAMEM_BROWN),
          colorStatusline('Alpha', ANSI_SPACE_CYAN),
          `${colorStatusline('Sprint', ANSI_DIM_GRAY)} Launch Week`,
          colorStatusline('Opus', ANSI_DIM_GRAY),
          colorStatusline('project', ANSI_DIM_GRAY)
        ].join(statuslineSeparator)
      );
      expect(render('2026-06-07T00:06:00.000Z')).toBe(
        [
          colorStatusline('Teamem', ANSI_TEAMEM_BROWN),
          colorStatusline('Opus', ANSI_DIM_GRAY),
          colorStatusline('project', ANSI_DIM_GRAY)
        ].join(statuslineSeparator)
      );

      writeFileSync(
        cachePath,
        `${JSON.stringify({
          format_version: 1,
          updated_at: '2026-06-07T00:00:00.000Z',
          fresh_until: '2026-06-07T00:05:00.000Z',
          identity: {
            session_id: 'other-session',
            workspace_current_dir: '/tmp/project'
          },
          space: { id: 'space-1', label: 'Alpha' },
          sprint: { display_name: 'Wrong Context' }
        })}\n`
      );
      expect(render('2026-06-07T00:01:00.000Z')).toBe(
        [
          colorStatusline('Teamem', ANSI_TEAMEM_BROWN),
          colorStatusline('Opus', ANSI_DIM_GRAY),
          colorStatusline('project', ANSI_DIM_GRAY)
        ].join(statuslineSeparator)
      );

      writeFileSync(
        cachePath,
        `${JSON.stringify({
          format_version: 1,
          updated_at: '2026-06-07T00:00:00.000Z',
          fresh_until: '2026-06-07T00:05:00.000Z',
          identity: {
            session_id: 'sess-sprint',
            workspace_current_dir: '/tmp/project'
          },
          space: { id: 'space-1', label: 'Alpha' },
          sprint: null
        })}\n`
      );
      expect(render('2026-06-07T00:01:00.000Z')).toBe(
        [
          colorStatusline('Teamem', ANSI_TEAMEM_BROWN),
          colorStatusline('Alpha', ANSI_SPACE_CYAN),
          colorStatusline('Opus', ANSI_DIM_GRAY),
          colorStatusline('project', ANSI_DIM_GRAY)
        ].join(statuslineSeparator)
      );

      writeFileSync(
        cachePath,
        `${JSON.stringify({
          format_version: 1,
          updated_at: '2026-06-07T00:00:00.000Z',
          fresh_until: '2026-06-07T00:05:00.000Z',
          identity: {
            session_id: 'sess-sprint',
            workspace_current_dir: '/tmp/project'
          },
          space: { id: 'space-1', label: 'Alpha' },
          sprint: { monitor_state: 'running' }
        })}\n`
      );
      expect(render('2026-06-07T00:01:00.000Z')).toBe(
        [
          colorStatusline('Teamem', ANSI_TEAMEM_BROWN),
          colorStatusline('Alpha', ANSI_SPACE_CYAN),
          colorStatusline('Opus', ANSI_DIM_GRAY),
          colorStatusline('project', ANSI_DIM_GRAY)
        ].join(statuslineSeparator)
      );

      writeFileSync(cachePath, '{not json');
      expect(render('2026-06-07T00:01:00.000Z')).toBe(
        [
          colorStatusline('Teamem', ANSI_TEAMEM_BROWN),
          colorStatusline('Opus', ANSI_DIM_GRAY),
          colorStatusline('project', ANSI_DIM_GRAY)
        ].join(statuslineSeparator)
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('renders safely without server or MCP access when cache is absent', () => {
    expect(
      renderClaudeStatusline(
        JSON.stringify({
          session_id: 'sess-no-cache',
          model: { display_name: 'Sonnet' },
          workspace: { current_dir: '/tmp/no-cache' },
          context: { percentage: 87 }
        }),
        { candidatePaths: [] }
      )
    ).toBe(
      `${[
        colorStatusline('Teamem', ANSI_TEAMEM_BROWN),
        colorStatusline('ctx 87%', ANSI_CONTEXT_YELLOW),
        colorStatusline('Sonnet', ANSI_DIM_GRAY),
        colorStatusline('no-cache', ANSI_DIM_GRAY)
      ].join(statuslineSeparator)}\n`
    );
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
          './commands/setup.md',
          './commands/status.md',
          './commands/briefing.md'
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
      'missing required command entry: ./commands/off.md'
    );
  });

  it('blocks Teamem launch when the installed Teamem plugin lacks SessionStart hook wiring', () => {
    const fileSystem = createInstalledLauncherFileSystem();
    fileSystem.files.set(
      '/plugins/teamem/hooks/hooks.json',
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: '*',
              hooks: [
                {
                  type: 'command',
                  command: 'bash "$CLAUDE_PLUGIN_ROOT"/scripts/gate-claim.sh'
                }
              ]
            }
          ]
        }
      })
    );
    const result = runTeamemReadinessFailure({
      launcherFileSystem: fileSystem
    });

    expect(result.exitCode).toBe(1);
    expect(result.invocations).toEqual([]);
    expect(result.stderr).toContain('plugin install is incomplete or stale');
    expect(result.stderr).toContain(
      'missing required SessionStart hook wiring for scripts/session-start.sh'
    );
  });

  it('blocks Teamem launch when SessionStart hook only mentions the script without invoking it', () => {
    const fileSystem = createInstalledLauncherFileSystem();
    fileSystem.files.set(
      '/plugins/teamem/hooks/hooks.json',
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              matcher: '*',
              hooks: [
                {
                  type: 'command',
                  command: 'echo scripts/session-start.sh'
                }
              ]
            }
          ]
        }
      })
    );
    const result = runTeamemReadinessFailure({
      launcherFileSystem: fileSystem
    });

    expect(result.exitCode).toBe(1);
    expect(result.invocations).toEqual([]);
    expect(result.stderr).toContain('plugin install is incomplete or stale');
    expect(result.stderr).toContain(
      'missing required SessionStart hook wiring for scripts/session-start.sh'
    );
  });

  it('blocks Teamem launch when the installed Teamem plugin lacks the SessionStart script', () => {
    const fileSystem = createInstalledLauncherFileSystem();
    fileSystem.files.delete('/plugins/teamem/scripts/session-start.sh');
    const result = runTeamemReadinessFailure({
      launcherFileSystem: fileSystem
    });

    expect(result.exitCode).toBe(1);
    expect(result.invocations).toEqual([]);
    expect(result.stderr).toContain('plugin install is incomplete or stale');
    expect(result.stderr).toContain(
      'Plugin SessionStart script is missing or unreadable'
    );
  });

  it('blocks Teamem launch when the installed Teamem plugin lacks teamem-flag', () => {
    const fileSystem = createInstalledLauncherFileSystem();
    fileSystem.executableFiles.delete('/plugins/teamem/bin/teamem-flag');
    const result = runTeamemReadinessFailure({
      launcherFileSystem: fileSystem
    });

    expect(result.exitCode).toBe(1);
    expect(result.invocations).toEqual([]);
    expect(result.stderr).toContain('plugin install is incomplete or stale');
    expect(result.stderr).toContain(
      'Plugin activation flag binary is missing or not executable'
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
    expect(message).toContain('then start Claude Code with normal `claude`');
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
      [
        'init',
        '--scope',
        'local',
        '--skip-git-hooks',
        '--skip-claude-statusline'
      ],
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
      ['init', '--dry-run', '--scope', 'local', '--install-claude-launcher'],
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
      ['init', '--dry-run', '--scope', 'local', '--skip-claude-launcher'],
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

  it('offers the Claude statusline after interactive init setup and installs on accepted choice', () => {
    const writes: string[] = [];
    const prompts: string[] = [];
    const launcherFileSystem = createLauncherFileSystem();

    const exitCode = runCli(
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
            writes.push(text);
          }
        },
        stderr: { write() {} }
      },
      createSuccessfulInitEnvironment({
        launcherFileSystem,
        pathEnv: '/opt/claude/bin',
        promptEnvironment: {
          isInteractive: () => true,
          prompt(message) {
            prompts.push(message);
            return '';
          }
        }
      })
    );

    expect(exitCode).toBe(0);
    expect(prompts).toEqual(['Install the Teamem Claude statusline? [Y/n]: ']);
    expect(
      launcherFileSystem.files.get('/tmp/project/.claude/settings.local.json')
    ).toContain(TEAMEM_STATUSLINE_COMMAND);
    expect(writes.join('')).toContain('Status: installed');
    expect(writes.join('')).toContain('Scope: local');
  });

  it('uses the prompted init scope when accepted statusline install writes settings', () => {
    const writes: string[] = [];
    const prompts: string[] = [];
    const launcherFileSystem = createLauncherFileSystem();
    const scopePrompter: ScopePrompter = () => 'local';

    const exitCode = runCli(
      ['init', '--skip-git-hooks', '--skip-claude-launcher'],
      {
        stdout: {
          write(text: string) {
            writes.push(text);
          }
        },
        stderr: { write() {} }
      },
      {
        ...createSuccessfulInitEnvironment({
          launcherFileSystem,
          pathEnv: '/opt/claude/bin',
          promptEnvironment: {
            isInteractive: () => true,
            prompt(message) {
              prompts.push(message);
              return '';
            }
          }
        }),
        scopePrompter
      }
    );

    expect(exitCode).toBe(0);
    expect(prompts).toEqual(['Install the Teamem Claude statusline? [Y/n]: ']);
    expect(writes.join('')).toContain('Selected plugin scope: local (prompt)');
    expect(
      launcherFileSystem.files.get('/tmp/project/.claude/settings.local.json')
    ).toContain(TEAMEM_STATUSLINE_COMMAND);
    expect(
      launcherFileSystem.files.get('/tmp/project/.claude/settings.json')
    ).toBeUndefined();
    expect(writes.join('')).toContain('Scope: local');
  });

  it('prints the later-enable hint exactly when the init statusline offer is declined', () => {
    const writes: string[] = [];
    const launcherFileSystem = createLauncherFileSystem();

    const exitCode = runCli(
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
            writes.push(text);
          }
        },
        stderr: { write() {} }
      },
      createSuccessfulInitEnvironment({
        launcherFileSystem,
        pathEnv: '/opt/claude/bin',
        promptEnvironment: {
          isInteractive: () => true,
          prompt() {
            return 'n';
          }
        }
      })
    );

    expect(exitCode).toBe(0);
    expect(launcherFileSystem.files.size).toBe(0);
    expect(writes.join('')).toContain(
      'You can enable the Teamem statusline later with: teamem claude statusline install\n'
    );
  });

  it('returns nonzero when the accepted statusline install reports a conflict', () => {
    const writes: string[] = [];
    const launcherFileSystem = createLauncherFileSystem({
      files: {
        '/tmp/project/.claude/settings.local.json':
          '{"statusLine":{"type":"command","command":"custom-status"}}\n'
      }
    });

    const exitCode = runCli(
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
            writes.push(text);
          }
        },
        stderr: { write() {} }
      },
      createSuccessfulInitEnvironment({
        launcherFileSystem,
        pathEnv: '/opt/claude/bin',
        promptEnvironment: {
          isInteractive: () => true,
          prompt() {
            return 'yes';
          }
        }
      })
    );

    expect(exitCode).toBe(1);
    expect(writes.join('')).toContain('Status: foreign');
    expect(writes.join('')).toContain(
      'ERROR: Refusing to overwrite a non-Teamem Claude statusline.'
    );
    expect(
      launcherFileSystem.files.get('/tmp/project/.claude/settings.local.json')
    ).toBe('{"statusLine":{"type":"command","command":"custom-status"}}\n');
  });

  it('skips Claude statusline install during non-interactive init by default or explicit skip', () => {
    const defaultWrites: string[] = [];
    const defaultFileSystem = createLauncherFileSystem();

    const defaultExitCode = runCli(
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
            defaultWrites.push(text);
          }
        },
        stderr: { write() {} }
      },
      createSuccessfulInitEnvironment({
        launcherFileSystem: defaultFileSystem,
        pathEnv: '/opt/claude/bin'
      })
    );

    expect(defaultExitCode).toBe(0);
    expect(defaultFileSystem.files.size).toBe(0);
    expect(defaultWrites.join('')).toContain(
      'Claude statusline was not installed because this session is non-interactive'
    );

    const skipWrites: string[] = [];
    const skipFileSystem = createLauncherFileSystem();
    const skipExitCode = runCli(
      [
        'init',
        '--scope',
        'local',
        '--skip-git-hooks',
        '--skip-claude-launcher',
        '--skip-claude-statusline'
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
        launcherFileSystem: skipFileSystem,
        pathEnv: '/opt/claude/bin'
      })
    );

    expect(skipExitCode).toBe(0);
    expect(skipFileSystem.files.size).toBe(0);
    expect(skipWrites.join('')).toContain(
      'Claude statusline skipped by --skip-claude-statusline.'
    );
    expect(skipWrites.join('')).not.toContain(
      'Claude statusline was not installed because this session is non-interactive'
    );
  });

  it('forces Claude statusline install during non-interactive init only with an explicit flag', () => {
    const launcherFileSystem = createLauncherFileSystem();

    const exitCode = runCli(
      [
        'init',
        '--scope',
        'local',
        '--skip-git-hooks',
        '--skip-claude-launcher',
        '--install-claude-statusline'
      ],
      { stdout: { write() {} }, stderr: { write() {} } },
      createSuccessfulInitEnvironment({
        launcherFileSystem,
        pathEnv: '/opt/claude/bin'
      })
    );

    expect(exitCode).toBe(0);
    expect(
      launcherFileSystem.files.get('/tmp/project/.claude/settings.local.json')
    ).toContain(TEAMEM_STATUSLINE_COMMAND);
  });

  it('returns nonzero when forced init statusline install reports a conflict', () => {
    const writes: string[] = [];
    const launcherFileSystem = createLauncherFileSystem({
      files: {
        '/tmp/project/.claude/settings.local.json':
          '{"statusLine":{"type":"command","command":"custom-status"}}\n'
      }
    });

    const exitCode = runCli(
      [
        'init',
        '--scope',
        'local',
        '--skip-git-hooks',
        '--skip-claude-launcher',
        '--install-claude-statusline'
      ],
      {
        stdout: {
          write(text: string) {
            writes.push(text);
          }
        },
        stderr: { write() {} }
      },
      createSuccessfulInitEnvironment({
        launcherFileSystem,
        pathEnv: '/opt/claude/bin'
      })
    );

    expect(exitCode).toBe(1);
    expect(writes.join('')).toContain('Status: foreign');
    expect(writes.join('')).toContain(
      'ERROR: Refusing to overwrite a non-Teamem Claude statusline.'
    );
    expect(
      launcherFileSystem.files.get('/tmp/project/.claude/settings.local.json')
    ).toBe('{"statusLine":{"type":"command","command":"custom-status"}}\n');
  });

  it('reports init Claude statusline dry-run offer, force, and skip without writing settings', () => {
    const offerWrites: string[] = [];
    const offerFileSystem = createLauncherFileSystem();
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
      'Claude statusline: would be offered after setup in an interactive init'
    );

    const forcedWrites: string[] = [];
    const forcedFileSystem = createLauncherFileSystem();
    const forcedExitCode = runCli(
      ['init', '--dry-run', '--scope', 'local', '--install-claude-statusline'],
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
      'Claude statusline: forced by --install-claude-statusline'
    );

    const skippedWrites: string[] = [];
    const skippedFileSystem = createLauncherFileSystem();
    const skippedExitCode = runCli(
      ['init', '--dry-run', '--scope', 'local', '--skip-claude-statusline'],
      {
        stdout: {
          write(text: string) {
            skippedWrites.push(text);
          }
        },
        stderr: { write() {} }
      },
      createSuccessfulInitEnvironment({
        launcherFileSystem: skippedFileSystem,
        pathEnv: '/opt/claude/bin'
      })
    );

    expect(skippedExitCode).toBe(0);
    expect(skippedFileSystem.files.size).toBe(0);
    expect(skippedWrites.join('')).toContain(
      'Claude statusline: skipped by --skip-claude-statusline'
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

  it('renders statusline fallback through the package bin entry', () => {
    const result = spawnSync(
      'bun',
      ['run', BIN_PATH, 'claude', 'statusline', 'render'],
      {
        cwd: PACKAGE_ROOT,
        encoding: 'utf8',
        input: '{not json'
      }
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('Teamem | status unavailable\n');
    expect(result.stderr).not.toContain('Error');
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

function createDevCliEnvironment(
  options: {
    readonly devProfileFileSystem?: DevProfileFileSystem;
    readonly devSourceFileSystem?: DevSourceFileSystem;
    readonly commandRunner?: CommandRunner;
    readonly cwd?: string;
    readonly pathEnv?: string;
    readonly homeDir?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly now?: () => Date;
    readonly devSetupRunner?: DevSetupRunner;
    readonly devClaudeProcessRunner?: DevClaudeProcessRunner;
    readonly devCredentialsReader?: DevCredentialsReader;
    readonly devServerHealthChecker?: DevServerHealthChecker;
    readonly devBundleFreshnessChecker?: DevBundleFreshnessChecker;
    readonly devPluginBuilder?: DevPluginBuilder;
    readonly devProfileActiveSessionDetector?: DevProfileActiveSessionDetector;
    readonly gitHookInstaller?: GitHookInstaller;
    readonly gitHookPrompter?: GitHookPrompter;
    readonly promptEnvironment?: {
      readonly isInteractive?: () => boolean;
      readonly prompt?: (message: string) => string | null;
    };
  } = {}
): CliEnvironment {
  const cwd = options.cwd ?? '/src/teamem';
  return {
    prerequisites: {
      platform: 'linux',
      cwd,
      commandRunner:
        options.commandRunner ??
        createDevSourceCommandRunner({
          sourceRoot: '/src/teamem'
        })
    },
    homeDir: options.homeDir,
    pathEnv: options.pathEnv ?? '/tmp/home/.teamem/bin:/opt/claude/bin',
    env: options.env,
    now: options.now,
    promptEnvironment: options.promptEnvironment,
    devProfileFileSystem:
      options.devProfileFileSystem ?? createDevProfileFileSystem(),
    devSourceFileSystem:
      options.devSourceFileSystem ??
      createDevSourceFileSystem({
        roots: ['/src/teamem'],
        executableFiles: [
          '/tmp/home/.teamem/bin/claude',
          '/opt/claude/bin/claude'
        ]
      }),
    devSetupRunner: options.devSetupRunner ?? createDevSetupRunnerStub(),
    devClaudeProcessRunner:
      options.devClaudeProcessRunner ?? createDevClaudeLaunchRecorder(),
    devCredentialsReader:
      options.devCredentialsReader ?? createDevCredentialsReaderStub(),
    devServerHealthChecker:
      options.devServerHealthChecker ?? createDevServerHealthCheckerStub(),
    devBundleFreshnessChecker:
      options.devBundleFreshnessChecker ??
      createDevBundleFreshnessCheckerStub(),
    devPluginBuilder: options.devPluginBuilder ?? createDevPluginBuilderStub(),
    devProfileActiveSessionDetector:
      options.devProfileActiveSessionDetector ??
      createDevProfileActiveSessionDetectorStub({ status: 'inactive' }),
    gitHookInstaller: options.gitHookInstaller,
    gitHookPrompter: options.gitHookPrompter
  };
}

function createDevSourceFileSystem(
  options: {
    readonly roots?: readonly string[];
    readonly executableFiles?: readonly string[];
    readonly includePluginManifest?: boolean;
    readonly includePluginMcp?: boolean;
    readonly includeChannel?: boolean;
  } = {}
): DevSourceFileSystem & {
  readonly directories: Set<string>;
  readonly files: Map<string, string>;
  readonly executableFiles: Set<string>;
} {
  const directories = new Set<string>();
  const files = new Map<string, string>();
  const executableFiles = new Set(options.executableFiles ?? []);

  for (const root of options.roots ?? []) {
    addDirectory(directories, root);
    addFile(
      directories,
      files,
      `${root}/package.json`,
      '{"name":"teamem","private":true}\n'
    );
    if (options.includePluginManifest !== false) {
      addFile(
        directories,
        files,
        `${root}/plugin/.claude-plugin/plugin.json`,
        '{"name":"teamem","mcpServers":"./.mcp.json"}\n'
      );
    }
    if (options.includePluginMcp !== false) {
      addFile(
        directories,
        files,
        `${root}/plugin/.mcp.json`,
        JSON.stringify({
          mcpServers: {
            teamem: {
              command: 'bun',
              args: ['run', '${CLAUDE_PLUGIN_ROOT}/lib/bridge.js']
            },
            ...(options.includeChannel === false
              ? {}
              : {
                  'teamem-channel': {
                    command: 'bun',
                    args: ['run', '${CLAUDE_PLUGIN_ROOT}/lib/channel.js']
                  }
                })
          }
        })
      );
    }
    addFile(
      directories,
      files,
      `${root}/plugin/lib/setup.js`,
      'console.log("setup");\n'
    );
  }

  return {
    directories,
    files,
    executableFiles,
    exists(path: string): boolean {
      return (
        directories.has(path) || files.has(path) || executableFiles.has(path)
      );
    },
    isDirectory(path: string): boolean {
      return directories.has(path);
    },
    isReadableFile(path: string): boolean {
      return files.has(path);
    },
    isExecutableFile(path: string): boolean {
      return executableFiles.has(path);
    },
    readFile(path: string): string {
      const value = files.get(path);
      if (value === undefined) {
        throw new Error(`Missing file: ${path}`);
      }
      return value;
    },
    writeFile(path: string, content: string): void {
      addFile(directories, files, path, content);
    }
  };
}

function addFile(
  directories: Set<string>,
  files: Map<string, string>,
  path: string,
  content: string
): void {
  addDirectory(directories, path.slice(0, path.lastIndexOf('/')));
  files.set(path, content);
}

function addDirectory(directories: Set<string>, path: string): void {
  const parts = path.split('/').filter(Boolean);
  let current = path.startsWith('/') ? '' : '.';
  for (const part of parts) {
    current = current === '' ? `/${part}` : `${current}/${part}`;
    directories.add(current);
  }
}

function createDevSourceCommandRunner(options: {
  readonly sourceRoot: string;
  readonly bun?: CommandProbeResult;
  readonly dirtyStatus?: string;
  readonly insideGitRepository?: boolean;
}): CommandRunner {
  return {
    run(command: string, args: readonly string[]): CommandProbeResult {
      const key = `${command} ${args.join(' ')}`;
      if (key === 'bun --version') {
        return options.bun ?? ok('1.2.0\n');
      }
      if (key === `git -C ${options.sourceRoot} branch --show-current`) {
        return ok('master\n');
      }
      if (key === `git -C ${options.sourceRoot} status --short`) {
        return ok(options.dirtyStatus ?? '');
      }
      if (key === 'git rev-parse --is-inside-work-tree') {
        return options.insideGitRepository === false ? fail('') : ok('true\n');
      }
      return createFakeRunner({}).run(command, args);
    }
  };
}

function createDevProfileFileSystem(
  options: {
    readonly directories?: readonly string[];
    readonly files?: readonly string[];
  } = {}
): DevProfileFileSystem & {
  readonly directories: string[];
  readonly files: Map<string, string>;
  readonly mkdirCalls: string[];
  readonly writeFileCalls: string[];
  readonly removeDirectoryCalls: string[];
} {
  const directories = expandParentDirectories(options.directories ?? []);
  const files = new Map((options.files ?? []).map((path) => [path, '']));
  const mkdirCalls: string[] = [];
  const writeFileCalls: string[] = [];
  const removeDirectoryCalls: string[] = [];

  return {
    directories,
    files,
    mkdirCalls,
    writeFileCalls,
    removeDirectoryCalls,
    exists(path: string): boolean {
      return directories.includes(path) || files.has(path);
    },
    isDirectory(path: string): boolean {
      return directories.includes(path);
    },
    readDirectory(path: string): readonly string[] {
      const prefix = `${path}/`;
      return [
        ...new Set(
          [...directories, ...files.keys()]
            .filter((entry) => entry.startsWith(prefix))
            .map((entry) => entry.slice(prefix.length).split('/')[0] ?? '')
            .filter(Boolean)
        )
      ];
    },
    mkdir(path: string): void {
      mkdirCalls.push(path);
      if (!directories.includes(path)) {
        directories.push(path);
      }
    },
    writeFile(path: string, content: string): void {
      writeFileCalls.push(path);
      files.set(path, content);
    },
    removeDirectory(path: string): void {
      removeDirectoryCalls.push(path);
      const prefix = `${path}/`;
      for (let index = directories.length - 1; index >= 0; index -= 1) {
        if (
          directories[index] === path ||
          directories[index].startsWith(prefix)
        ) {
          directories.splice(index, 1);
        }
      }
      for (const filePath of [...files.keys()]) {
        if (filePath === path || filePath.startsWith(prefix)) {
          files.delete(filePath);
        }
      }
    }
  };
}

function expandParentDirectories(paths: readonly string[]): string[] {
  const directories = new Set<string>();
  for (const path of paths) {
    const parts = path.split('/').filter(Boolean);
    let current = path.startsWith('/') ? '' : '.';
    for (const part of parts) {
      current = current === '' ? `/${part}` : `${current}/${part}`;
      directories.add(current);
    }
  }
  return [...directories];
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

function createDevSetupRunnerStub(exitCode = 0): DevSetupRunner & {
  invocations: Parameters<DevSetupRunner['run']>[0][];
} {
  const invocations: Parameters<DevSetupRunner['run']>[0][] = [];
  return {
    invocations,
    run(invocation: Parameters<DevSetupRunner['run']>[0]) {
      invocations.push(invocation);
      return exitCode === 0
        ? {
            ok: true,
            exitCode,
            message: 'Profile-scoped Teamem setup completed.'
          }
        : {
            ok: false,
            exitCode,
            message: `Profile-scoped Teamem setup exited with code ${exitCode}.`
          };
    }
  };
}

function createDevCredentialsReaderStub(
  content: string | null = createCredentialsJson()
): DevCredentialsReader {
  return {
    read() {
      return content;
    }
  };
}

function createDevProfileActiveSessionDetectorStub(
  status: ReturnType<DevProfileActiveSessionDetector['check']>
): DevProfileActiveSessionDetector {
  return {
    check() {
      return status;
    }
  };
}

function createDevServerHealthCheckerStub(
  okResult = true
): DevServerHealthChecker & { checkedUrls: string[] } {
  const checkedUrls: string[] = [];
  return {
    checkedUrls,
    check(url: string) {
      const checkedUrl = `${url.replace(/\/+$/, '')}/health`;
      checkedUrls.push(checkedUrl);
      return okResult
        ? { ok: true, checkedUrl }
        : { ok: false, checkedUrl, message: 'connection refused' };
    }
  };
}

function createFreshBundleReport(): DevBundleFreshnessReport {
  return {
    ok: true,
    bundles: [
      {
        label: 'bridge',
        committedPath: '/src/teamem/plugin/lib/bridge.js',
        status: 'fresh'
      },
      {
        label: 'setup',
        committedPath: '/src/teamem/plugin/lib/setup.js',
        status: 'fresh'
      },
      {
        label: 'channel',
        committedPath: '/src/teamem/plugin/lib/channel.js',
        status: 'fresh'
      }
    ]
  };
}

function createStaleBundleReport(
  status: 'stale' | 'missing' = 'stale'
): DevBundleFreshnessReport {
  return {
    ok: false,
    bundles: [
      {
        label: 'bridge',
        committedPath: '/src/teamem/plugin/lib/bridge.js',
        status
      }
    ]
  };
}

function createDevBundleFreshnessCheckerStub(
  reports: readonly DevBundleFreshnessReport[] = [createFreshBundleReport()]
): DevBundleFreshnessChecker & { checks: string[] } {
  const checks: string[] = [];
  let index = 0;
  return {
    checks,
    check(source) {
      checks.push(source.teamemRoot);
      const report = reports[Math.min(index, reports.length - 1)];
      index += 1;
      return report;
    }
  };
}

function createDevPluginBuilderStub(
  exitCode = 0
): DevPluginBuilder & { builds: string[] } {
  const builds: string[] = [];
  return {
    builds,
    build(source) {
      builds.push(source.teamemRoot);
      return exitCode === 0
        ? {
            ok: true,
            message: 'Plugin bundles rebuilt with `bun run build:plugin`.'
          }
        : {
            ok: false,
            exitCode,
            message: `Plugin bundle build failed with exit code ${exitCode}.`
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
  invocations: Parameters<GitHookInstaller['install']>[0][];
} {
  const invocations: Parameters<GitHookInstaller['install']>[0][] = [];
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
  readonly promptEnvironment?: CliEnvironment['promptEnvironment'];
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
    ...(options.promptEnvironment
      ? { promptEnvironment: options.promptEnvironment }
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
    executableFiles: [
      '/tmp/home/.teamem/bin/claude',
      '/opt/claude/bin/claude',
      '/plugins/teamem/bin/teamem-flag'
    ],
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
          './commands/setup.md',
          './commands/off.md',
          './commands/status.md',
          './commands/briefing.md'
        ],
        skills: './skills/',
        mcpServers: './.mcp.json'
      }),
      '/plugins/teamem/commands/setup.md':
        '---\ndescription: Setup Teamem\n---\n',
      '/plugins/teamem/commands/off.md':
        '---\ndescription: Deactivate Teamem\n---\n',
      '/plugins/teamem/commands/status.md':
        '---\ndescription: Check Teamem status\n---\n',
      '/plugins/teamem/commands/briefing.md':
        '---\ndescription: Fetch Teamem briefing\n---\n',
      '/plugins/teamem/hooks/hooks.json': JSON.stringify({
        hooks: {
          SessionStart: [
            {
              matcher: '*',
              hooks: [
                {
                  type: 'command',
                  command:
                    'bash "$CLAUDE_PLUGIN_ROOT"/scripts/session-start.sh',
                  timeout: 5
                }
              ]
            }
          ]
        }
      }),
      '/plugins/teamem/scripts/session-start.sh':
        '#!/usr/bin/env bash\n"$CLAUDE_PLUGIN_ROOT"/bin/teamem-flag enable\n',
      '/plugins/teamem/bin/teamem-flag': '#!/usr/bin/env bash\n'
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

function createDevClaudeLaunchRecorder(): DevClaudeProcessRunner & {
  readonly invocations: Array<{
    readonly command: string;
    readonly args: readonly string[];
    readonly env: NodeJS.ProcessEnv;
    readonly cwd: string;
  }>;
} {
  const invocations: Array<{
    readonly command: string;
    readonly args: readonly string[];
    readonly env: NodeJS.ProcessEnv;
    readonly cwd: string;
  }> = [];
  return {
    invocations,
    run(invocation) {
      invocations.push({
        command: invocation.command,
        args: [...invocation.args],
        env: { ...invocation.env },
        cwd: invocation.cwd
      });
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
