import {
  accessSync,
  chmodSync,
  constants,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { findInstalledTeamemPlugin } from './claude-plugin-list.js';
import { readRememberedScope, TEAMEM_PLUGIN } from './plugin-installer.js';
import {
  detectPrerequisites,
  type CommandProbeResult,
  type CommandRunner,
  type PrerequisiteDiagnostic,
  type PrerequisiteEnvironment
} from './prerequisites.js';
import {
  isInteractiveTerminal,
  promptWithRuntime,
  type RuntimePromptEnvironment
} from './runtime-prompt.js';

const STATE_VERSION = 1;
const OWNERSHIP_MARKER = '# teamem-owned-claude-shim';
const SHIM_NAME = 'claude';
const LAUNCHER_STATE_ENV = 'TEAMEM_CLAUDE_LAUNCHER_STATE';
const LAUNCH_INTENT_ENV = 'TEAMEM_CLAUDE_LAUNCH_INTENT';
const LAUNCH_SPACE_ENV = 'TEAMEM_CLAUDE_LAUNCH_SPACE';
const TEAMEM_DEVELOPMENT_CHANNEL_ARGS = [
  '--dangerously-load-development-channels',
  'plugin:teamem@teamem-alpha'
] as const;
const REQUIRED_TEAMEM_COMMANDS = [
  './commands/setup.md',
  './commands/off.md',
  './commands/status.md',
  './commands/briefing.md'
] as const;
const REQUIRED_SESSION_START_SCRIPT = 'scripts/session-start.sh';
const REQUIRED_SESSION_START_HOOK_COMMAND =
  'bash "$CLAUDE_PLUGIN_ROOT"/scripts/session-start.sh';
const REQUIRED_TEAMEM_FLAG_BIN = 'bin/teamem-flag';

export interface ClaudeLauncherFileSystem {
  exists(path: string): boolean;
  isReadableFile(path: string): boolean;
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  mkdir(path: string): void;
  rm(path: string): void;
  isExecutableFile(path: string): boolean;
  chmodExecutable(path: string): void;
}

export interface ClaudeLauncherEnvironment {
  readonly homeDir?: string;
  readonly pathEnv?: string;
  readonly fileSystem?: ClaudeLauncherFileSystem;
  readonly now?: () => Date;
}

export interface ClaudeLaunchProcessRunner {
  run(
    command: string,
    args: readonly string[],
    environment: NodeJS.ProcessEnv
  ): number | null;
}

export type ClaudeLaunchMode = 'prompt' | 'teamem' | 'pure';

export interface ClaudeLaunchEnvironment extends ClaudeLauncherEnvironment {
  readonly mode: ClaudeLaunchMode;
  readonly claudeArgs: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly readiness?: PrerequisiteEnvironment;
  readonly promptEnvironment?: RuntimePromptEnvironment;
  readonly processRunner?: ClaudeLaunchProcessRunner;
}

export interface ClaudeLaunchResult {
  readonly ok: boolean;
  readonly mode: 'teamem' | 'pure';
  readonly exitCode: number;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly prompted: boolean;
  readonly message: string;
}

export interface ClaudeLauncherPaths {
  readonly stateDir: string;
  readonly statePath: string;
  readonly shimDir: string;
  readonly shimPath: string;
}

export interface ClaudeLauncherState {
  readonly version: 1;
  readonly realClaudePath: string;
  readonly shimPath: string;
  readonly installedAt: string;
}

interface LaunchCredentialsFile {
  readonly version: 1;
  readonly default_space_id: string | null;
  readonly spaces: Record<string, LaunchCredentialEntry>;
}

interface LaunchCredentialEntry {
  readonly space_id: string;
  readonly label: string;
  readonly member_name: string;
  readonly jwt: string;
  readonly jwt_exp: number;
  readonly server_url: string;
}

export type ClaudeLauncherStatus =
  | 'not-installed'
  | 'installed-on-path'
  | 'installed-not-first-on-path'
  | 'recorded-real-claude-missing'
  | 'shim-missing';

export interface ClaudeLauncherResult {
  readonly ok: boolean;
  readonly command: 'install' | 'status' | 'uninstall';
  readonly dryRun: boolean;
  readonly status: ClaudeLauncherStatus;
  readonly paths: ClaudeLauncherPaths;
  readonly state?: ClaudeLauncherState;
  readonly realClaudePath?: string;
  readonly plannedWrites: readonly string[];
  readonly plannedRemovals: readonly string[];
  readonly message: string;
  readonly details: readonly string[];
}

export function createNodeClaudeLauncherFileSystem(): ClaudeLauncherFileSystem {
  return {
    exists(path: string): boolean {
      try {
        accessSync(path, constants.F_OK);
        return true;
      } catch {
        return false;
      }
    },
    readFile(path: string): string {
      return readFileSync(path, 'utf8');
    },
    isReadableFile(path: string): boolean {
      try {
        if (!statSync(path).isFile()) {
          return false;
        }
        accessSync(path, constants.R_OK);
        return true;
      } catch {
        return false;
      }
    },
    writeFile(path: string, content: string): void {
      writeFileSync(path, content, 'utf8');
    },
    mkdir(path: string): void {
      mkdirSync(path, { recursive: true });
    },
    rm(path: string): void {
      rmSync(path, { recursive: true, force: true });
    },
    isExecutableFile(path: string): boolean {
      try {
        if (!statSync(path).isFile()) {
          return false;
        }
        accessSync(path, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
    chmodExecutable(path: string): void {
      chmodSync(path, 0o755);
    }
  };
}

export function installClaudeLauncher(
  environment: ClaudeLauncherEnvironment & { readonly dryRun: boolean }
): ClaudeLauncherResult {
  const context = buildContext(environment);
  const existingShim = readOwnedShim(
    context.fileSystem,
    context.paths.shimPath
  );
  if (existingShim === 'foreign') {
    return {
      ok: false,
      command: 'install',
      dryRun: environment.dryRun,
      status: 'not-installed',
      paths: context.paths,
      plannedWrites: [],
      plannedRemovals: [],
      message:
        'Refusing to overwrite an existing non-Teamem `claude` shim path.',
      details: [
        `Existing path: ${context.paths.shimPath}`,
        'Move or remove that path before rerunning `teamem claude install`.'
      ]
    };
  }

  const realClaudePath = resolveRealClaudePath(context);
  if (!realClaudePath) {
    return {
      ok: false,
      command: 'install',
      dryRun: environment.dryRun,
      status: 'not-installed',
      paths: context.paths,
      plannedWrites: [],
      plannedRemovals: [],
      message:
        "Could not find the real Claude Code executable outside Teamem's shim directory.",
      details: [
        'Install Claude Code or put the real `claude` executable on PATH before rerunning `teamem claude install`.'
      ]
    };
  }

  const state: ClaudeLauncherState = {
    version: STATE_VERSION,
    realClaudePath,
    shimPath: context.paths.shimPath,
    installedAt: context.now().toISOString()
  };
  const plannedWrites = [context.paths.shimPath, context.paths.statePath];
  if (!environment.dryRun) {
    context.fileSystem.mkdir(context.paths.shimDir);
    context.fileSystem.mkdir(context.paths.stateDir);
    context.fileSystem.writeFile(
      context.paths.shimPath,
      renderShimScript(context.paths.statePath)
    );
    context.fileSystem.chmodExecutable(context.paths.shimPath);
    context.fileSystem.writeFile(
      context.paths.statePath,
      `${JSON.stringify(state, null, 2)}\n`
    );
  }

  return {
    ok: true,
    command: 'install',
    dryRun: environment.dryRun,
    status: determineInstalledStatus(context, state),
    paths: context.paths,
    state,
    realClaudePath,
    plannedWrites,
    plannedRemovals: [],
    message: environment.dryRun
      ? 'dry-run: Teamem-owned Claude launcher files were planned but not written.'
      : existingShim === 'owned'
        ? 'Teamem-aware Claude launcher was refreshed.'
        : 'Teamem-aware Claude launcher was installed.',
    details: [
      'Teamem is not affiliated with Anthropic and does not handle Claude credentials.',
      'The shim prompts for Teamem or pure Claude Code, then execs the real Claude Code binary.',
      'Remove the shim with `teamem claude uninstall`.',
      `Recorded real Claude Code: ${realClaudePath}`,
      `Teamem shim: ${context.paths.shimPath}`,
      `Add Teamem's shim directory before the real Claude Code directory on PATH:`,
      `  export PATH="${context.paths.shimDir}:$PATH"`
    ]
  };
}

export function getClaudeLauncherStatus(
  environment: ClaudeLauncherEnvironment & { readonly dryRun: boolean }
): ClaudeLauncherResult {
  const context = buildContext(environment);
  const state = readState(context.fileSystem, context.paths.statePath);
  if (!state) {
    return {
      ok: true,
      command: 'status',
      dryRun: environment.dryRun,
      status: 'not-installed',
      paths: context.paths,
      plannedWrites: [],
      plannedRemovals: [],
      message: 'Teamem-aware Claude launcher is not installed.',
      details: [`Install it with: teamem claude install`]
    };
  }

  const status = determineInstalledStatus(context, state);
  const ok =
    status === 'installed-on-path' || status === 'installed-not-first-on-path';
  return {
    ok,
    command: 'status',
    dryRun: environment.dryRun,
    status,
    paths: context.paths,
    state,
    realClaudePath: state.realClaudePath,
    plannedWrites: [],
    plannedRemovals: [],
    message: renderStatusMessage(status),
    details: renderStatusDetails(context, state, status)
  };
}

export function uninstallClaudeLauncher(
  environment: ClaudeLauncherEnvironment & { readonly dryRun: boolean }
): ClaudeLauncherResult {
  const context = buildContext(environment);
  const state = readState(context.fileSystem, context.paths.statePath);
  const shimOwnership = readOwnedShim(
    context.fileSystem,
    context.paths.shimPath
  );
  const plannedRemovals = [
    ...(shimOwnership === 'owned' ? [context.paths.shimPath] : []),
    ...(context.fileSystem.exists(context.paths.statePath)
      ? [context.paths.statePath]
      : [])
  ];

  if (!environment.dryRun) {
    if (shimOwnership === 'owned') {
      context.fileSystem.rm(context.paths.shimPath);
    }
    if (context.fileSystem.exists(context.paths.statePath)) {
      context.fileSystem.rm(context.paths.statePath);
    }
  }

  const details = [
    plannedRemovals.length > 0
      ? `Launcher paths: ${plannedRemovals.join(', ')}`
      : 'No Teamem-owned launcher files were present.',
    ...(state?.realClaudePath
      ? [
          `Restored Claude Code path: ${state.realClaudePath}`,
          'Open a new terminal or run `hash -r`, then verify with `which claude`.'
        ]
      : []),
    ...(shimOwnership === 'foreign'
      ? [`Preserved non-Teamem path: ${context.paths.shimPath}`]
      : [])
  ];

  return {
    ok: true,
    command: 'uninstall',
    dryRun: environment.dryRun,
    status: state ? 'not-installed' : 'not-installed',
    paths: context.paths,
    state: state ?? undefined,
    realClaudePath: state?.realClaudePath,
    plannedWrites: [],
    plannedRemovals,
    message: environment.dryRun
      ? 'dry-run: Teamem-owned Claude shim unwrap was planned only.'
      : 'Claude Code restored; Teamem-owned launcher files were removed where present.',
    details
  };
}

export function renderClaudeLauncherReport(
  result: ClaudeLauncherResult
): string {
  const lines = [
    `teamem claude ${result.command}`,
    result.dryRun
      ? 'dry-run: no launcher files were changed'
      : renderCommandStatusLine(result),
    ''
  ];

  lines.push(`Status: ${result.status}`);
  lines.push(`State: ${result.paths.statePath}`);
  lines.push(`Shim: ${result.paths.shimPath}`);
  if (result.realClaudePath) {
    lines.push(`Real Claude Code: ${result.realClaudePath}`);
  }
  if (result.plannedWrites.length > 0) {
    lines.push('', 'Writes:');
    for (const path of result.plannedWrites) {
      lines.push(`  - ${path}`);
    }
  }
  if (result.plannedRemovals.length > 0) {
    lines.push('', 'Removals:');
    for (const path of result.plannedRemovals) {
      lines.push(`  - ${path}`);
    }
  }
  if (result.details.length > 0) {
    lines.push('', 'Details:');
    for (const detail of result.details) {
      lines.push(`  ${detail}`);
    }
  }
  lines.push(
    '',
    result.ok ? `OK: ${result.message}` : `ERROR: ${result.message}`
  );
  return `${lines.join('\n')}\n`;
}

export function resolveRealClaudeExecutable(options: {
  readonly fileSystem?: ClaudeLauncherFileSystem;
  readonly pathEnv?: string;
  readonly homeDir?: string;
}): string | undefined {
  return resolveRealClaudePath({
    paths: buildLauncherPaths(options.homeDir ?? homedir()),
    fileSystem: options.fileSystem ?? createNodeClaudeLauncherFileSystem(),
    pathEntries: splitPath(options.pathEnv ?? process.env.PATH ?? '')
  });
}

export function launchClaudeWithTeamemPolicy(
  environment: ClaudeLaunchEnvironment
): ClaudeLaunchResult {
  const context = buildContext(environment);
  const state = readLaunchState(environment, context.fileSystem);
  if (!state) {
    return {
      ok: false,
      mode: 'pure',
      exitCode: 1,
      command: SHIM_NAME,
      args: environment.claudeArgs,
      env: environment.env ?? process.env,
      prompted: false,
      message:
        'Teamem Claude launcher state is missing or invalid. Reinstall with `teamem claude install`.'
    };
  }
  if (!context.fileSystem.isExecutableFile(state.realClaudePath)) {
    return {
      ok: false,
      mode: 'pure',
      exitCode: 1,
      command: SHIM_NAME,
      args: environment.claudeArgs,
      env: environment.env ?? process.env,
      prompted: false,
      message: [
        'Teamem Claude launcher state is installed, but the recorded real Claude Code executable is not available.',
        `Recorded path: ${state.realClaudePath}`,
        'Reinstall Claude Code or rerun `teamem claude install` after the real `claude` is available.'
      ].join('\n')
    };
  }

  const selection = resolveLaunchSelection(environment);
  const env = buildLaunchEnvironment(environment.env ?? process.env, {
    pathEnv: environment.pathEnv,
    shimDir: context.paths.shimDir
  });
  if (selection.mode === 'teamem') {
    const readiness = checkTeamemLaunchReadiness({
      environment,
      context,
      state,
      launchEnv: env
    });
    if (!readiness.ok) {
      return {
        ok: false,
        mode: 'teamem',
        exitCode: 1,
        command: SHIM_NAME,
        args: environment.claudeArgs,
        env,
        prompted: selection.prompted,
        message: readiness.message
      };
    }
    applyTeamemLaunchIntent(env);
  }
  const args =
    selection.mode === 'teamem'
      ? [...TEAMEM_DEVELOPMENT_CHANNEL_ARGS, ...environment.claudeArgs]
      : [...environment.claudeArgs];
  const runner =
    environment.processRunner ?? createNodeClaudeLaunchProcessRunner();
  const rawExitCode = runner.run(state.realClaudePath, args, env);
  const exitCode = rawExitCode ?? 1;

  return {
    ok: exitCode === 0,
    mode: selection.mode,
    exitCode,
    command: state.realClaudePath,
    args,
    env,
    prompted: selection.prompted,
    message:
      selection.mode === 'teamem'
        ? 'Launched Claude Code with Teamem development channel.'
        : 'Launched pure Claude Code.'
  };
}

function checkTeamemLaunchReadiness(options: {
  readonly environment: ClaudeLaunchEnvironment;
  readonly context: {
    readonly paths: ClaudeLauncherPaths;
    readonly fileSystem: ClaudeLauncherFileSystem;
    readonly now: () => Date;
  };
  readonly state: ClaudeLauncherState;
  readonly launchEnv: NodeJS.ProcessEnv;
}): { readonly ok: true } | { readonly ok: false; readonly message: string } {
  const commandRunner = createReadinessCommandRunner({
    baseRunner: options.environment.readiness?.commandRunner,
    realClaudePath: options.state.realClaudePath
  });
  const readinessEnvironment: PrerequisiteEnvironment = {
    platform: options.environment.readiness?.platform ?? process.platform,
    cwd: options.environment.readiness?.cwd ?? process.cwd(),
    commandRunner
  };
  const prerequisiteReport = detectPrerequisites(readinessEnvironment);
  const blockingPrerequisite = prerequisiteReport.diagnostics.find(
    (diagnostic) => diagnostic.severity === 'error'
  );
  if (blockingPrerequisite) {
    return readinessFailure(
      `Teamem launch readiness failed: ${blockingPrerequisite.label} is not ready.`,
      [
        blockingPrerequisite.summary,
        ...(blockingPrerequisite.details
          ? [`details: ${blockingPrerequisite.details}`]
          : []),
        `next: ${rewriteInitHintForLaunch(blockingPrerequisite)}`
      ]
    );
  }

  const pluginList = commandRunner.run('claude', ['plugin', 'list', '--json']);
  if (pluginList.exitCode !== 0) {
    return readinessFailure(
      'Teamem launch readiness failed: could not inspect Claude Code plugins.',
      [
        describeProbeFailure('claude plugin list --json', pluginList),
        'next: Run `teamem init` to install or repair the Teamem Claude Code plugin.'
      ]
    );
  }

  const rememberedScope = readRememberedScope(
    options.context.fileSystem,
    readinessEnvironment.cwd
  );
  const pluginLookupOptions = {
    projectPath: resolveLaunchProjectPath(
      commandRunner,
      readinessEnvironment.cwd
    )
  };
  const pluginScope =
    rememberedScope ??
    (['project', 'user', 'local'] as const).find((scope) =>
      findInstalledTeamemPlugin(
        pluginList.stdout,
        TEAMEM_PLUGIN,
        scope,
        pluginLookupOptions
      )
    );
  if (!pluginScope) {
    return readinessFailure(
      'Teamem launch readiness failed: Teamem Claude Code plugin is not installed.',
      [
        'next: Run `teamem init` to install the Teamem plugin and setup credentials.'
      ]
    );
  }
  const installedPlugin = findInstalledTeamemPlugin(
    pluginList.stdout,
    TEAMEM_PLUGIN,
    pluginScope,
    pluginLookupOptions
  );
  if (!installedPlugin) {
    return readinessFailure(
      `Teamem launch readiness failed: Teamem plugin is not installed at the ${pluginScope} scope.`,
      [
        rememberedScope
          ? `Remembered scope is ${rememberedScope}, but Claude Code did not report ${TEAMEM_PLUGIN} there.`
          : `Detected scope ${pluginScope} did not include a usable plugin install path.`,
        'next: Run `teamem init` to reinstall Teamem at the intended Claude Code plugin scope.'
      ]
    );
  }
  const pluginSurface = validateInstalledTeamemPluginSurface(
    options.context.fileSystem,
    installedPlugin.installPath
  );
  if (!pluginSurface.ok) {
    return readinessFailure(
      'Teamem launch readiness failed: Teamem Claude Code plugin install is incomplete or stale.',
      [
        pluginSurface.message,
        'next: Run `teamem update` or `teamem init` to reinstall the current Teamem plugin before launching Claude Code with Teamem.'
      ]
    );
  }

  const credentialsPath = resolveCredentialsPath(
    options.launchEnv,
    options.environment.homeDir
  );
  const credentials = readLaunchCredentials(
    options.context.fileSystem,
    credentialsPath
  );
  if (credentials.status === 'missing') {
    return readinessFailure(
      'Teamem launch readiness failed: credentials are missing.',
      [
        `Missing credentials file: ${credentialsPath}`,
        'next: Run `teamem init` to create or join a Teamem Space.'
      ]
    );
  }
  if (credentials.status === 'malformed') {
    return readinessFailure(
      'Teamem launch readiness failed: credentials are malformed.',
      [
        `Credentials file could not be parsed: ${credentialsPath}`,
        'next: Run `teamem init` to refresh Teamem credentials.'
      ]
    );
  }
  if (credentials.status !== 'ok') {
    return readinessFailure(
      'Teamem launch readiness failed: credentials are unavailable.',
      ['next: Run `teamem init` to refresh Teamem credentials.']
    );
  }

  const selectedSpace = resolveCredentialEntry({
    credentials: credentials.value,
    requestedSpace: sanitizeSpaceOverride(options.launchEnv.TEAMEM_SPACE)
  });
  if (!selectedSpace.ok) {
    return readinessFailure(
      'Teamem launch readiness failed: no usable Teamem Space resolved.',
      [
        selectedSpace.message,
        'next: Run `teamem init` to select a default Space, or set TEAMEM_SPACE to a valid Space id or label.'
      ]
    );
  }

  const nowSeconds = Math.floor(options.context.now().getTime() / 1000);
  if (selectedSpace.entry.jwt_exp <= nowSeconds) {
    return readinessFailure(
      'Teamem launch readiness failed: selected Space token is expired.',
      [
        `Space: ${selectedSpace.entry.space_id} (${selectedSpace.entry.label})`,
        'next: Run `teamem init` to renew credentials before launching Claude Code with Teamem.'
      ]
    );
  }

  return { ok: true };
}

function validateInstalledTeamemPluginSurface(
  fileSystem: ClaudeLauncherFileSystem,
  installPath: string
): { readonly ok: true } | { readonly ok: false; readonly message: string } {
  const manifestPath = join(installPath, '.claude-plugin', 'plugin.json');
  if (!fileSystem.isReadableFile(manifestPath)) {
    return {
      ok: false,
      message: `Plugin manifest is missing or unreadable: ${manifestPath}`
    };
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(fileSystem.readFile(manifestPath));
  } catch {
    return {
      ok: false,
      message: `Plugin manifest is malformed: ${manifestPath}`
    };
  }

  const commands = isRecord(manifest) ? manifest.commands : undefined;
  if (!Array.isArray(commands)) {
    return {
      ok: false,
      message:
        'Plugin manifest does not declare Teamem slash commands. The installed plugin is too old for launcher-driven activation.'
    };
  }

  const missingCommand = REQUIRED_TEAMEM_COMMANDS.find(
    (requiredCommand) => !commands.includes(requiredCommand)
  );
  if (missingCommand) {
    return {
      ok: false,
      message: `Plugin manifest is missing required command entry: ${missingCommand}`
    };
  }

  const missingCommandFile = REQUIRED_TEAMEM_COMMANDS.map((command) =>
    join(installPath, command.replace('./', ''))
  ).find((commandPath) => !fileSystem.isReadableFile(commandPath));
  if (missingCommandFile) {
    return {
      ok: false,
      message: `Plugin command file is missing or unreadable: ${missingCommandFile}`
    };
  }

  const hooksPath = join(installPath, 'hooks', 'hooks.json');
  if (!fileSystem.isReadableFile(hooksPath)) {
    return {
      ok: false,
      message: `Plugin hook manifest is missing or unreadable: ${hooksPath}`
    };
  }

  let hooksManifest: unknown;
  try {
    hooksManifest = JSON.parse(fileSystem.readFile(hooksPath));
  } catch {
    return {
      ok: false,
      message: `Plugin hook manifest is malformed: ${hooksPath}`
    };
  }

  if (!hasSessionStartHook(hooksManifest)) {
    return {
      ok: false,
      message: `Plugin hook manifest is missing required SessionStart hook wiring for ${REQUIRED_SESSION_START_SCRIPT}`
    };
  }

  const sessionStartPath = join(installPath, REQUIRED_SESSION_START_SCRIPT);
  if (!fileSystem.isReadableFile(sessionStartPath)) {
    return {
      ok: false,
      message: `Plugin SessionStart script is missing or unreadable: ${sessionStartPath}`
    };
  }

  const teamemFlagPath = join(installPath, REQUIRED_TEAMEM_FLAG_BIN);
  if (!fileSystem.isExecutableFile(teamemFlagPath)) {
    return {
      ok: false,
      message: `Plugin activation flag binary is missing or not executable: ${teamemFlagPath}`
    };
  }

  return { ok: true };
}

function hasSessionStartHook(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.hooks)) {
    return false;
  }
  const sessionStartEntries = value.hooks.SessionStart;
  if (!Array.isArray(sessionStartEntries)) {
    return false;
  }
  return sessionStartEntries.some((entry) => {
    if (!isRecord(entry) || !Array.isArray(entry.hooks)) {
      return false;
    }
    return entry.hooks.some((hook) => {
      if (!isRecord(hook)) {
        return false;
      }
      return (
        hook.type === 'command' &&
        typeof hook.command === 'string' &&
        hook.command.trim() === REQUIRED_SESSION_START_HOOK_COMMAND
      );
    });
  });
}

function resolveLaunchProjectPath(
  commandRunner: CommandRunner,
  cwd: string
): string {
  const result = commandRunner.run('git', ['rev-parse', '--show-toplevel']);
  if (result.exitCode !== 0 || result.stdout.trim().length === 0) {
    return cwd;
  }
  return resolve(result.stdout.trim());
}

function createReadinessCommandRunner(options: {
  readonly baseRunner?: CommandRunner;
  readonly realClaudePath: string;
}): CommandRunner {
  const systemRunner = createMappedSystemCommandRunner();
  return {
    run(command: string, args: readonly string[]): CommandProbeResult {
      const actualCommand =
        command === 'claude' ? options.realClaudePath : command;
      return (options.baseRunner ?? systemRunner).run(actualCommand, args);
    }
  };
}

function createMappedSystemCommandRunner(): CommandRunner {
  return {
    run(command: string, args: readonly string[]): CommandProbeResult {
      const result = spawnSync(command, [...args], {
        encoding: 'utf8'
      });
      return {
        exitCode: result.status,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        errorCode:
          result.error && 'code' in result.error
            ? String(result.error.code)
            : undefined
      };
    }
  };
}

function readinessFailure(
  summary: string,
  details: readonly string[]
): { readonly ok: false; readonly message: string } {
  return {
    ok: false,
    message: [summary, ...details].join('\n')
  };
}

function rewriteInitHintForLaunch(diagnostic: PrerequisiteDiagnostic): string {
  if (!diagnostic.nextStep) {
    return 'Run `teamem init` after repairing this prerequisite.';
  }
  return diagnostic.nextStep.replaceAll('teamem init', 'teamem init');
}

function describeProbeFailure(
  command: string,
  result: CommandProbeResult
): string {
  const suffix = [result.stderr.trim(), result.stdout.trim()]
    .filter((value) => value.length > 0)
    .join(' | ');
  return suffix.length > 0
    ? `Command failed: ${command} (${suffix})`
    : `Command failed: ${command}`;
}

function resolveCredentialsPath(
  env: NodeJS.ProcessEnv,
  homeDir?: string
): string {
  const configured = env.TEAMEM_CREDENTIALS;
  if (
    configured &&
    configured.trim().length > 0 &&
    !isPlaceholder(configured)
  ) {
    return configured;
  }
  return join(homeDir ?? homedir(), '.teamem', 'credentials.json');
}

function readLaunchCredentials(
  fileSystem: ClaudeLauncherFileSystem,
  path: string
):
  | { readonly status: 'ok'; readonly value: LaunchCredentialsFile }
  | { readonly status: 'missing' | 'malformed' } {
  if (!fileSystem.exists(path)) {
    return { status: 'missing' };
  }
  try {
    const parsed = JSON.parse(fileSystem.readFile(path)) as unknown;
    if (!isLaunchCredentialsFile(parsed)) {
      return { status: 'malformed' };
    }
    return { status: 'ok', value: parsed };
  } catch {
    return { status: 'malformed' };
  }
}

function isLaunchCredentialsFile(
  value: unknown
): value is LaunchCredentialsFile {
  if (!isRecord(value)) {
    return false;
  }
  if (value.version !== 1) {
    return false;
  }
  if (
    value.default_space_id !== null &&
    typeof value.default_space_id !== 'string'
  ) {
    return false;
  }
  if (!isRecord(value.spaces)) {
    return false;
  }
  return Object.values(value.spaces).every(isLaunchCredentialEntry);
}

function isLaunchCredentialEntry(
  value: unknown
): value is LaunchCredentialEntry {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.space_id === 'string' &&
    value.space_id.length > 0 &&
    typeof value.label === 'string' &&
    typeof value.member_name === 'string' &&
    typeof value.jwt === 'string' &&
    typeof value.jwt_exp === 'number' &&
    Number.isFinite(value.jwt_exp) &&
    typeof value.server_url === 'string'
  );
}

function resolveCredentialEntry(options: {
  readonly credentials: LaunchCredentialsFile;
  readonly requestedSpace?: string;
}):
  | { readonly ok: true; readonly entry: LaunchCredentialEntry }
  | { readonly ok: false; readonly message: string } {
  const input = options.requestedSpace ?? options.credentials.default_space_id;
  if (!input) {
    return {
      ok: false,
      message: 'No TEAMEM_SPACE override or default_space_id is configured.'
    };
  }

  const byId = options.credentials.spaces[input];
  if (byId) {
    return { ok: true, entry: byId };
  }

  const labelMatches = Object.values(options.credentials.spaces).filter(
    (entry) => entry.label === input
  );
  if (labelMatches.length === 1) {
    return { ok: true, entry: labelMatches[0]! };
  }
  if (labelMatches.length > 1) {
    return {
      ok: false,
      message: `Space label '${input}' is ambiguous. Set TEAMEM_SPACE to a Space id.`
    };
  }
  return {
    ok: false,
    message: `Space '${input}' was not found in credentials.json.`
  };
}

function sanitizeSpaceOverride(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || isPlaceholder(trimmed)) {
    return undefined;
  }
  return trimmed;
}

