import {
  buildActionPlan,
  type ActionPlan,
  type BootstrapperCommand
} from './action-plan.js';
import {
  createNodeFileSystem,
  executeInitInstall,
  isPluginScope,
  renderInitExecutionReport,
  resolveScope,
  type InitExecutionEnvironment,
  type PluginScope
} from './plugin-installer.js';
import {
  createSystemCommandRunner,
  detectPrerequisites,
  type PrerequisiteEnvironment
} from './prerequisites.js';
import {
  createInteractiveGitHookPrompter,
  createGitHookInstaller,
  type GitHookInstaller,
  type GitHookPrompter
} from './git-hooks.js';
import {
  createSetupRunner,
  parseSetupSelection,
  type SetupCommandRunner
} from './setup-delegation.js';
import {
  createInteractiveScopePrompter,
  type ScopePrompter
} from './scope-prompt.js';
import {
  isInteractiveTerminal,
  promptWithRuntime,
  type RuntimePromptEnvironment
} from './runtime-prompt.js';
import {
  executePluginUpdate,
  renderUpdateExecutionReport,
  resolveUpdateScope
} from './update-executor.js';
import {
  createNodeLocalStateFileSystem,
  executeUninstall,
  renderUninstallExecutionReport,
  type LocalStateFileSystem
} from './uninstall-executor.js';
import {
  createNodeClaudeLauncherFileSystem,
  launchClaudeWithTeamemPolicy,
  getClaudeLauncherStatus,
  installClaudeLauncher,
  renderClaudeLauncherReport,
  uninstallClaudeLauncher,
  type ClaudeLaunchMode,
  type ClaudeLaunchProcessRunner,
  type ClaudeLauncherFileSystem
} from './claude-launcher.js';

export interface CliIo {
  readonly stdout: { write(text: string): void };
  readonly stderr: { write(text: string): void };
}

export interface CliEnvironment {
  readonly prerequisites: PrerequisiteEnvironment;
  readonly installer?: InitExecutionEnvironment;
  readonly scopePrompter?: ScopePrompter;
  readonly setupRunner?: SetupCommandRunner;
  readonly gitHookPrompter?: GitHookPrompter;
  readonly claudeLauncherPrompter?: ClaudeLauncherPrompter;
  readonly gitHookInstaller?: GitHookInstaller;
  readonly localStateFileSystem?: LocalStateFileSystem;
  readonly claudeLauncherFileSystem?: ClaudeLauncherFileSystem;
  readonly claudeLaunchProcessRunner?: ClaudeLaunchProcessRunner;
  readonly promptEnvironment?: import('./runtime-prompt.js').RuntimePromptEnvironment;
  readonly env?: NodeJS.ProcessEnv;
  readonly pathEnv?: string;
  readonly now?: () => Date;
  readonly homeDir?: string;
}

export interface SetupSelectionArgs {
  readonly flow?: 'create' | 'join';
  readonly serverUrl?: string;
  readonly memberName?: string;
  readonly spaceLabel?: string;
  readonly roomCode?: string;
}

export interface ParsedCliArgs {
  readonly command?: BootstrapperCommand;
  readonly dryRun: boolean;
  readonly help: boolean;
  readonly scope?: PluginScope;
  readonly claude?: {
    readonly lifecycleCommand: ClaudeLifecycleCommand;
    readonly launchMode?: ClaudeLaunchMode;
    readonly claudeArgs?: readonly string[];
  };
  readonly setup?: SetupSelectionArgs;
  readonly gitHooks?: 'install' | 'skip';
  readonly claudeLauncher?: 'install' | 'skip';
  readonly cc?: {
    readonly updateMode: LegacyCcUpdateMode;
    readonly claudeArgs: readonly string[];
  };
  readonly uninstall?: {
    readonly keepCredentials: boolean;
  };
}

export interface CliSuccess {
  readonly ok: true;
  readonly value: ParsedCliArgs;
}

export interface CliFailure {
  readonly ok: false;
  readonly error: string;
}

