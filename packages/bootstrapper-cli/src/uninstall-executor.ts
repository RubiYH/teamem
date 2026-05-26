import { rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  TEAMEM_MARKETPLACE,
  TEAMEM_PLUGIN,
  type BootstrapperFileSystem,
  type ExecutedCommand,
  type PluginScope,
  type ScopeResolution
} from './plugin-installer.js';
import { resolveUpdateScope } from './update-executor.js';
import type { CommandRunner } from './prerequisites.js';
import type { GitHookInstallResult, GitHookInstaller } from './git-hooks.js';
import {
  createNodeClaudeLauncherFileSystem,
  uninstallClaudeLauncher,
  type ClaudeLauncherFileSystem,
  type ClaudeLauncherResult
} from './claude-launcher.js';

export interface LocalStateFileSystem {
  rm(path: string): void;
}

export interface UninstallExecutionEnvironment {
  readonly cwd: string;
  readonly commandRunner: CommandRunner;
  readonly scopeFileSystem?: BootstrapperFileSystem;
  readonly localStateFileSystem?: LocalStateFileSystem;
  readonly claudeLauncherFileSystem?: ClaudeLauncherFileSystem;
  readonly gitHookInstaller?: Pick<GitHookInstaller, 'uninstall'>;
  readonly homeDir?: string;
  readonly pathEnv?: string;
  readonly now?: () => Date;
}

export interface UninstallExecutionOptions {
  readonly dryRun: boolean;
  readonly requestedScope?: PluginScope;
  readonly keepCredentials?: boolean;
}

export interface UninstallExecutionResult {
  readonly ok: boolean;
  readonly status: 'success' | 'partial' | 'failed';
  readonly scope?: ScopeResolution;
  readonly commands: readonly ExecutedCommand[];
  readonly commandFailures: readonly UninstallCommandFailure[];
  readonly hookCleanup?: GitHookInstallResult;
  readonly launcherCleanup?: ClaudeLauncherResult;
  readonly removedPaths: readonly string[];
  readonly localCleanupFailures: readonly LocalCleanupFailure[];
  readonly message: string;
  readonly failure?: ExecutedCommand;
}

export interface UninstallCommandFailure {
  readonly command: ExecutedCommand;
  readonly result: ReturnType<CommandRunner['run']>;
  readonly message: string;
}

export interface LocalCleanupFailure {
  readonly path: string;
  readonly message: string;
}

export function createNodeLocalStateFileSystem(): LocalStateFileSystem {
  return {
    rm(path: string): void {
      rmSync(path, { recursive: true, force: true });
    }
  };
}

