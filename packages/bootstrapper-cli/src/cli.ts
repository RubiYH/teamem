import { join } from 'node:path';

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
  type CommandRunner,
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
import {
  getClaudeStatuslineStatus,
  installClaudeStatusline,
  renderClaudeStatusline,
  renderClaudeStatuslineReport,
  uninstallClaudeStatusline,
  type ClaudeStatuslineCommand
} from './claude-statusline.js';
import {
  createNodeDevProfileActiveSessionDetector,
  createNodeDevProfileFileSystem,
  deleteDevProfile,
  getDevProfileNameError,
  listDevProfiles,
  renderDevProfileList,
  renderDevProfileStatus,
  selectDevProfile,
  validateDevProfileName,
  type DevProfilePaths,
  type DevProfileFileSystem,
  type DevProfileSelection,
  type DevProfileActiveSessionDetector
} from './dev-profiles.js';
import {
  createNodeDevSourceFileSystem,
  probeDevSourcePrerequisites,
  renderDevSourceProbeReport,
  type DevSourceFileSystem,
  type DevSourceResolution
} from './dev-source.js';
import {
  generateDevMcpConfig,
  type StrictMcpConfig
} from './dev-mcp-config.js';
import { createLocalDevSetupRunner, type DevSetupRunner } from './dev-setup.js';
import {
  buildDevLaunchPlan,
  createNodeDevClaudeProcessRunner,
  renderDevLaunchBoundarySummary,
  renderDevLaunchDryRun,
  type DevClaudeProcessRunner
} from './dev-launch.js';
import {
  createNodeDevBundleFreshnessChecker,
  createNodeDevCredentialsReader,
  createNodeDevPluginBuilder,
  createNodeDevServerHealthChecker,
  devServerHealthUrl,
  hasDevBundleFreshnessFailure,
  readDevProfileDefaultSpaceId,
  readDevProfileServerUrl,
  renderDevBundleFreshness,
  renderDevServerHealth,
  type DevBundleFreshnessChecker,
  type DevCredentialsReader,
  type DevPluginBuilder,
  type DevServerHealthChecker
} from './dev-preflight.js';

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
  readonly claudeStatuslinePrompter?: ClaudeStatuslinePrompter;
  readonly gitHookInstaller?: GitHookInstaller;
  readonly localStateFileSystem?: LocalStateFileSystem;
  readonly claudeLauncherFileSystem?: ClaudeLauncherFileSystem;
  readonly devProfileFileSystem?: DevProfileFileSystem;
  readonly devSourceFileSystem?: DevSourceFileSystem;
  readonly devSetupRunner?: DevSetupRunner;
  readonly devClaudeProcessRunner?: DevClaudeProcessRunner;
  readonly devCredentialsReader?: DevCredentialsReader;
  readonly devServerHealthChecker?: DevServerHealthChecker;
  readonly devBundleFreshnessChecker?: DevBundleFreshnessChecker;
  readonly devPluginBuilder?: DevPluginBuilder;
  readonly devProfileActiveSessionDetector?: DevProfileActiveSessionDetector;
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
    readonly statuslineCommand?: ClaudeStatuslineCommand;
    readonly launchMode?: ClaudeLaunchMode;
    readonly claudeArgs?: readonly string[];
  };
  readonly dev?: {
    readonly subcommand: DevSubcommand;
    readonly profile?: string;
    readonly teamemRoot?: string;
    readonly cwd?: string;
    readonly buildPlugin: boolean;
    readonly yes?: boolean;
    readonly force?: boolean;
    readonly claudeArgs?: readonly string[];
  };
  readonly setup?: SetupSelectionArgs;
  readonly gitHooks?: 'install' | 'skip';
  readonly claudeLauncher?: 'install' | 'skip';
  readonly claudeStatusline?: 'install' | 'skip';
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
  | 'statusline'
  | 'launch';
export type DevSubcommand = 'claude' | 'status' | 'delete';
type LegacyCcUpdateMode = 'prompt' | 'always' | 'never';
type ClaudeLauncherPrompter = () => boolean;
type ClaudeStatuslinePrompter = () => boolean;