function isPlaceholder(value: string): boolean {
  return /^\$\{[^}]*\}$/.test(value.trim());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function buildContext(environment: ClaudeLauncherEnvironment): {
  readonly paths: ClaudeLauncherPaths;
  readonly fileSystem: ClaudeLauncherFileSystem;
  readonly pathEntries: readonly string[];
  readonly now: () => Date;
} {
  const home = environment.homeDir ?? homedir();
  const paths = buildLauncherPaths(home);
  return {
    paths,
    fileSystem: environment.fileSystem ?? createNodeClaudeLauncherFileSystem(),
    pathEntries: splitPath(environment.pathEnv ?? process.env.PATH ?? ''),
    now: environment.now ?? (() => new Date())
  };
}

function buildLauncherPaths(homeDir: string): ClaudeLauncherPaths {
  const stateDir = join(homeDir, '.teamem', 'launcher');
  const shimDir = join(homeDir, '.teamem', 'bin');
  return {
    stateDir,
    statePath: join(stateDir, 'claude.json'),
    shimDir,
    shimPath: join(shimDir, SHIM_NAME)
  };
}

function createNodeClaudeLaunchProcessRunner(): ClaudeLaunchProcessRunner {
  return {
    run(
      command: string,
      args: readonly string[],
      environment: NodeJS.ProcessEnv
    ): number | null {
      const result = spawnSync(command, [...args], {
        stdio: 'inherit',
        env: environment
      });
      return result.status;
    }
  };
}

