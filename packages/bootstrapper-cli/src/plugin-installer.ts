import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { detectInstalledTeamemScopeFromJson } from './claude-plugin-list.js';
import type {
  CommandProbeResult,
  CommandRunner,
  PrerequisiteReport
} from './prerequisites.js';

export type PluginScope = 'project' | 'user' | 'local';

export interface ScopeResolution {
  readonly scope: PluginScope;
  readonly source: 'flag' | 'memory' | 'detected' | 'default' | 'prompt';
}

export interface InitExecutionEnvironment {
  readonly cwd: string;
  readonly commandRunner: CommandRunner;
  readonly fileSystem?: BootstrapperFileSystem;
  readonly marketplaceSource?: string;
}

export interface BootstrapperFileSystem {
  exists(path: string): boolean;
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  mkdir(path: string): void;
}

export interface InitExecutionOptions {
  readonly dryRun: boolean;
  readonly requestedScope?: PluginScope;
  readonly report: PrerequisiteReport;
}

export interface ExecutedCommand {
  readonly command: string;
  readonly args: readonly string[];
}

export interface InitExecutionResult {
  readonly ok: boolean;
  readonly scope?: ScopeResolution;
  readonly marketplaceAction?: 'add' | 'update';
  readonly commands: readonly ExecutedCommand[];
  readonly message: string;
  readonly failure?: ExecutedCommand;
}

export const TEAMEM_MARKETPLACE = 'teamem-alpha';
export const TEAMEM_PLUGIN = 'teamem@teamem-alpha';
export const DEFAULT_MARKETPLACE_SOURCE = 'https://github.com/RubiYH/teamem';

const CONFIG_DIR = '.teamem';
const CONFIG_FILE = 'bootstrapper.json';
const SUPPORTED_SCOPES: readonly PluginScope[] = ['project', 'user', 'local'];

export function isPluginScope(value: string): value is PluginScope {
  return SUPPORTED_SCOPES.includes(value as PluginScope);
}

export function createNodeFileSystem(): BootstrapperFileSystem {
  return {
    exists(path: string): boolean {
      try {
        readFileSync(path, 'utf8');
        return true;
      } catch {
        return false;
      }
    },
    readFile(path: string): string {
      return readFileSync(path, 'utf8');
    },
    writeFile(path: string, content: string): void {
      writeFileSync(path, content, 'utf8');
    },
    mkdir(path: string): void {
      mkdirSync(path, { recursive: true });
    }
  };
}

export function resolveScope(
  options: InitExecutionEnvironment & {
    readonly requestedScope?: PluginScope;
    readonly report: PrerequisiteReport;
  }
): ScopeResolution {
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

  return {
    scope: options.report.diagnostics.some(
      (diagnostic) =>
        diagnostic.id === 'git-repository' && diagnostic.severity === 'ok'
    )
      ? 'project'
      : 'user',
    source: 'default'
  };
}

export function executeInitInstall(
  options: InitExecutionEnvironment & InitExecutionOptions
): InitExecutionResult {
  const scope = resolveScope(options);
  const marketplaceAction = detectMarketplaceAction(options.commandRunner);
  const marketplaceSource =
    options.marketplaceSource ?? DEFAULT_MARKETPLACE_SOURCE;

  const commands: ExecutedCommand[] = [
    {
      command: 'claude',
      args:
        marketplaceAction === 'add'
          ? ['plugin', 'marketplace', 'add', marketplaceSource]
          : ['plugin', 'marketplace', 'update', TEAMEM_MARKETPLACE]
    },
    {
      command: 'claude',
      args: ['plugin', 'install', TEAMEM_PLUGIN, '--scope', scope.scope]
    }
  ];

  if (options.dryRun) {
    return {
      ok: true,
      scope,
      marketplaceAction,
      commands,
      message:
        'dry-run: prerequisite checks passed; marketplace/plugin commands were planned but not executed'
    };
  }

  for (const command of commands) {
    const result = options.commandRunner.run(command.command, command.args);
    if (result.exitCode !== 0) {
      return {
        ok: false,
        scope,
        marketplaceAction,
        commands,
        failure: command,
        message: describeCommandFailure(command, result)
      };
    }
  }

  writeRememberedScope(
    options.fileSystem ?? createNodeFileSystem(),
    options.cwd,
    scope.scope
  );

  return {
    ok: true,
    scope,
    marketplaceAction,
    commands,
    message: 'Teamem marketplace/plugin install completed.'
  };
}

