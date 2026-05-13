import {
  TEAMEM_MARKETPLACE,
  TEAMEM_PLUGIN,
  createNodeFileSystem,
  detectInstalledScope,
  readRememberedScope,
  type BootstrapperFileSystem,
  type ExecutedCommand,
  type PluginScope
} from './plugin-installer.js';
import type { CommandProbeResult, CommandRunner } from './prerequisites.js';

export interface UpdateExecutionEnvironment {
  readonly cwd: string;
  readonly commandRunner: CommandRunner;
  readonly fileSystem?: BootstrapperFileSystem;
}

export interface UpdateScopeResolution {
  readonly scope: PluginScope;
  readonly source: 'flag' | 'memory' | 'detected';
}

export interface UpdateExecutionOptions {
  readonly dryRun: boolean;
  readonly requestedScope?: PluginScope;
}

export interface UpdateExecutionResult {
  readonly ok: boolean;
  readonly scope?: UpdateScopeResolution;
  readonly commands: readonly ExecutedCommand[];
  readonly message: string;
  readonly failure?: ExecutedCommand;
}

export function resolveUpdateScope(
  options: UpdateExecutionEnvironment & {
    readonly requestedScope?: PluginScope;
  }
): UpdateScopeResolution | undefined {
  if (options.requestedScope) {
    return {
      scope: options.requestedScope,
      source: 'flag'
    };
  }

  const rememberedScope = readRememberedScope(
    options.fileSystem ?? createNodeFileSystem(),
    options.cwd
  );
  if (rememberedScope) {
    return {
      scope: rememberedScope,
      source: 'memory'
    };
  }

  const detectedScope = detectInstalledScope(options.commandRunner);
  if (detectedScope) {
    return {
      scope: detectedScope,
      source: 'detected'
    };
  }

  return undefined;
}

export function executePluginUpdate(
  options: UpdateExecutionEnvironment & UpdateExecutionOptions
): UpdateExecutionResult {
  const scope = resolveUpdateScope(options);
  if (!scope) {
    return {
      ok: false,
      commands: [],
      message:
        'Could not determine which Claude Code plugin scope to update. Re-run `teamem update --scope <project|user|local>`, or run `teamem init` first so Teamem can remember the installed scope.'
    };
  }

  const commands: ExecutedCommand[] = [
    {
      command: 'claude',
      args: ['plugin', 'marketplace', 'update', TEAMEM_MARKETPLACE]
    },
    {
      command: 'claude',
      args: ['plugin', 'update', TEAMEM_PLUGIN, '--scope', scope.scope]
    }
  ];

  if (options.dryRun) {
    return {
      ok: true,
      scope,
      commands,
      message:
        'dry-run: marketplace/plugin update commands were planned but not executed'
    };
  }

  for (const command of commands) {
    const result = options.commandRunner.run(command.command, command.args);
    if (result.exitCode !== 0) {
      return {
        ok: false,
        scope,
        commands,
        failure: command,
        message: describeCommandFailure(command, result)
      };
    }
  }

  return {
    ok: true,
    scope,
    commands,
    message: 'Teamem marketplace/plugin update completed.'
  };
}

export function renderUpdateExecutionReport(
  execution: UpdateExecutionResult,
  options: { dryRun: boolean }
): string {
  const lines = [
    'teamem update',
    options.dryRun
      ? 'dry-run: marketplace/plugin update commands were planned only'
      : execution.ok
        ? 'executed: Teamem marketplace/plugin update commands ran'
        : 'failed: Teamem marketplace/plugin update stopped before completion'
  ];

  if (execution.scope) {
    lines.push(
      '',
      `Selected plugin scope: ${execution.scope.scope} (${execution.scope.source})`
    );
  }

  if (execution.commands.length > 0) {
    lines.push('', 'Commands:');
    for (const command of execution.commands) {
      lines.push(`- ${command.command} ${command.args.join(' ')}`);
    }
  }

  lines.push('', execution.message);
  return `${lines.join('\n')}\n`;
}

function describeCommandFailure(
  command: ExecutedCommand,
  result: CommandProbeResult
): string {
  const suffix = [result.stderr.trim(), result.stdout.trim()]
    .filter((value) => value.length > 0)
    .join(' | ');
  const renderedCommand = `${command.command} ${command.args.join(' ')}`;
  return suffix.length > 0
    ? `Command failed: ${renderedCommand} (${suffix})`
    : `Command failed: ${renderedCommand}`;
}