function readLaunchState(
  environment: ClaudeLaunchEnvironment,
  fileSystem: ClaudeLauncherFileSystem
): ClaudeLauncherState | undefined {
  const statePath = environment.env?.[LAUNCHER_STATE_ENV];
  if (statePath) {
    return readState(fileSystem, statePath);
  }
  return readState(
    fileSystem,
    buildLauncherPaths(environment.homeDir ?? homedir()).statePath
  );
}

function resolveLaunchSelection(environment: ClaudeLaunchEnvironment): {
  readonly mode: 'teamem' | 'pure';
  readonly prompted: boolean;
} {
  if (environment.mode === 'teamem') {
    return { mode: 'teamem', prompted: false };
  }
  if (environment.mode === 'pure') {
    return { mode: 'pure', prompted: false };
  }
  if (!isInteractiveTerminal(environment.promptEnvironment)) {
    return { mode: 'pure', prompted: false };
  }
  let answer: string | null;
  try {
    answer = promptWithRuntime(
      'Start Claude Code with Teamem? [Y/n] ',
      environment.promptEnvironment
    );
  } catch {
    return { mode: 'pure', prompted: true };
  }
  if (answer === null) {
    return { mode: 'pure', prompted: true };
  }
  const normalized = answer.trim().toLowerCase();
  if (normalized === '') {
    return { mode: 'teamem', prompted: true };
  }
  if (normalized === 'y' || normalized === 'yes') {
    return { mode: 'teamem', prompted: true };
  }
  if (normalized === 'n' || normalized === 'no') {
    return { mode: 'pure', prompted: true };
  }
  return { mode: 'pure', prompted: true };
}