export type CliParseResult = CliSuccess | CliFailure;
export type ClaudeLifecycleCommand =
  | 'install'
  | 'status'
  | 'uninstall'
  | 'launch';
type LegacyCcUpdateMode = 'prompt' | 'always' | 'never';
type ClaudeLauncherPrompter = () => boolean;

const HELP_FLAGS = new Set(['--help', '-h']);
const DRY_RUN_FLAGS = new Set(['--dry-run', '-n']);
const COMMANDS = new Set<BootstrapperCommand>([
  'init',
  'cc',
  'claude',
  'update',
  'uninstall'
]);
const CLAUDE_LIFECYCLE_COMMANDS = new Set<ClaudeLifecycleCommand>([
  'install',
  'status',
  'uninstall',
  'launch'
]);

const CC_MIGRATION_MESSAGE =
  '`teamem cc` has been retired and no longer launches Claude Code.\n' +
  'Use `teamem claude install` to opt into the machine-local `claude` shim, ' +
  'then start Claude Code with normal `claude`. The shim prompts before ' +
  'starting Claude Code with Teamem and preserves a pure Claude Code path.\n';

export function parseCliArgs(argv: readonly string[]): CliParseResult {
  if (argv.length === 0) {
    return {
      ok: true,
      value: { help: true, dryRun: false }
    };
  }

  const [first, ...rest] = argv;
  if (first === 'help') {
    return {
      ok: true,
      value: { help: true, dryRun: false }
    };
  }

  if (HELP_FLAGS.has(first)) {
    return {
      ok: true,
      value: { help: true, dryRun: false }
    };
  }

  if (!COMMANDS.has(first as BootstrapperCommand)) {
    return {
      ok: false,
      error: `Unknown command: ${first}`
    };
  }

  let dryRun = false;
  let scope: PluginScope | undefined;
  let flow: 'create' | 'join' | undefined;
  let serverUrl: string | undefined;
  let memberName: string | undefined;
  let spaceLabel: string | undefined;
  let roomCode: string | undefined;
  let gitHooks: 'install' | 'skip' | undefined;
  let claudeLauncher: 'install' | 'skip' | undefined;
  let ccUpdateMode: LegacyCcUpdateMode = 'prompt';
  let ccClaudeArgs: string[] = [];
  let keepCredentials = false;
  let claudeLifecycleCommand: ClaudeLifecycleCommand | undefined;
  let claudeLaunchMode: ClaudeLaunchMode = 'prompt';
  let claudeLaunchArgs: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (HELP_FLAGS.has(arg)) {
      return {
        ok: true,
        value: {
          command: first as BootstrapperCommand,
          help: true,
          dryRun,
          scope
        }
      };
    }
    if (DRY_RUN_FLAGS.has(arg)) {
      dryRun = true;
      continue;
    }
    if (first === 'cc' && arg === '--') {
      ccClaudeArgs = rest.slice(index + 1);
      break;
    }
    if (first === 'claude') {
      if (claudeLifecycleCommand === 'launch' && arg === '--') {
        claudeLaunchArgs = rest.slice(index + 1);
        break;
      }
      if (
        !claudeLifecycleCommand &&
        CLAUDE_LIFECYCLE_COMMANDS.has(arg as ClaudeLifecycleCommand)
      ) {
        claudeLifecycleCommand = arg as ClaudeLifecycleCommand;
        continue;
      }
      if (claudeLifecycleCommand === 'launch') {
        if (arg === '--teamem') {
          if (claudeLaunchMode === 'pure') {
            return {
              ok: false,
              error: 'Choose only one Claude launch mode: --teamem or --pure'
            };
          }
          claudeLaunchMode = 'teamem';
          continue;
        }
        if (arg === '--pure') {
          if (claudeLaunchMode === 'teamem') {
            return {
              ok: false,
              error: 'Choose only one Claude launch mode: --teamem or --pure'
            };
          }
          claudeLaunchMode = 'pure';
          continue;
        }
      }
      return {
        ok: false,
        error: claudeLifecycleCommand
          ? `Unknown option for claude ${claudeLifecycleCommand}: ${arg}`
          : `Unknown teamem claude lifecycle command: ${arg}`
      };
    }
    if (arg === '--scope') {
      const candidate = rest[index + 1];
      if (!candidate || !isPluginScope(candidate)) {
        return {
          ok: false,
          error:
            'Invalid value for --scope. Expected one of: project, user, local'
        };
      }
      scope = candidate;
      index += 1;
      continue;
    }
    if (first === 'init') {
      if (arg === '--create') {
        if (flow === 'join') {
          return {
            ok: false,
            error: 'Choose only one setup flow: --create or --join'
          };
        }
        flow = 'create';
        continue;
      }
      if (arg === '--join') {
        if (flow === 'create') {
          return {
            ok: false,
            error: 'Choose only one setup flow: --create or --join'
          };
        }
        flow = 'join';
        continue;
      }
      if (arg === '--server-url') {
        const candidate = rest[index + 1];
        if (!candidate) {
          return {
            ok: false,
            error: 'Missing value for --server-url'
          };
        }
        serverUrl = candidate;
        index += 1;
        continue;
      }
      if (arg === '--member-name') {
        const candidate = rest[index + 1];
        if (!candidate) {
          return {
            ok: false,
            error: 'Missing value for --member-name'
          };
        }
        memberName = candidate;
        index += 1;
        continue;
      }
      if (arg === '--label') {
        const candidate = rest[index + 1];
        if (!candidate) {
          return {
            ok: false,
            error: 'Missing value for --label'
          };
        }
        spaceLabel = candidate;
        index += 1;
        continue;
      }
      if (arg === '--room-code') {
        const candidate = rest[index + 1];
        if (!candidate) {
          return {
            ok: false,
            error: 'Missing value for --room-code'
          };
        }
        roomCode = candidate;
        index += 1;
        continue;
      }
      if (arg === '--install-git-hooks') {
        if (gitHooks === 'skip') {
          return {
            ok: false,
            error:
              'Choose only one git hook mode: --install-git-hooks or --skip-git-hooks'
          };
        }
        gitHooks = 'install';
        continue;
      }
      if (arg === '--skip-git-hooks') {
        if (gitHooks === 'install') {
          return {
            ok: false,
            error:
              'Choose only one git hook mode: --install-git-hooks or --skip-git-hooks'
          };
        }
        gitHooks = 'skip';
        continue;
      }
      if (arg === '--install-claude-launcher') {
        if (claudeLauncher === 'skip') {
          return {
            ok: false,
            error:
              'Choose only one Claude launcher mode: --install-claude-launcher or --skip-claude-launcher'
          };
        }
        claudeLauncher = 'install';
        continue;
      }
      if (arg === '--skip-claude-launcher') {
        if (claudeLauncher === 'install') {
          return {
            ok: false,
            error:
              'Choose only one Claude launcher mode: --install-claude-launcher or --skip-claude-launcher'
          };
        }
        claudeLauncher = 'skip';
        continue;
      }
    }
    if (first === 'cc') {
      if (arg === '--update') {
        if (ccUpdateMode === 'never') {
          return {
            ok: false,
            error: 'Choose only one update mode: --update or --no-update'
          };
        }
        ccUpdateMode = 'always';
        continue;
      }
      if (arg === '--no-update') {
        if (ccUpdateMode === 'always') {
          return {
            ok: false,
            error: 'Choose only one update mode: --update or --no-update'
          };
        }
        ccUpdateMode = 'never';
        continue;
      }
    }
    if (first === 'uninstall') {
      if (arg === '--keep-credentials') {
        keepCredentials = true;
        continue;
      }
    }
    return {
      ok: false,
      error: `Unknown option for ${first}: ${arg}`
    };
  }

  if (first === 'claude' && !claudeLifecycleCommand) {
    return {
      ok: false,
      error:
        'Missing teamem claude lifecycle command. Expected one of: install, status, uninstall'
    };
  }

  return {
    ok: true,
    value: {
      command: first as BootstrapperCommand,
      dryRun,
      help: false,
      scope,
      gitHooks,
      claudeLauncher,
      cc:
        first === 'cc'
          ? {
              updateMode: ccUpdateMode,
              claudeArgs: ccClaudeArgs
            }
          : undefined,
      claude:
        first === 'claude' && claudeLifecycleCommand
          ? {
              lifecycleCommand: claudeLifecycleCommand,
              ...(claudeLifecycleCommand === 'launch'
                ? {
                    launchMode: claudeLaunchMode,
                    claudeArgs: claudeLaunchArgs
                  }
                : {})
            }
          : undefined,
      uninstall:
        first === 'uninstall'
          ? {
              keepCredentials
            }
          : undefined,
      setup: {
        flow,
        serverUrl,
        memberName,
        spaceLabel,
        roomCode
      }
    }
  };
}

