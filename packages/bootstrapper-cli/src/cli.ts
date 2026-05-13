import {
  buildActionPlan,
  type ActionPlan,
  type BootstrapperCommand
} from './action-plan.js';
import {
  createInteractiveCcUpdatePrompter,
  executeCcLaunch,
  type CcUpdateMode,
  type CcUpdatePrompter,
  type ClaudeProcessLauncher
} from './cc-launcher.js';
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
  executePluginUpdate,
  renderUpdateExecutionReport,
  resolveUpdateScope
} from './update-executor.js';

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
  readonly gitHookInstaller?: GitHookInstaller;
  readonly ccUpdatePrompter?: CcUpdatePrompter;
  readonly claudeLauncher?: ClaudeProcessLauncher;
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
  readonly setup?: SetupSelectionArgs;
  readonly gitHooks?: 'install' | 'skip';
  readonly cc?: {
    readonly updateMode: CcUpdateMode;
    readonly claudeArgs: readonly string[];
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

const HELP_FLAGS = new Set(['--help', '-h']);
const DRY_RUN_FLAGS = new Set(['--dry-run', '-n']);
const COMMANDS = new Set<BootstrapperCommand>(['init', 'cc', 'update']);

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
  let ccUpdateMode: CcUpdateMode = 'prompt';
  let ccClaudeArgs: string[] = [];
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
    return {
      ok: false,
      error: `Unknown option for ${first}: ${arg}`
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
      cc:
        first === 'cc'
          ? {
              updateMode: ccUpdateMode,
              claudeArgs: ccClaudeArgs
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
  cc        Optionally update Teamem, then launch Claude Code with Teamem loaded
  update    Refresh Teamem marketplace metadata and update the installed plugin

Options:
  -n, --dry-run   Print the intended action plan without running commands
  --scope <scope> Select Claude Code plugin scope: project, user, or local
  --update        For \`teamem cc\`, update Teamem before launch without prompting
  --no-update     For \`teamem cc\`, skip the pre-launch update prompt and update step
  --              For \`teamem cc\`, pass remaining args through to \`claude\`
  --create        Run setup in non-interactive create mode after install
  --join          Run setup in non-interactive join mode after install
  --server-url    Setup server URL for non-interactive init setup
  --member-name   Setup member name for non-interactive init setup
  --label         Optional setup space label for --create
  --room-code     Setup room code for --join
  --install-git-hooks  Install Teamem git hooks after setup without prompting
  --skip-git-hooks     Skip Teamem git hook installation after setup
  -h, --help      Show help
`;
}

export function renderPlan(plan: ActionPlan): string {
  const header = [
    `teamem ${plan.command}`,
    plan.dryRun
      ? 'dry-run: no external commands will be executed'
      : 'plan-only placeholder: execution is not implemented in this slice'
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
      return setupResult.exitCode;
    }

    if (parsed.value.gitHooks === 'skip') {
      io.stdout.write('Git hooks skipped by --skip-git-hooks.\n');
      return setupResult.exitCode;
    }

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
      return setupResult.exitCode;
    }

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
    return setupResult.exitCode;
  }

  const installerEnvironment = environment.installer ?? {
    cwd: environment.prerequisites.cwd,
    commandRunner: environment.prerequisites.commandRunner,
    fileSystem: createNodeFileSystem()
  };
  if (parsed.value.command === 'cc') {
    if (parsed.value.dryRun) {
      const includeUpdateCheck = parsed.value.cc?.updateMode !== 'never';
      const dryRunScope = includeUpdateCheck
        ? resolveUpdateScope({
            ...installerEnvironment,
            requestedScope: parsed.value.scope
          })
        : undefined;
      const plan = buildActionPlan({
        command: parsed.value.command,
        dryRun: true,
        scope: dryRunScope?.scope,
        claudeArgs: parsed.value.cc?.claudeArgs,
        includeUpdateCheck
      });
      io.stdout.write(renderPlan(plan));
      return 0;
    }

    const execution = executeCcLaunch({
      ...installerEnvironment,
      dryRun: false,
      updateMode: parsed.value.cc?.updateMode ?? 'prompt',
      requestedScope: parsed.value.scope,
      claudeArgs: parsed.value.cc?.claudeArgs ?? [],
      updatePrompter:
        parsed.value.cc?.updateMode === 'prompt'
          ? (environment.ccUpdatePrompter ??
            createInteractiveCcUpdatePrompter(io))
          : undefined,
      claudeLauncher: environment.claudeLauncher
    });

    if (execution.updateAttempted && execution.update && !execution.update.ok) {
      io.stderr.write(
        `Warning: ${execution.update.message}\nContinuing to launch Claude Code with Teamem.\n`
      );
    }
    if (!execution.ok) {
      io.stderr.write(`${execution.message}\n`);
      return 1;
    }
    return 0;
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