export function executeUninstall(
  options: UninstallExecutionEnvironment & UninstallExecutionOptions
): UninstallExecutionResult {
  const scope = resolveUpdateScope({
    cwd: options.cwd,
    commandRunner: options.commandRunner,
    fileSystem: options.scopeFileSystem,
    requestedScope: options.requestedScope
  });
  if (!scope) {
    if (options.dryRun) {
      return {
        ok: false,
        status: 'partial',
        commands: [],
        commandFailures: [],
        removedPaths: buildLocalStatePaths({
          cwd: options.cwd,
          homeDir: options.homeDir ?? homedir(),
          keepCredentials: options.keepCredentials ?? false
        }),
        localCleanupFailures: [],
        message:
          'Could not determine which Claude Code plugin scope to uninstall. Dry-run planned local cleanup only; re-run with `teamem uninstall --scope <project|user|local>` to also plan Claude Code plugin removal.'
      };
    }

    const cleanup = runLocalCleanup(options);
    const hookCleanup = options.gitHookInstaller?.uninstall();
    const launcherCleanup = runLauncherCleanup(options);
    const cleanupFailed =
      cleanup.localCleanupFailures.length > 0 ||
      (hookCleanup ? !hookCleanup.ok : false) ||
      !launcherCleanup.ok;
    return {
      ok: false,
      status: cleanupFailed ? 'failed' : 'partial',
      commands: [],
      commandFailures: [],
      hookCleanup,
      launcherCleanup,
      removedPaths: cleanup.removedPaths,
      localCleanupFailures: cleanup.localCleanupFailures,
      message:
        'Could not determine which Claude Code plugin scope to uninstall. Local cleanup still ran where possible. Re-run with `teamem uninstall --scope <project|user|local>` to remove the Claude Code plugin.'
    };
  }

  const commands: ExecutedCommand[] = [
    {
      command: 'claude',
      args: [
        'plugin',
        'uninstall',
        TEAMEM_PLUGIN,
        '--scope',
        scope.scope,
        '--prune',
        '-y'
      ]
    },
    {
      command: 'claude',
      args: ['plugin', 'marketplace', 'remove', TEAMEM_MARKETPLACE]
    }
  ];
  const removedPaths = buildLocalStatePaths({
    cwd: options.cwd,
    homeDir: options.homeDir ?? homedir(),
    keepCredentials: options.keepCredentials ?? false
  });

  if (options.dryRun) {
    const launcherCleanup = runLauncherCleanup(options);
    return {
      ok: true,
      status: 'success',
      scope,
      commands,
      commandFailures: [],
      launcherCleanup,
      removedPaths,
      localCleanupFailures: [],
      message:
        'dry-run: plugin uninstall, marketplace removal, git hook uninstall, launcher cleanup, and local cleanup were planned but not executed'
    };
  }

  const commandFailures: UninstallCommandFailure[] = [];
  for (const command of commands) {
    const result = options.commandRunner.run(command.command, command.args);
    if (result.exitCode !== 0) {
      commandFailures.push({
        command,
        result,
        message: describeCommandFailure(command, result)
      });
    }
  }

  const hookCleanup = options.gitHookInstaller?.uninstall();
  const cleanup = runLocalCleanup(options, removedPaths);
  const launcherCleanup = runLauncherCleanup(options);
  const hasHookFailure = hookCleanup ? !hookCleanup.ok : false;
  const hasFailure =
    commandFailures.length > 0 ||
    hasHookFailure ||
    !launcherCleanup.ok ||
    cleanup.localCleanupFailures.length > 0;

  return {
    ok: !hasFailure,
    status: hasFailure ? 'partial' : 'success',
    scope,
    commands,
    commandFailures,
    hookCleanup,
    launcherCleanup,
    removedPaths: cleanup.removedPaths,
    localCleanupFailures: cleanup.localCleanupFailures,
    failure: commandFailures[0]?.command,
    message: hasFailure
      ? 'Some uninstall steps failed; remaining cleanup ran where possible.'
      : 'Teamem plugin, git hooks, launcher files, and local state were uninstalled.'
  };
}

export function renderUninstallExecutionReport(
  execution: UninstallExecutionResult,
  options: { dryRun: boolean }
): string {
  const lines = [
    'teamem uninstall',
    renderUninstallStatusLine(execution, options),
    ''
  ];

  if (execution.scope) {
    lines.push(
      `Selected plugin scope: ${execution.scope.scope} (${execution.scope.source})`,
      ''
    );
  }

  if (execution.commands.length > 0) {
    lines.push('Commands:');
    for (const command of execution.commands) {
      lines.push(`  - ${command.command} ${command.args.join(' ')}`);
    }
    lines.push('');
  }

  if (execution.commandFailures.length > 0) {
    lines.push('Failed commands:');
    for (const failure of execution.commandFailures) {
      lines.push(`  - ${failure.message}`);
    }
    lines.push('');
  }

  if (execution.hookCleanup) {
    lines.push(
      `Git hooks: ${execution.hookCleanup.ok ? 'OK' : 'ERROR'}: ${execution.hookCleanup.message}`,
      ''
    );
  }

  if (execution.launcherCleanup) {
    lines.push(
      `Claude launcher: ${execution.launcherCleanup.ok ? 'OK' : 'ERROR'}: ${execution.launcherCleanup.message}`
    );
    if (execution.launcherCleanup.plannedRemovals.length > 0) {
      for (const path of execution.launcherCleanup.plannedRemovals) {
        lines.push(`  - ${path}`);
      }
    }
    for (const detail of execution.launcherCleanup.details) {
      lines.push(`  ${detail}`);
    }
    lines.push('');
  }

  if (execution.removedPaths.length > 0) {
    lines.push('Local paths:');
    for (const path of execution.removedPaths) {
      lines.push(`  - ${path}`);
    }
    lines.push('');
  }

  if (execution.localCleanupFailures.length > 0) {
    lines.push('Local cleanup failures:');
    for (const failure of execution.localCleanupFailures) {
      lines.push(`  - ${failure.path}: ${failure.message}`);
    }
    lines.push('');
  }

  lines.push(
    execution.ok ? `OK: ${execution.message}` : `ERROR: ${execution.message}`
  );
  return `${lines.join('\n')}\n`;
}