export function renderHelp(): string {
  return `Usage:
  teamem <command> [options]

Commands:
  init      Diagnose prerequisites, install Teamem marketplace/plugin, then run Teamem setup
  claude install   Install or refresh the opt-in Teamem-aware Claude launcher lifecycle
  claude status    Report Teamem-aware Claude launcher status
  claude uninstall Remove Teamem-owned Claude launcher lifecycle files
  cc        Compatibility error; use the opt-in \`claude\` shim instead
  update    Refresh Teamem marketplace metadata and update the installed plugin
  uninstall Uninstall the Claude Code plugin, git hooks, and local Teamem state

Options:
  -n, --dry-run   Print the intended action plan without running commands
  --scope <scope> Select Claude Code plugin scope: project, user, or local
  --create        Run setup in non-interactive create mode after install
  --join          Run setup in non-interactive join mode after install
  --server-url    Setup server URL for non-interactive init setup
  --member-name   Setup member name for non-interactive init setup
  --label         Optional setup space label for --create
  --room-code     Setup room code for --join
  --keep-credentials For \`teamem uninstall\`, preserve ~/.teamem/credentials.json
  --install-git-hooks  Install Teamem git hooks after setup without prompting
  --skip-git-hooks     Skip Teamem git hook installation after setup
  --install-claude-launcher  Install Teamem-aware Claude launcher after setup without prompting
  --skip-claude-launcher     Skip Teamem-aware Claude launcher installation after setup
  -h, --help      Show help
`;
}