function buildLaunchEnvironment(
  inputEnv: NodeJS.ProcessEnv,
  options: { readonly pathEnv?: string; readonly shimDir: string }
): NodeJS.ProcessEnv {
  const outputEnv: NodeJS.ProcessEnv = { ...inputEnv };
  const originalPath = options.pathEnv ?? inputEnv.PATH ?? '';
  outputEnv.PATH = splitPath(originalPath)
    .filter((entry) => resolve(entry) !== resolve(options.shimDir))
    .join(delimiter);
  delete outputEnv[LAUNCHER_STATE_ENV];
  delete outputEnv[LAUNCH_INTENT_ENV];
  delete outputEnv[LAUNCH_SPACE_ENV];
  return outputEnv;
}

function applyTeamemLaunchIntent(env: NodeJS.ProcessEnv): void {
  env[LAUNCH_INTENT_ENV] = 'activate';
  const requestedSpace = sanitizeSpaceOverride(env.TEAMEM_SPACE);
  if (requestedSpace) {
    env[LAUNCH_SPACE_ENV] = requestedSpace;
  } else {
    delete env[LAUNCH_SPACE_ENV];
  }
}

function splitPath(pathEnv: string): readonly string[] {
  return pathEnv
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function resolveRealClaudePath(context: {
  readonly paths: ClaudeLauncherPaths;
  readonly fileSystem: ClaudeLauncherFileSystem;
  readonly pathEntries: readonly string[];
}): string | undefined {
  const excludedShimDir = resolve(context.paths.shimDir);
  for (const pathEntry of context.pathEntries) {
    if (resolve(pathEntry) === excludedShimDir) {
      continue;
    }
    const candidate = join(pathEntry, SHIM_NAME);
    if (context.fileSystem.isExecutableFile(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function readOwnedShim(
  fileSystem: ClaudeLauncherFileSystem,
  shimPath: string
): 'missing' | 'owned' | 'foreign' {
  if (!fileSystem.exists(shimPath)) {
    return 'missing';
  }
  if (!fileSystem.isReadableFile(shimPath)) {
    return 'foreign';
  }
  let content: string;
  try {
    content = fileSystem.readFile(shimPath);
  } catch {
    return 'foreign';
  }
  return content.includes(OWNERSHIP_MARKER) ? 'owned' : 'foreign';
}

function readState(
  fileSystem: ClaudeLauncherFileSystem,
  statePath: string
): ClaudeLauncherState | undefined {
  if (!fileSystem.exists(statePath)) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(fileSystem.readFile(statePath)) as {
      version?: unknown;
      realClaudePath?: unknown;
      shimPath?: unknown;
      installedAt?: unknown;
    };
    if (
      parsed.version !== STATE_VERSION ||
      typeof parsed.realClaudePath !== 'string' ||
      typeof parsed.shimPath !== 'string' ||
      typeof parsed.installedAt !== 'string'
    ) {
      return undefined;
    }
    return parsed as ClaudeLauncherState;
  } catch {
    return undefined;
  }
}

function determineInstalledStatus(
  context: {
    readonly paths: ClaudeLauncherPaths;
    readonly fileSystem: ClaudeLauncherFileSystem;
    readonly pathEntries: readonly string[];
  },
  state: ClaudeLauncherState
): ClaudeLauncherStatus {
  if (!context.fileSystem.isExecutableFile(state.realClaudePath)) {
    return 'recorded-real-claude-missing';
  }
  if (readOwnedShim(context.fileSystem, context.paths.shimPath) !== 'owned') {
    return 'shim-missing';
  }
  const firstClaude = findFirstClaudeOnPath(context);
  if (firstClaude === context.paths.shimPath) {
    return 'installed-on-path';
  }
  return 'installed-not-first-on-path';
}

function findFirstClaudeOnPath(context: {
  readonly fileSystem: ClaudeLauncherFileSystem;
  readonly pathEntries: readonly string[];
}): string | undefined {
  for (const pathEntry of context.pathEntries) {
    const candidate = join(pathEntry, SHIM_NAME);
    if (context.fileSystem.isExecutableFile(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function renderShimScript(statePath: string): string {
  return `#!/usr/bin/env sh
${OWNERSHIP_MARKER}
export ${LAUNCHER_STATE_ENV}="${statePath}"
teamem_launcher_mode=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --teamem|--pure)
      if [ -n "$teamem_launcher_mode" ]; then
        exec teamem claude launch "$teamem_launcher_mode" "$1" -- "$@"
      fi
      teamem_launcher_mode="$1"
      shift
      ;;
    --)
      shift
      break
      ;;
    *)
      break
      ;;
  esac
done
if [ -n "$teamem_launcher_mode" ]; then
  exec teamem claude launch "$teamem_launcher_mode" -- "$@"
fi
exec teamem claude launch -- "$@"
`;
}

function renderCommandStatusLine(result: ClaudeLauncherResult): string {
  if (result.command === 'install') {
    return result.ok
      ? 'executed: launcher state and shim checked'
      : 'failed: launcher install did not change files';
  }
  if (result.command === 'uninstall') {
    return 'executed: Teamem-owned launcher cleanup checked';
  }
  return result.ok
    ? 'checked: launcher state is usable'
    : 'checked: launcher state needs attention';
}

function renderStatusMessage(status: ClaudeLauncherStatus): string {
  switch (status) {
    case 'not-installed':
      return 'Teamem-aware Claude launcher is not installed.';
    case 'installed-on-path':
      return 'Teamem-aware Claude launcher is installed and first on PATH.';
    case 'installed-not-first-on-path':
      return 'Teamem-aware Claude launcher is installed but is not the first `claude` on PATH.';
    case 'recorded-real-claude-missing':
      return 'Teamem-aware Claude launcher is installed, but the recorded real Claude Code executable is missing.';
    case 'shim-missing':
      return 'Teamem-aware Claude launcher state exists, but the Teamem-owned shim is missing.';
  }
}

function renderStatusDetails(
  context: {
    readonly paths: ClaudeLauncherPaths;
    readonly pathEntries: readonly string[];
  },
  state: ClaudeLauncherState,
  status: ClaudeLauncherStatus
): readonly string[] {
  switch (status) {
    case 'installed-on-path':
      return ["Normal `claude` launches will hit Teamem's shim first."];
    case 'installed-not-first-on-path':
      return [
        `Put ${context.paths.shimDir} before other Claude Code directories on PATH:`,
        `  export PATH="${context.paths.shimDir}:$PATH"`
      ];
    case 'recorded-real-claude-missing':
      return [
        `Recorded path is not executable: ${state.realClaudePath}`,
        'Reinstall Claude Code or rerun `teamem claude install` after the real `claude` is available.'
      ];
    case 'shim-missing':
      return [
        'Rerun `teamem claude install` to recreate the Teamem-owned shim.'
      ];
    case 'not-installed':
      return ['Install it with: teamem claude install'];
  }
}