function renderUninstallStatusLine(
  execution: UninstallExecutionResult,
  options: { dryRun: boolean }
): string {
  if (options.dryRun) {
    if (!execution.scope) {
      return 'dry-run: local cleanup planned only; plugin uninstall needs an explicit scope';
    }
    return 'dry-run: uninstall commands, git hook uninstall, launcher cleanup, and local cleanup planned only';
  }
  if (execution.status === 'success') {
    return 'executed: Teamem plugin, git hooks, launcher cleanup, and local cleanup completed';
  }
  if (execution.status === 'partial') {
    return 'partial: some uninstall steps failed; completed remaining cleanup where possible';
  }
  return 'failed: Teamem uninstall could not complete cleanup';
}

function runLauncherCleanup(
  options: UninstallExecutionEnvironment & UninstallExecutionOptions
): ClaudeLauncherResult {
  return uninstallClaudeLauncher({
    homeDir: options.homeDir,
    pathEnv: options.pathEnv,
    fileSystem:
      options.claudeLauncherFileSystem ?? createNodeClaudeLauncherFileSystem(),
    now: options.now,
    dryRun: options.dryRun
  });
}

function buildLocalStatePaths(options: {
  cwd: string;
  homeDir: string;
  keepCredentials: boolean;
}): string[] {
  const paths = [
    join(options.homeDir, '.teamem', 'run'),
    join(options.homeDir, '.cache', 'teamem'),
    ...buildPluginDataPaths(options.homeDir),
    join(options.cwd, '.teamem', 'bootstrapper.json')
  ];
  if (!options.keepCredentials) {
    paths.unshift(join(options.homeDir, '.teamem', 'credentials.json'));
  }
  return paths;
}

function buildPluginDataPaths(homeDir: string): string[] {
  const dataRoot = join(homeDir, '.claude', 'plugins', 'data');
  return [
    join(dataRoot, 'teamem'),
    join(dataRoot, 'teamem-teamem-alpha'),
    join(dataRoot, 'teamem-teamem-local'),
    join(dataRoot, 'teamem-teamem2-local'),
    join(dataRoot, 'teamem2'),
    join(dataRoot, 'teamem2-teamem-alpha'),
    join(dataRoot, 'teamem2-teamem-local'),
    join(dataRoot, 'teamem2-teamem2-local'),
    join(dataRoot, 'teamem2-inline'),
    join(dataRoot, 'teamem-inline')
  ];
}

function runLocalCleanup(
  options: UninstallExecutionEnvironment & UninstallExecutionOptions,
  paths = buildLocalStatePaths({
    cwd: options.cwd,
    homeDir: options.homeDir ?? homedir(),
    keepCredentials: options.keepCredentials ?? false
  })
): {
  readonly removedPaths: readonly string[];
  readonly localCleanupFailures: readonly LocalCleanupFailure[];
} {
  const fileSystem =
    options.localStateFileSystem ?? createNodeLocalStateFileSystem();
  const localCleanupFailures: LocalCleanupFailure[] = [];
  for (const path of paths) {
    try {
      fileSystem.rm(path);
    } catch (error) {
      localCleanupFailures.push({
        path,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return {
    removedPaths: paths,
    localCleanupFailures
  };
}

function describeCommandFailure(
  command: ExecutedCommand,
  result: ReturnType<CommandRunner['run']>
): string {
  const details = [result.stderr.trim(), result.stdout.trim()]
    .filter(Boolean)
    .join(' | ');
  const suffix = details ? ` (${details})` : '';
  return `Command failed: ${command.command} ${command.args.join(' ')}${suffix}`;
}