export function renderPlan(plan: ActionPlan): string {
  const header = [
    `teamem ${plan.command}`,
    plan.dryRun
      ? 'dry-run: no external commands will be executed'
      : 'action plan'
  ];

  const actions = plan.actions.map((action, index) => {
    const lines = [`${index + 1}. ${action.title}`, `   ${action.description}`];
    if (action.externalCommand) {
      lines.push(
        `   command: ${action.externalCommand.command} ${action.externalCommand.args.join(' ')}`
      );
    }
    return lines.join('\n');
  });

  return `${header.join('\n')}\n\n${actions.join('\n\n')}\n`;
}

export function runCli(
  argv: readonly string[],
  io: CliIo = { stdout: process.stdout, stderr: process.stderr },
  environment: CliEnvironment = {
    prerequisites: {
      platform: process.platform,
      cwd: process.cwd(),
      commandRunner: createSystemCommandRunner(process.cwd())
    }
  }
): number {
  const parsed = parseCliArgs(argv);
  if (!parsed.ok) {
    io.stderr.write(`${parsed.error}\n\n${renderHelp()}`);
    return 1;
  }

  if (parsed.value.help || !parsed.value.command) {
    io.stdout.write(renderHelp());
    return 0;
  }

  if (parsed.value.command === 'init') {
    const report = detectPrerequisites(environment.prerequisites);
    const gitRepositoryDiagnostic = report.diagnostics.find(
      (diagnostic) => diagnostic.id === 'git-repository'
    );
    const insideGitRepository = gitRepositoryDiagnostic?.severity === 'ok';

    if (parsed.value.scope === 'project' && !insideGitRepository) {
      const projectScopeReason =
        gitRepositoryDiagnostic?.summary ??
        'Repository context could not be verified.';
      io.stdout.write(
        renderInitExecutionReport(
          report,
          {
            ok: false,
            scope: { scope: 'project', source: 'flag' },
            commands: [],
            message: `Explicit project scope is unavailable here: ${projectScopeReason} Teamem did not attempt marketplace, plugin, setup, or git-hook actions.`
          },
          { dryRun: parsed.value.dryRun }
        )
      );
      return 1;
    }

    if (report.hasErrors) {
      io.stdout.write(
        renderInitExecutionReport(
          report,
          {
            ok: false,
            commands: [],
            message:
              'Blocking issues were found. Teamem did not attempt marketplace or plugin install actions.'
          },
          { dryRun: parsed.value.dryRun }
        )
      );
      return 1;
    }

    const installerEnvironment = environment.installer ?? {
      cwd: environment.prerequisites.cwd,
      commandRunner: environment.prerequisites.commandRunner,
      fileSystem: createNodeFileSystem()
    };
    const recommendedScope = resolveScope({
      ...installerEnvironment,
      requestedScope: parsed.value.scope,
      report
    });
    const shouldPromptForScope =
      !parsed.value.scope &&
      (environment.scopePrompter !== undefined ||
        (process.stdin.isTTY && process.stdout.isTTY));
    const resolvedScope = shouldPromptForScope
      ? (environment.scopePrompter ?? createInteractiveScopePrompter(io))({
          recommended: recommendedScope,
          report
        })
      : recommendedScope.scope;
    const execution = executeInitInstall({
      ...installerEnvironment,
      dryRun: parsed.value.dryRun,
      requestedScope: resolvedScope,
      report
    });
    const renderScope =
      execution.scope && !parsed.value.scope
        ? shouldPromptForScope
          ? ({ scope: resolvedScope, source: 'prompt' } as const)
          : recommendedScope
        : execution.scope;
    const executionToRender = renderScope
      ? { ...execution, scope: renderScope }
      : execution;
    io.stdout.write(
      renderInitExecutionReport(report, executionToRender, {
        dryRun: parsed.value.dryRun
      })
    );
    if (parsed.value.dryRun) {
      io.stdout.write(renderInitLauncherDryRun(parsed.value.claudeLauncher));
    }
    if (!execution.ok || parsed.value.dryRun) {
      return execution.ok ? 0 : 1;
    }

    const setupSelection = parseSetupSelection(parsed.value.setup);
    if (!setupSelection.ok) {
      io.stderr.write(`${setupSelection.error}\n`);
      return 1;
    }

    const setupRunner =
      environment.setupRunner ??
      createSetupRunner(resolvedScope, { cwd: installerEnvironment.cwd });
    const setupResult = setupRunner.run(setupSelection.value);
    if (!setupResult.ok) {
      io.stderr.write(`${setupResult.message}\n`);
      return setupResult.exitCode;
    }

    if (!insideGitRepository) {
      io.stdout.write(
        'Git hooks skipped: current directory is not inside a git repository.\n'
      );
    } else if (parsed.value.gitHooks === 'skip') {
      io.stdout.write('Git hooks skipped by --skip-git-hooks.\n');
    } else {
      const shouldPromptForGitHooks =
        parsed.value.gitHooks === undefined &&
        (environment.gitHookPrompter !== undefined ||
          (process.stdin.isTTY && process.stdout.isTTY));
      const shouldInstallGitHooks =
        parsed.value.gitHooks === 'install'
          ? true
          : shouldPromptForGitHooks
            ? (
                environment.gitHookPrompter ??
                createInteractiveGitHookPrompter(io)
              )({
                scope: resolvedScope
              })
            : false;

      if (!shouldInstallGitHooks) {
        io.stdout.write(
          parsed.value.gitHooks === undefined
            ? 'Git hooks were not installed because this session is non-interactive. Re-run `teamem init --install-git-hooks` to force install or `--skip-git-hooks` to silence this step.\n'
            : 'Git hooks skipped.\n'
        );
      } else {
        const gitHookInstaller =
          environment.gitHookInstaller ??
          createGitHookInstaller({
            cwd: installerEnvironment.cwd,
            commandRunner: installerEnvironment.commandRunner
          });
        const gitHookResult = gitHookInstaller.install({
          scope: resolvedScope
        });
        if (!gitHookResult.ok) {
          io.stderr.write(`${gitHookResult.message}\n`);
          return gitHookResult.exitCode;
        }
        io.stdout.write(`${gitHookResult.message}\n`);
      }
    }

    const launcherExitCode = runPostSetupClaudeLauncherStep({
      mode: parsed.value.claudeLauncher,
      io,
      environment
    });
    if (launcherExitCode !== 0) {
      return launcherExitCode;
    }
    return setupResult.exitCode;
  }

  const installerEnvironment = environment.installer ?? {
    cwd: environment.prerequisites.cwd,
    commandRunner: environment.prerequisites.commandRunner,
    fileSystem: createNodeFileSystem()
  };
  if (parsed.value.command === 'cc') {
    io.stderr.write(CC_MIGRATION_MESSAGE);
    return 1;
  }

  if (parsed.value.command === 'claude') {
    const lifecycleCommand = parsed.value.claude?.lifecycleCommand;
    if (!lifecycleCommand) {
      io.stderr.write(
        'Missing teamem claude lifecycle command. Expected one of: install, status, uninstall\n'
      );
      return 1;
    }
    if (lifecycleCommand === 'launch') {
      const result = launchClaudeWithTeamemPolicy({
        homeDir: environment.homeDir,
        pathEnv: environment.pathEnv,
        fileSystem:
          environment.claudeLauncherFileSystem ??
          createNodeClaudeLauncherFileSystem(),
        mode: parsed.value.claude?.launchMode ?? 'prompt',
        claudeArgs: parsed.value.claude?.claudeArgs ?? [],
        env: environment.env,
        readiness: environment.prerequisites,
        promptEnvironment: environment.promptEnvironment,
        processRunner: environment.claudeLaunchProcessRunner
      });
      if (!result.ok && result.command === 'claude') {
        io.stderr.write(`${result.message}\n`);
      }
      return result.exitCode;
    }
    const launcherEnvironment = {
      homeDir: environment.homeDir,
      pathEnv: environment.pathEnv,
      fileSystem:
        environment.claudeLauncherFileSystem ??
        createNodeClaudeLauncherFileSystem(),
      now: environment.now,
      dryRun: parsed.value.dryRun
    };
    const result =
      lifecycleCommand === 'install'
        ? installClaudeLauncher(launcherEnvironment)
        : lifecycleCommand === 'status'
          ? getClaudeLauncherStatus(launcherEnvironment)
          : uninstallClaudeLauncher(launcherEnvironment);
    io.stdout.write(renderClaudeLauncherReport(result));
    return result.ok ? 0 : 1;
  }

  if (parsed.value.command === 'uninstall') {
    const execution = executeUninstall({
      cwd: installerEnvironment.cwd,
      commandRunner: installerEnvironment.commandRunner,
      scopeFileSystem: installerEnvironment.fileSystem,
      localStateFileSystem:
        environment.localStateFileSystem ?? createNodeLocalStateFileSystem(),
      claudeLauncherFileSystem:
        environment.claudeLauncherFileSystem ??
        createNodeClaudeLauncherFileSystem(),
      gitHookInstaller:
        environment.gitHookInstaller ??
        createGitHookInstaller({
          cwd: installerEnvironment.cwd,
          commandRunner: installerEnvironment.commandRunner
        }),
      homeDir: environment.homeDir,
      pathEnv: environment.pathEnv,
      now: environment.now,
      dryRun: parsed.value.dryRun,
      requestedScope: parsed.value.scope,
      keepCredentials: parsed.value.uninstall?.keepCredentials ?? false
    });
    io.stdout.write(
      renderUninstallExecutionReport(execution, {
        dryRun: parsed.value.dryRun
      })
    );
    return execution.ok ? 0 : 1;
  }

  if (parsed.value.command === 'update') {
    if (parsed.value.dryRun) {
      const dryRunScope = resolveUpdateScope({
        ...installerEnvironment,
        requestedScope: parsed.value.scope
      });
      const plan = buildActionPlan({
        command: parsed.value.command,
        dryRun: true,
        scope: dryRunScope?.scope
      });
      io.stdout.write(renderPlan(plan));
      return 0;
    }

    const execution = executePluginUpdate({
      ...installerEnvironment,
      dryRun: false,
      requestedScope: parsed.value.scope
    });
    io.stdout.write(
      renderUpdateExecutionReport(execution, {
        dryRun: parsed.value.dryRun
      })
    );
    return execution.ok ? 0 : 1;
  }

  return 1;
}