const HELP_FLAGS = new Set(['--help', '-h']);
const DRY_RUN_FLAGS = new Set(['--dry-run', '-n']);
const COMMANDS = new Set<BootstrapperCommand>([
  'init',
  'cc',
  'claude',
  'dev',
  'update',
  'uninstall'
]);
const CLAUDE_LIFECYCLE_COMMANDS = new Set<ClaudeLifecycleCommand>([
  'install',
  'status',
  'uninstall',
  'statusline',
  'launch'
]);
const DEV_SUBCOMMANDS = new Set<DevSubcommand>(['claude', 'status', 'delete']);

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
  let claudeStatusline: 'install' | 'skip' | undefined;
  let ccUpdateMode: LegacyCcUpdateMode = 'prompt';
  let ccClaudeArgs: string[] = [];
  let keepCredentials = false;
  let claudeLifecycleCommand: ClaudeLifecycleCommand | undefined;
  let claudeStatuslineCommand: ClaudeStatuslineCommand | undefined;
  let claudeLaunchMode: ClaudeLaunchMode = 'prompt';
  let claudeLaunchArgs: string[] = [];
  let devSubcommand: DevSubcommand | undefined;
  let devProfile: string | undefined;
  let devTeamemRoot: string | undefined;
  let devCwd: string | undefined;
  let devBuildPlugin = false;
  let devYes = false;
  let devForce = false;
  let devClaudeArgs: string[] = [];
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
      if (claudeLifecycleCommand === 'statusline') {
        if (!claudeStatuslineCommand) {
          if (isClaudeStatuslineCommand(arg)) {
            claudeStatuslineCommand = arg;
            continue;
          }
          return {
            ok: false,
            error: `Unknown teamem claude statusline command: ${arg}. Expected one of: install, status, uninstall`
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
        return {
          ok: false,
          error: `Unknown option for claude statusline ${claudeStatuslineCommand}: ${arg}`
        };
      }
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
    if (first === 'dev') {
      if (!devSubcommand && DEV_SUBCOMMANDS.has(arg as DevSubcommand)) {
        devSubcommand = arg as DevSubcommand;
        continue;
      }
      if (!devSubcommand) {
        return {
          ok: false,
          error: `Unknown teamem dev subcommand: ${arg}. Expected one of: claude, status, delete`
        };
      }
      if (devSubcommand === 'claude' && arg === '--') {
        devClaudeArgs = rest.slice(index + 1);
        break;
      }
      if (arg === '--profile') {
        const candidate = rest[index + 1];
        if (!candidate) {
          return {
            ok: false,
            error: 'Missing value for --profile'
          };
        }
        const validation = validateDevProfileName(candidate);
        if (!validation.ok) {
          return {
            ok: false,
            error: `Invalid value for --profile. ${getDevProfileNameError()}`
          };
        }
        devProfile = validation.value;
        index += 1;
        continue;
      }
      if (arg === '--teamem-root') {
        const candidate = rest[index + 1];
        if (!candidate) {
          return {
            ok: false,
            error: 'Missing value for --teamem-root'
          };
        }
        devTeamemRoot = candidate;
        index += 1;
        continue;
      }
      if (arg === '--cwd') {
        const candidate = rest[index + 1];
        if (!candidate) {
          return {
            ok: false,
            error: 'Missing value for --cwd'
          };
        }
        devCwd = candidate;
        index += 1;
        continue;
      }
      if (devSubcommand === 'claude' && arg === '--install-git-hooks') {
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
      if (devSubcommand === 'claude' && arg === '--skip-git-hooks') {
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
      if (devSubcommand === 'claude' && arg === '--build-plugin') {
        devBuildPlugin = true;
        continue;
      }
      if (devSubcommand === 'delete' && arg === '--yes') {
        devYes = true;
        continue;
      }
      if (devSubcommand === 'delete' && arg === '--force') {
        devForce = true;
        continue;
      }
      return {
        ok: false,
        error: `Unknown option for dev ${devSubcommand}: ${arg}`
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
      if (arg === '--install-claude-statusline') {
        if (claudeStatusline === 'skip') {
          return {
            ok: false,
            error:
              'Choose only one Claude statusline mode: --install-claude-statusline or --skip-claude-statusline'
          };
        }
        claudeStatusline = 'install';
        continue;
      }
      if (arg === '--skip-claude-statusline') {
        if (claudeStatusline === 'install') {
          return {
            ok: false,
            error:
              'Choose only one Claude statusline mode: --install-claude-statusline or --skip-claude-statusline'
          };
        }
        claudeStatusline = 'skip';
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

  if (
    first === 'claude' &&
    claudeLifecycleCommand === 'statusline' &&
    !claudeStatuslineCommand
  ) {
    return {
      ok: false,
      error:
        'Missing teamem claude statusline command. Expected one of: install, status, uninstall'
    };
  }

  if (first === 'dev' && !devSubcommand) {
    return {
      ok: false,
      error:
        'Missing teamem dev subcommand. Expected one of: claude, status, delete'
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
      claudeStatusline,
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
              ...(claudeLifecycleCommand === 'statusline'
                ? { statuslineCommand: claudeStatuslineCommand }
                : {}),
              ...(claudeLifecycleCommand === 'launch'
                ? {
                    launchMode: claudeLaunchMode,
                    claudeArgs: claudeLaunchArgs
                  }
                : {})
            }
          : undefined,
      dev:
        first === 'dev' && devSubcommand
          ? {
              subcommand: devSubcommand,
              profile: devProfile,
              teamemRoot: devTeamemRoot,
              cwd: devCwd,
              buildPlugin: devBuildPlugin,
              ...(devSubcommand === 'delete'
                ? { yes: devYes, force: devForce }
                : {}),
              claudeArgs: devClaudeArgs
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
  claude statusline install   Install the opt-in Teamem Claude statusline
  claude statusline status    Report Teamem Claude statusline state and effective scope
  claude statusline uninstall Remove Teamem-owned Claude statusline settings
  dev claude       Select or create a durable Teamem dev profile skeleton
  dev status       List Teamem dev profiles or show profile-owned paths
  dev delete       Delete a selected Teamem dev profile capsule
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
  --profile <slug> Safe Teamem dev profile slug for \`teamem dev ...\`
  --teamem-root <path> Teamem source checkout for \`teamem dev ...\`
  --cwd <path> Claude launch repository for \`teamem dev ...\`
  --build-plugin Rebuild local plugin bundles before \`teamem dev claude\` launch checks
  --yes          Confirm non-interactive \`teamem dev delete\`
  --force        Allow \`teamem dev delete\` when a profiled Claude process is detected
  --install-git-hooks  Install Teamem git hooks after setup without prompting
  --skip-git-hooks     Skip Teamem git hook installation after setup
  --install-claude-launcher  Install Teamem-aware Claude launcher after setup without prompting
  --skip-claude-launcher     Skip Teamem-aware Claude launcher installation after setup
  --install-claude-statusline  Install Teamem Claude statusline after setup without prompting
  --skip-claude-statusline     Skip Teamem Claude statusline installation after setup
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
      io.stdout.write(
        renderInitStatuslineDryRun(parsed.value.claudeStatusline)
      );
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

    const gitHookExitCode = runPostSetupGitHookStep({
      mode: parsed.value.gitHooks,
      scope: resolvedScope,
      cwd: installerEnvironment.cwd,
      insideGitRepository,
      io,
      environment,
      commandRunner: installerEnvironment.commandRunner
    });
    if (gitHookExitCode !== 0) {
      return gitHookExitCode;
    }

    const launcherExitCode = runPostSetupClaudeLauncherStep({
      mode: parsed.value.claudeLauncher,
      io,
      environment
    });
    if (launcherExitCode !== 0) {
      return launcherExitCode;
    }
    const statuslineExitCode = runPostSetupClaudeStatuslineStep({
      mode: parsed.value.claudeStatusline,
      scope: resolvedScope,
      cwd: installerEnvironment.cwd,
      io,
      environment,
      commandRunner: installerEnvironment.commandRunner
    });
    if (statuslineExitCode !== 0) {
      return statuslineExitCode;
    }
    return setupResult.exitCode;
  }

  if (parsed.value.command === 'dev') {
    const devFileSystem =
      environment.devProfileFileSystem ?? createNodeDevProfileFileSystem();
    const devSourceFileSystem =
      environment.devSourceFileSystem ?? createNodeDevSourceFileSystem();
    const subcommand = parsed.value.dev?.subcommand;
    const profile = parsed.value.dev?.profile;
    if (!subcommand) {
      io.stderr.write(
        'Missing teamem dev subcommand. Expected one of: claude, status, delete\n'
      );
      return 1;
    }

    if (subcommand === 'status') {
      if (!profile) {
        io.stdout.write(
          renderDevProfileList(
            listDevProfiles({
              homeDir: environment.homeDir,
              fileSystem: devFileSystem
            })
          )
        );
        return 0;
      }
      const selection = selectDevProfile({
        homeDir: environment.homeDir,
        requestedProfile: profile,
        allowCreate: false,
        fileSystem: devFileSystem
      });
      if (!selection.ok) {
        io.stderr.write(
          `${selection.error}\nCreate the profile with \`teamem dev claude --profile ${profile}\` or choose an existing profile from \`teamem dev status\`.\n`
        );
        return 1;
      }
      const paths = selection.paths;
      const sourceReport = probeDevSourcePrerequisites({
        cwd: environment.prerequisites.cwd,
        requestedTeamemRoot: parsed.value.dev?.teamemRoot,
        requestedLaunchCwd: parsed.value.dev?.cwd,
        pathEnv: environment.pathEnv,
        homeDir: environment.homeDir,
        fileSystem: devSourceFileSystem,
        commandRunner: environment.prerequisites.commandRunner
      });
      io.stdout.write(
        [
          renderDevProfileStatusBoundary({
            paths,
            source: sourceReport.resolution,
            fileSystem: devFileSystem,
            credentialsReader:
              environment.devCredentialsReader ??
              createNodeDevCredentialsReader(),
            healthChecker:
              environment.devServerHealthChecker ??
              createNodeDevServerHealthChecker()
          }),
          renderDevSourceProbeReport(sourceReport, {
            dryRun: false
          }).trimEnd(),
          renderDevProfileStatusPreflight({
            paths,
            source: sourceReport.resolution,
            environment
          })
        ]
          .filter((line): line is string => line !== undefined)
          .join('\n') + '\n'
      );
      return 0;
    }

    if (subcommand === 'claude') {
      const canPrompt = isInteractiveTerminal(environment.promptEnvironment);
      const sourceReport = probeDevSourcePrerequisites({
        cwd: environment.prerequisites.cwd,
        requestedTeamemRoot: parsed.value.dev?.teamemRoot,
        requestedLaunchCwd: parsed.value.dev?.cwd,
        pathEnv: environment.pathEnv,
        homeDir: environment.homeDir,
        fileSystem: devSourceFileSystem,
        commandRunner: environment.prerequisites.commandRunner
      });
      if (sourceReport.hasErrors) {
        io.stdout.write(
          renderDevSourceProbeReport(sourceReport, {
            dryRun: parsed.value.dryRun
          })
        );
        return 1;
      }
      const sourceResolution = sourceReport.resolution;
      if (!sourceResolution) {
        io.stderr.write(
          'Teamem dev claude could not resolve the selected source checkout.\n'
        );
        return 1;
      }
      if (!profile && !canPrompt) {
        io.stderr.write(
          'Non-interactive `teamem dev claude` requires --profile.\n'
        );
        return 1;
      }
      if (parsed.value.dryRun) {
        const selection = profile
          ? selectDevProfile({
              homeDir: environment.homeDir,
              requestedProfile: profile,
              allowCreate: true,
              createMode: 'plan',
              fileSystem: devFileSystem
            })
          : selectDevProfile({
              homeDir: environment.homeDir,
              allowCreate: true,
              createMode: 'plan',
              fileSystem: devFileSystem,
              prompt: (message) =>
                promptWithRuntime(message, environment.promptEnvironment)
            });
        if (!selection.ok) {
          io.stderr.write(`${selection.error}\n`);
          return 1;
        }
        const paths = selection.paths;
        const mcpConfig = generateDevMcpConfig({
          source: sourceResolution,
          profile: paths,
          fileSystem: devSourceFileSystem
        });
        if (!mcpConfig.ok) {
          io.stderr.write(`${mcpConfig.error}\n`);
          return 1;
        }
        const credentialsReader =
          environment.devCredentialsReader ?? createNodeDevCredentialsReader();
        const serverUrl = readDevProfileServerUrl({
          profile: paths,
          credentialsReader
        });
        const defaultSpace = readDevProfileDefaultSpaceId({
          profile: paths,
          credentialsReader
        });
        const plannedHealthLine = serverUrl.ok
          ? `dry-run: server health would be checked at ${devServerHealthUrl(serverUrl.serverUrl)} before launch.`
          : `dry-run: server health would be checked after profile credentials exist at ${paths.credentialsPath}.`;
        const launchPlan = buildDevLaunchPlan({
          source: sourceResolution,
          profile: paths,
          claudeArgs: parsed.value.dev?.claudeArgs ?? [],
          env: environment.env,
          pathEnv: environment.pathEnv,
          homeDir: environment.homeDir,
          fileSystem: devSourceFileSystem,
          defaultSpaceId: defaultSpace.ok
            ? defaultSpace.defaultSpaceId
            : undefined
        });
        io.stdout.write(
          [
            renderPlan(buildActionPlan({ command: 'dev', dryRun: true })),
            renderDevSourceProbeReport(sourceReport, {
              dryRun: true
            }).trimEnd(),
            `Selected dev profile: ${paths.profileName}`,
            devFileSystem.exists(paths.profileRoot)
              ? 'dry-run: existing profile would be used without launching Claude Code.'
              : 'dry-run: profile skeleton would be created if the command runs without --dry-run.',
            devFileSystem.exists(paths.credentialsPath)
              ? 'dry-run: existing profile credentials would be reused; setup would not run.'
              : `dry-run: profile-scoped Teamem setup would run with TEAMEM_CREDENTIALS=${paths.credentialsPath}.`,
            `dry-run: profile MCP config would be written to ${paths.mcpConfigPath} from ${mcpConfig.declarationPath}.`,
            `dry-run: launch workspace MCP config would be written to ${devLaunchWorkspaceMcpConfigPath(sourceResolution)} with Teamem dev channel servers.`,
            parsed.value.dev?.buildPlugin
              ? 'dry-run: --build-plugin would run `bun run build:plugin` before launch planning continues.'
              : undefined,
            `dry-run: plugin bundle freshness would be checked for ${sourceResolution.teamemRoot} before launch.`,
            plannedHealthLine,
            renderDevProfileStatus(paths),
            renderDevLaunchDryRun(launchPlan).trimEnd()
          ]
            .filter((line): line is string => line !== undefined)
            .join('\n') + '\n'
        );
        return 0;
      }
      const selection = selectDevProfile({
        homeDir: environment.homeDir,
        requestedProfile: profile,
        allowCreate: true,
        fileSystem: devFileSystem,
        now: environment.now,
        prompt: profile
          ? undefined
          : (message) =>
              promptWithRuntime(message, environment.promptEnvironment)
      });
      if (!selection.ok) {
        io.stderr.write(`${selection.error}\n`);
        return 1;
      }
      const mcpConfig = generateDevMcpConfig({
        source: sourceResolution,
        profile: selection.paths,
        fileSystem: devSourceFileSystem
      });
      if (!mcpConfig.ok) {
        io.stderr.write(`${mcpConfig.error}\n`);
        return 1;
      }
      const bundleExitCode = ensureDevPluginBundles({
        source: sourceResolution,
        buildPlugin: parsed.value.dev?.buildPlugin ?? false,
        canPrompt,
        io,
        environment
      });
      if (bundleExitCode !== 0) {
        return bundleExitCode;
      }
      const setupStatus = ensureDevProfileCredentials({
        selection,
        source: sourceResolution,
        fileSystem: devFileSystem,
        setupRunner:
          environment.devSetupRunner ??
          createLocalDevSetupRunner({
            fileSystem: devSourceFileSystem,
            env: environment.env
          })
      });
      if (!setupStatus.ok) {
        io.stderr.write(`${setupStatus.message}\n`);
        return setupStatus.exitCode;
      }
      if (setupStatus.setupRan) {
        const gitHookExitCode = runPostSetupGitHookStep({
          mode: parsed.value.gitHooks,
          scope: 'local',
          cwd: sourceResolution.launchCwd,
          pluginRoot: sourceResolution.pluginRoot,
          insideGitRepository: isInsideGitRepositoryForCwd({
            cwd: sourceResolution.launchCwd,
            environment
          }),
          io,
          environment
        });
        if (gitHookExitCode !== 0) {
          return gitHookExitCode;
        }
      }
      const healthExitCode = ensureDevServerHealth({
        profile: selection.paths,
        io,
        environment
      });
      if (healthExitCode !== 0) {
        return healthExitCode;
      }
      devFileSystem.writeFile(selection.paths.mcpConfigPath, mcpConfig.json);
      const launchWorkspaceMcpConfig = materializeDevLaunchWorkspaceMcpConfig({
        source: sourceResolution,
        generatedConfig: mcpConfig.config,
        fileSystem: devSourceFileSystem
      });
      if (!launchWorkspaceMcpConfig.ok) {
        io.stderr.write(`${launchWorkspaceMcpConfig.error}\n`);
        return 1;
      }
      io.stdout.write(
        [
          `Selected dev profile: ${selection.profileName}`,
          selection.created ? 'Profile skeleton created.' : undefined,
          setupStatus.message,
          `Generated profile MCP config: ${selection.paths.mcpConfigPath}`,
          `Generated launch workspace MCP config: ${launchWorkspaceMcpConfig.path}`
        ]
          .filter((line): line is string => line !== undefined)
          .join('\n') + '\n'
      );
      io.stdout.write(
        [
          renderDevSourceProbeReport(sourceReport, {
            dryRun: false
          }).trimEnd(),
          renderDevProfileStatus(selection.paths)
        ]
          .filter((line): line is string => line !== undefined)
          .join('\n') + '\n'
      );
      const launchPlan = buildDevLaunchPlan({
        source: sourceResolution,
        profile: selection.paths,
        claudeArgs: parsed.value.dev?.claudeArgs ?? [],
        env: environment.env,
        pathEnv: environment.pathEnv,
        homeDir: environment.homeDir,
        fileSystem: devSourceFileSystem
      });
      io.stdout.write(renderDevLaunchBoundarySummary(launchPlan));
      const runner =
        environment.devClaudeProcessRunner ??
        createNodeDevClaudeProcessRunner();
      const exitCode = runner.run({
        command: launchPlan.command,
        args: launchPlan.args,
        env: launchPlan.env,
        cwd: launchPlan.cwd
      });
      return exitCode ?? 1;
    }

    const canPrompt = isInteractiveTerminal(environment.promptEnvironment);
    const deleteYes = parsed.value.dev?.yes ?? false;
    const deleteForce = parsed.value.dev?.force ?? false;
    if (!profile && !canPrompt) {
      io.stderr.write(
        'Non-interactive `teamem dev delete` requires --profile.\n'
      );
      return 1;
    }
    if (!deleteYes && !canPrompt) {
      io.stderr.write('Non-interactive `teamem dev delete` requires --yes.\n');
      return 1;
    }
    const selection = selectDevProfile({
      homeDir: environment.homeDir,
      requestedProfile: profile,
      allowCreate: false,
      fileSystem: devFileSystem,
      prompt: profile
        ? undefined
        : (message) => promptWithRuntime(message, environment.promptEnvironment)
    });
    if (!selection.ok) {
      io.stderr.write(`${selection.error}\n`);
      return 1;
    }
    const detector =
      environment.devProfileActiveSessionDetector ??
      createNodeDevProfileActiveSessionDetector();
    const activeSession = detector.check(selection.paths);
    if (activeSession.status === 'active' && !deleteForce) {
      io.stderr.write(
        `${activeSession.message}\nRefusing to delete an active dev profile. Re-run with --force to override.\n`
      );
      return 1;
    }
    if (activeSession.status === 'active' && deleteForce) {
      io.stderr.write(`${activeSession.message}\n--force was provided.\n`);
    }
    if (activeSession.status === 'inconclusive') {
      io.stderr.write(
        `Warning: ${activeSession.message}\nProceed only if no Claude session is using this profile.\n`
      );
    }

    io.stdout.write(
      [
        `Selected dev profile for deletion: ${selection.profileName}`,
        `Profile root: ${selection.paths.profileRoot}`
      ].join('\n') + '\n'
    );
    if (!deleteYes) {
      const answer = promptWithRuntime(
        `Delete Teamem dev profile at ${selection.paths.profileRoot}? Type ${selection.profileName} to confirm: `,
        environment.promptEnvironment
      )?.trim();
      if (answer !== selection.profileName) {
        io.stderr.write('Dev profile deletion was cancelled.\n');
        return 1;
      }
    }

    if (parsed.value.dryRun) {
      io.stdout.write(
        `dry-run: dev profile would be deleted: ${selection.paths.profileRoot}\n`
      );
      return 0;
    }

    const deletion = deleteDevProfile({
      paths: selection.paths,
      fileSystem: devFileSystem
    });
    if (!deletion.ok) {
      io.stderr.write(`${deletion.error}\n`);
      return 1;
    }
    io.stdout.write(
      [
        `Deleted dev profile: ${deletion.profileName}`,
        `Deleted profile root: ${deletion.profileRoot}`
      ].join('\n') + '\n'
    );
    return 0;
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
    if (lifecycleCommand === 'statusline') {
      const statuslineCommand = parsed.value.claude?.statuslineCommand;
      if (!statuslineCommand) {
        io.stderr.write(
          'Missing teamem claude statusline command. Expected one of: install, status, uninstall\n'
        );
        return 1;
      }
      if (statuslineCommand === 'render') {
        io.stdout.write(renderClaudeStatusline());
        return 0;
      }
      const statuslineEnvironment = {
        cwd: environment.prerequisites.cwd,
        homeDir: environment.homeDir,
        fileSystem:
          environment.claudeLauncherFileSystem ??
          createNodeClaudeLauncherFileSystem(),
        commandRunner: environment.prerequisites.commandRunner,
        scope: parsed.value.scope,
        dryRun: parsed.value.dryRun
      };
      const result =
        statuslineCommand === 'install'
          ? installClaudeStatusline(statuslineEnvironment)
          : statuslineCommand === 'status'
            ? getClaudeStatuslineStatus(statuslineEnvironment)
            : uninstallClaudeStatusline(statuslineEnvironment);
      io.stdout.write(renderClaudeStatuslineReport(result));
      return result.ok ? 0 : 1;
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

function isClaudeStatuslineCommand(
  value: string
): value is ClaudeStatuslineCommand {
  return (
    value === 'install' ||
    value === 'status' ||
    value === 'uninstall' ||
    value === 'render'
  );
}

type DevProfileCredentialSetupStatus =
  | {
      readonly ok: true;
      readonly message: string;
      readonly exitCode: 0;
      readonly setupRan: boolean;
    }
  | {
      readonly ok: false;
      readonly message: string;
      readonly exitCode: number;
    };

function ensureDevProfileCredentials(options: {
  readonly selection: DevProfileSelection;
  readonly source?: DevSourceResolution;
  readonly fileSystem: DevProfileFileSystem;
  readonly setupRunner: DevSetupRunner;
}): DevProfileCredentialSetupStatus {
  if (options.fileSystem.exists(options.selection.paths.credentialsPath)) {
    return {
      ok: true,
      exitCode: 0,
      setupRan: false,
      message: 'Profile credentials already exist; setup skipped.'
    };
  }

  if (!options.source) {
    return {
      ok: false,
      exitCode: 1,
      message:
        'Teamem dev claude could not resolve the selected source checkout for profile setup.'
    };
  }

  const result = options.setupRunner.run({
    source: options.source,
    profile: options.selection.paths
  });
  if (!result.ok) {
    return {
      ok: false,
      exitCode: result.exitCode,
      message: result.message
    };
  }

  return {
    ok: true,
    exitCode: 0,
    setupRan: true,
    message: result.message
  };
}

function ensureDevPluginBundles(options: {
  readonly source: DevSourceResolution;
  readonly buildPlugin: boolean;
  readonly canPrompt: boolean;
  readonly io: CliIo;
  readonly environment: CliEnvironment;
}): number {
  const checker =
    options.environment.devBundleFreshnessChecker ??
    createNodeDevBundleFreshnessChecker();
  const builder =
    options.environment.devPluginBuilder ?? createNodeDevPluginBuilder();

  let report = checker.check(options.source);
  options.io.stdout.write(`${renderDevBundleFreshness(report)}\n`);

  if (options.buildPlugin) {
    const build = builder.build(options.source);
    options.io.stdout.write(`${build.message}\n`);
    if (!build.ok) {
      return build.exitCode;
    }
    report = checker.check(options.source);
    options.io.stdout.write(`${renderDevBundleFreshness(report)}\n`);
    return hasDevBundleFreshnessFailure(report) ? 1 : 0;
  }

  if (!hasDevBundleFreshnessFailure(report)) {
    return 0;
  }

  if (options.canPrompt) {
    const answer = promptWithRuntime(
      'Plugin bundles are stale or missing. Run `bun run build:plugin` now? [y/N] ',
      options.environment.promptEnvironment
    )
      ?.trim()
      .toLowerCase();
    if (answer === 'y' || answer === 'yes') {
      const build = builder.build(options.source);
      options.io.stdout.write(`${build.message}\n`);
      if (!build.ok) {
        return build.exitCode;
      }
      report = checker.check(options.source);
      options.io.stdout.write(`${renderDevBundleFreshness(report)}\n`);
      return hasDevBundleFreshnessFailure(report) ? 1 : 0;
    }

    options.io.stderr.write(
      'Plugin bundles are stale or missing and rebuild was declined; Claude was not launched.\n'
    );
    return 1;
  }

  options.io.stderr.write(
    'Plugin bundles are stale or missing. Run `bun run build:plugin` from the selected Teamem source checkout or pass --build-plugin.\n'
  );
  return 1;
}

function renderDevProfileStatusPreflight(options: {
  readonly paths: DevProfilePaths;
  readonly source?: DevSourceResolution;
  readonly environment: CliEnvironment;
}): string | undefined {
  if (!options.source) {
    return undefined;
  }

  const bundleReport = (
    options.environment.devBundleFreshnessChecker ??
    createNodeDevBundleFreshnessChecker()
  ).check(options.source);
  return renderDevBundleFreshness(bundleReport);
}

function renderDevProfileStatusBoundary(options: {
  readonly paths: DevProfilePaths;
  readonly source?: DevSourceResolution;
  readonly fileSystem: DevProfileFileSystem;
  readonly credentialsReader: DevCredentialsReader;
  readonly healthChecker: DevServerHealthChecker;
}): string {
  const credentials = readDevProfileServerUrl({
    profile: options.paths,
    credentialsReader: options.credentialsReader
  });
  const sourceCheckout = options.source?.teamemRoot;
  const launchCwd = options.source?.launchCwd;
  const generatedMcpStatus = options.fileSystem.exists(
    options.paths.mcpConfigPath
  )
    ? 'present'
    : 'missing; run `teamem dev claude --profile ' +
      options.paths.profileName +
      '` to generate it';
  const healthLine = credentials.ok
    ? renderDevServerHealth(options.healthChecker.check(credentials.serverUrl))
    : `Server health: not checked (${credentials.message})`;

  return [
    `Profile: ${options.paths.profileName}`,
    `Profile path: ${options.paths.profileRoot}`,
    `Teamem credentials path: ${options.paths.credentialsPath}`,
    credentials.ok
      ? `Teamem credentials status: present (${credentials.serverUrl})`
      : `Teamem credentials status: missing or unusable (${credentials.message})`,
    healthLine,
    `Claude config root: ${options.paths.claudeConfigDir}`,
    `Plugin cache root: ${options.paths.pluginCacheDir}`,
    `Plugin data root: ${options.paths.pluginDataDir}`,
    `Source checkout: ${sourceCheckout ?? 'missing; pass --teamem-root <path-to-teamem-source> or run from a Teamem source checkout'}`,
    `Launch cwd: ${launchCwd ?? 'unresolved because source checkout is missing'}`,
    `Generated MCP config: ${options.paths.mcpConfigPath}`,
    `Generated MCP config status: ${generatedMcpStatus}`,
    `Launch workspace MCP config: ${options.source ? devLaunchWorkspaceMcpConfigPath(options.source) : 'unresolved because source checkout is missing'}`,
    'MCP isolation mode: strict profile MCP config (--strict-mcp-config)',
    'Channel source: server:teamem-channel',
    'Marketplace plugin ignored: yes (teamem@teamem-alpha is not loaded for source-checkout dev status).',
    `Metadata: ${options.paths.metadataPath}`,
    `Logs: ${options.paths.logsDir}`
  ].join('\n');
}

function devLaunchWorkspaceMcpConfigPath(source: DevSourceResolution): string {
  return join(source.launchCwd, '.mcp.json');
}

function materializeDevLaunchWorkspaceMcpConfig(options: {
  readonly source: DevSourceResolution;
  readonly generatedConfig: StrictMcpConfig;
  readonly fileSystem: DevSourceFileSystem;
}):
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly path: string; readonly error: string } {
  const path = devLaunchWorkspaceMcpConfigPath(options.source);
  let existing: Record<string, unknown> = {};

  if (options.fileSystem.isReadableFile(path)) {
    try {
      const parsed = JSON.parse(options.fileSystem.readFile(path)) as unknown;
      if (!isPlainRecord(parsed)) {
        return {
          ok: false,
          path,
          error: `Launch workspace MCP config must be a JSON object: ${path}`
        };
      }
      existing = parsed;
    } catch (error) {
      return {
        ok: false,
        path,
        error: `Launch workspace MCP config is malformed JSON: ${path}. ${formatUnknownCliError(error)}`
      };
    }
  }

  const existingServers = existing.mcpServers;
  if (existingServers !== undefined && !isPlainRecord(existingServers)) {
    return {
      ok: false,
      path,
      error: `Launch workspace MCP config mcpServers must be an object: ${path}`
    };
  }
  const existingMcpServers = isPlainRecord(existingServers)
    ? existingServers
    : {};

  const merged = {
    ...existing,
    mcpServers: {
      ...existingMcpServers,
      teamem: options.generatedConfig.mcpServers.teamem,
      'teamem-channel': options.generatedConfig.mcpServers['teamem-channel']
    }
  };
  options.fileSystem.writeFile(path, `${JSON.stringify(merged, null, 2)}\n`);
  return { ok: true, path };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function formatUnknownCliError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ensureDevServerHealth(options: {
  readonly profile: DevProfilePaths;
  readonly io: CliIo;
  readonly environment: CliEnvironment;
}): number {
  const serverUrl = readDevProfileServerUrl({
    profile: options.profile,
    credentialsReader:
      options.environment.devCredentialsReader ??
      createNodeDevCredentialsReader()
  });
  if (!serverUrl.ok) {
    options.io.stderr.write(`${serverUrl.message}\n`);
    return 1;
  }

  const health = (
    options.environment.devServerHealthChecker ??
    createNodeDevServerHealthChecker()
  ).check(serverUrl.serverUrl);
  options.io.stdout.write(`${renderDevServerHealth(health)}\n`);
  if (!health.ok) {
    options.io.stderr.write(
      `Teamem server is unreachable at ${health.checkedUrl}; Claude was not launched.\n`
    );
    return 1;
  }
  return 0;
}

function runPostSetupGitHookStep(options: {
  readonly mode?: 'install' | 'skip';
  readonly scope: PluginScope;
  readonly cwd: string;
  readonly pluginRoot?: string;
  readonly insideGitRepository: boolean;
  readonly io: CliIo;
  readonly environment: CliEnvironment;
  readonly commandRunner?: CommandRunner;
}): number {
  if (!options.insideGitRepository) {
    options.io.stdout.write(
      'Git hooks skipped: current directory is not inside a git repository.\n'
    );
    return 0;
  }
  if (options.mode === 'skip') {
    options.io.stdout.write('Git hooks skipped by --skip-git-hooks.\n');
    return 0;
  }

  const shouldPromptForGitHooks =
    options.mode === undefined &&
    (options.environment.gitHookPrompter !== undefined ||
      (process.stdin.isTTY && process.stdout.isTTY));
  const shouldInstallGitHooks =
    options.mode === 'install'
      ? true
      : shouldPromptForGitHooks
        ? (
            options.environment.gitHookPrompter ??
            createInteractiveGitHookPrompter(options.io)
          )({
            scope: options.scope
          })
        : false;

  if (!shouldInstallGitHooks) {
    options.io.stdout.write(
      options.mode === undefined
        ? 'Git hooks were not installed because this session is non-interactive. Re-run `teamem init --install-git-hooks` to force install or `--skip-git-hooks` to silence this step.\n'
        : 'Git hooks skipped.\n'
    );
    return 0;
  }

  const gitHookInstaller =
    options.environment.gitHookInstaller ??
    createGitHookInstaller({
      cwd: options.cwd,
      commandRunner: options.commandRunner
    });
  const gitHookResult = gitHookInstaller.install({
    scope: options.scope,
    pluginRoot: options.pluginRoot
  });
  if (!gitHookResult.ok) {
    options.io.stderr.write(`${gitHookResult.message}\n`);
    return gitHookResult.exitCode;
  }
  options.io.stdout.write(`${gitHookResult.message}\n`);
  return 0;
}

function isInsideGitRepositoryForCwd(options: {
  readonly cwd: string;
  readonly environment: CliEnvironment;
}): boolean {
  const commandRunner =
    options.cwd === options.environment.prerequisites.cwd
      ? options.environment.prerequisites.commandRunner
      : createSystemCommandRunner(options.cwd);
  const result = commandRunner.run('git', [
    'rev-parse',
    '--is-inside-work-tree'
  ]);
  return result.exitCode === 0 && result.stdout.trim() === 'true';
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

function runPostSetupClaudeStatuslineStep(options: {
  readonly mode?: 'install' | 'skip';
  readonly scope?: PluginScope;
  readonly cwd: string;
  readonly io: CliIo;
  readonly environment: CliEnvironment;
  readonly commandRunner?: CommandRunner;
}): number {
  if (options.mode === 'skip') {
    options.io.stdout.write(
      'Claude statusline skipped by --skip-claude-statusline.\n'
    );
    return 0;
  }

  const shouldPrompt =
    options.mode === undefined &&
    (options.environment.claudeStatuslinePrompter !== undefined ||
      isInteractiveTerminal(options.environment.promptEnvironment));
  const shouldInstall =
    options.mode === 'install'
      ? true
      : shouldPrompt
        ? (
            options.environment.claudeStatuslinePrompter ??
            createInteractiveClaudeStatuslinePrompter(options.io, {
              environment: options.environment.promptEnvironment
            })
          )()
        : false;

  if (!shouldInstall) {
    options.io.stdout.write(
      options.mode === undefined && shouldPrompt
        ? 'You can enable the Teamem statusline later with: teamem claude statusline install\n'
        : options.mode === undefined
          ? 'Claude statusline was not installed because this session is non-interactive. Re-run `teamem init --install-claude-statusline` to force install or `--skip-claude-statusline` to silence this step.\n'
          : 'Claude statusline skipped.\n'
    );
    return 0;
  }

  const result = installClaudeStatusline({
    cwd: options.cwd,
    homeDir: options.environment.homeDir,
    fileSystem:
      options.environment.claudeLauncherFileSystem ??
      createNodeClaudeLauncherFileSystem(),
    commandRunner: options.commandRunner,
    scope: options.scope,
    dryRun: false
  });
  options.io.stdout.write(renderClaudeStatuslineReport(result));
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

function createInteractiveClaudeStatuslinePrompter(
  io: CliIo,
  options: { readonly environment?: RuntimePromptEnvironment } = {}
): ClaudeStatuslinePrompter {
  return () => {
    if (!isInteractiveTerminal(options.environment)) {
      return false;
    }

    while (true) {
      const answer = (
        promptWithRuntime(
          'Install the Teamem Claude statusline? [Y/n]: ',
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

function renderInitStatuslineDryRun(mode?: 'install' | 'skip'): string {
  if (mode === 'install') {
    return 'Claude statusline: forced by --install-claude-statusline; dry-run did not write statusline settings.\n';
  }
  if (mode === 'skip') {
    return 'Claude statusline: skipped by --skip-claude-statusline; dry-run did not write statusline settings.\n';
  }
  return 'Claude statusline: would be offered after setup in an interactive init; non-interactive init would skip unless --install-claude-statusline is provided.\n';
}