export function renderInitExecutionReport(
  report: PrerequisiteReport,
  execution: InitExecutionResult,
  options: { dryRun: boolean }
): string {
  const lines = [
    'teamem init',
    options.dryRun
      ? 'dry-run: prerequisites checked and install commands planned only'
      : 'executed: prerequisites checked and Teamem marketplace/plugin commands run',
    ''
  ];

  for (const diagnostic of report.diagnostics) {
    lines.push(
      `${renderSeverity(diagnostic.severity)} ${diagnostic.label}: ${diagnostic.summary}`
    );
    if (diagnostic.details) {
      lines.push(`    details: ${diagnostic.details}`);
    }
    if (diagnostic.nextStep) {
      lines.push(`    next: ${diagnostic.nextStep}`);
    }
  }

  if (execution.scope) {
    lines.push(
      '',
      `Selected plugin scope: ${execution.scope.scope} (${execution.scope.source})`
    );
  }

  if (execution.marketplaceAction) {
    lines.push(`Marketplace action: ${execution.marketplaceAction}`);
  }

  if (execution.commands.length > 0) {
    lines.push('', 'Commands:');
    for (const command of execution.commands) {
      lines.push(`- ${command.command} ${command.args.join(' ')}`);
    }
  }

  lines.push('', execution.message);
  lines.push(
    'The bootstrapper did not write MCP JSON; Claude Code plugin manifest ownership remains unchanged.'
  );

  return `${lines.join('\n')}\n`;
}

export function readRememberedScope(
  fileSystem: BootstrapperFileSystem,
  cwd: string
): PluginScope | undefined {
  const configPath = getConfigPath(cwd);
  if (!fileSystem.exists(configPath)) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(fileSystem.readFile(configPath)) as {
      pluginScope?: unknown;
    };
    const scope = String(parsed.pluginScope ?? '');
    return isPluginScope(scope) ? scope : undefined;
  } catch {
    return undefined;
  }
}

export function detectInstalledScope(
  commandRunner: CommandRunner
): PluginScope | undefined {
  const result = commandRunner.run('claude', ['plugin', 'list', '--json']);
  if (result.exitCode !== 0) {
    return undefined;
  }

  return detectInstalledTeamemScopeFromJson(result.stdout, TEAMEM_PLUGIN);
}

function detectMarketplaceAction(
  commandRunner: CommandRunner
): 'add' | 'update' {
  const result = commandRunner.run('claude', [
    'plugin',
    'marketplace',
    'list',
    '--json'
  ]);

  if (result.exitCode !== 0) {
    return 'add';
  }

  return containsMarketplace(result.stdout, TEAMEM_MARKETPLACE)
    ? 'update'
    : 'add';
}

function containsMarketplace(stdout: string, marketplaceName: string): boolean {
  const parsed = parseJson(stdout);
  if (!parsed) {
    return false;
  }

  const marketplaces = Array.isArray(parsed)
    ? parsed
    : typeof parsed === 'object' &&
        parsed !== null &&
        'marketplaces' in parsed &&
        Array.isArray(parsed.marketplaces)
      ? parsed.marketplaces
      : [];

  return marketplaces.some((entry) => {
    if (typeof entry === 'string') {
      return entry === marketplaceName;
    }
    if (typeof entry === 'object' && entry !== null) {
      const candidate = 'name' in entry ? entry.name : undefined;
      return candidate === marketplaceName;
    }
    return false;
  });
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

function writeRememberedScope(
  fileSystem: BootstrapperFileSystem,
  cwd: string,
  scope: PluginScope
): void {
  const configDir = join(cwd, CONFIG_DIR);
  fileSystem.mkdir(configDir);
  fileSystem.writeFile(
    getConfigPath(cwd),
    `${JSON.stringify({ pluginScope: scope }, null, 2)}\n`
  );
}

function getConfigPath(cwd: string): string {
  return join(cwd, CONFIG_DIR, CONFIG_FILE);
}

function renderSeverity(severity: 'ok' | 'warning' | 'error'): string {
  switch (severity) {
    case 'ok':
      return '[ok]';
    case 'warning':
      return '[warning]';
    case 'error':
      return '[error]';
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