function runPostSetupClaudeLauncherStep(options: {
  readonly mode?: 'install' | 'skip';
  readonly io: CliIo;
  readonly environment: CliEnvironment;
}): number {
  if (options.mode === 'skip') {
    options.io.stdout.write(
      'Claude launcher skipped by --skip-claude-launcher.\n'
    );
    return 0;
  }

  const shouldPrompt =
    options.mode === undefined &&
    (options.environment.claudeLauncherPrompter !== undefined ||
      isInteractiveTerminal(options.environment.promptEnvironment));
  const shouldInstall =
    options.mode === 'install'
      ? true
      : shouldPrompt
        ? (
            options.environment.claudeLauncherPrompter ??
            createInteractiveClaudeLauncherPrompter(options.io, {
              environment: options.environment.promptEnvironment
            })
          )()
        : false;

  if (!shouldInstall) {
    if (options.mode === undefined) {
      options.io.stdout.write(
        'Claude launcher was not installed because this session is non-interactive. Re-run `teamem init --install-claude-launcher` to force install or `--skip-claude-launcher` to silence this step.\n'
      );
    }
    return 0;
  }

  const result = installClaudeLauncher({
    homeDir: options.environment.homeDir,
    pathEnv: options.environment.pathEnv,
    fileSystem:
      options.environment.claudeLauncherFileSystem ??
      createNodeClaudeLauncherFileSystem(),
    now: options.environment.now,
    dryRun: false
  });
  options.io.stdout.write(renderClaudeLauncherReport(result));
  return result.ok ? 0 : 1;
}

function createInteractiveClaudeLauncherPrompter(
  io: CliIo,
  options: { readonly environment?: RuntimePromptEnvironment } = {}
): ClaudeLauncherPrompter {
  return () => {
    if (!isInteractiveTerminal(options.environment)) {
      return false;
    }

    while (true) {
      const answer = (
        promptWithRuntime(
          'Install the Teamem-aware Claude launcher? [Y/n]: ',
          options.environment
        ) ?? ''
      )
        .trim()
        .toLowerCase();
      if (answer.length === 0 || answer === 'y' || answer === 'yes') {
        return true;
      }
      if (answer === 'n' || answer === 'no') {
        return false;
      }
      io.stdout.write('Enter y, yes, n, no, or press Enter for yes.\n');
    }
  };
}

function renderInitLauncherDryRun(mode?: 'install' | 'skip'): string {
  if (mode === 'install') {
    return 'Claude launcher: forced by --install-claude-launcher; dry-run did not write launcher files.\n';
  }
  if (mode === 'skip') {
    return 'Claude launcher: skipped by --skip-claude-launcher; dry-run did not write launcher files.\n';
  }
  return 'Claude launcher: would be offered after setup in an interactive init; non-interactive init would skip unless --install-claude-launcher is provided.\n';
}
