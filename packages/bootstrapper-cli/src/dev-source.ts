import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { delimiter, join, resolve, sep } from 'node:path';

import {
  resolveRealClaudeExecutable,
  type ClaudeLauncherFileSystem
} from './claude-launcher.js';
import {
  type CommandRunner,
  type DiagnosticSeverity
} from './prerequisites.js';

export interface DevSourceFileSystem {
  exists(path: string): boolean;
  isDirectory(path: string): boolean;
  isReadableFile(path: string): boolean;
  isExecutableFile(path: string): boolean;
  readFile(path: string): string;
}

export interface DevSourceResolution {
  readonly teamemRoot: string;
  readonly pluginRoot: string;
  readonly launchCwd: string;
  readonly source: 'flag' | 'cwd';
}

export interface DevSourceDiagnostic {
  readonly id:
    | 'bun'
    | 'real-claude'
    | 'teamem-source-checkout'
    | 'plugin-manifest'
    | 'plugin-mcp'
    | 'teamem-channel'
    | 'source-dirty';
  readonly label: string;
  readonly severity: DiagnosticSeverity;
  readonly summary: string;
  readonly nextStep?: string;
  readonly details?: string;
}

export interface DevSourceProbeReport {
  readonly resolution?: DevSourceResolution;
  readonly diagnostics: readonly DevSourceDiagnostic[];
  readonly hasErrors: boolean;
  readonly hasWarnings: boolean;
}

export function createNodeDevSourceFileSystem(): DevSourceFileSystem {
  return {
    exists(path: string): boolean {
      try {
        accessSync(path, constants.F_OK);
        return true;
      } catch {
        return false;
      }
    },
    isDirectory(path: string): boolean {
      try {
        return statSync(path).isDirectory();
      } catch {
        return false;
      }
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
    readFile(path: string): string {
      return readFileSync(path, 'utf8');
    }
  };
}

export function probeDevSourcePrerequisites(options: {
  readonly cwd: string;
  readonly requestedTeamemRoot?: string;
  readonly requestedLaunchCwd?: string;
  readonly pathEnv?: string;
  readonly homeDir?: string;
  readonly fileSystem?: DevSourceFileSystem;
  readonly commandRunner: CommandRunner;
}): DevSourceProbeReport {
  const fileSystem = options.fileSystem ?? createNodeDevSourceFileSystem();
  const launchCwd = resolve(options.requestedLaunchCwd ?? options.cwd);
  const resolution = resolveDevSourceCheckout({
    cwd: options.cwd,
    requestedTeamemRoot: options.requestedTeamemRoot,
    requestedLaunchCwd: launchCwd,
    fileSystem
  });
  const diagnostics: DevSourceDiagnostic[] = [];

  diagnostics.push(
    diagnoseBun({ commandRunner: options.commandRunner }),
    diagnoseRealClaude({
      fileSystem,
      homeDir: options.homeDir,
      pathEnv: options.pathEnv
    })
  );

  if (!resolution.ok) {
    diagnostics.push(resolution.diagnostic);
  } else {
    diagnostics.push(
      {
        id: 'teamem-source-checkout',
        label: 'Teamem source checkout',
        severity: 'ok',
        summary:
          resolution.value.source === 'flag'
            ? 'Using explicit Teamem source checkout.'
            : 'Detected Teamem source checkout from the current working directory.',
        details: resolution.value.teamemRoot
      },
      ...diagnosePluginSource(fileSystem, resolution.value),
      diagnoseDirtySource({
        commandRunner: options.commandRunner,
        teamemRoot: resolution.value.teamemRoot
      })
    );
  }

  return {
    resolution: resolution.ok ? resolution.value : undefined,
    diagnostics,
    hasErrors: diagnostics.some(
      (diagnostic) => diagnostic.severity === 'error'
    ),
    hasWarnings: diagnostics.some(
      (diagnostic) => diagnostic.severity === 'warning'
    )
  };
}

export function renderDevSourceProbeReport(
  report: DevSourceProbeReport,
  options: { readonly dryRun: boolean }
): string {
  const lines = [
    'Teamem dev source prerequisites',
    options.dryRun
      ? 'dry-run: reporting source checkout and prerequisite diagnostics only'
      : 'diagnostics: source checkout and prerequisite probes completed before launch planning',
    ''
  ];

  if (report.resolution) {
    lines.push(`Source checkout: ${report.resolution.teamemRoot}`);
    lines.push(`Plugin source: ${report.resolution.pluginRoot}`);
    lines.push(`Launch cwd: ${report.resolution.launchCwd}`);
    lines.push('');
  }

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

  lines.push('');
  if (hasSourceCheckoutError(report)) {
    lines.push(
      'source-checkout-required: Teamem dev claude requires a local Teamem source checkout and did not fall back to marketplace plugin behavior.'
    );
  } else if (report.hasErrors) {
    lines.push(
      'prerequisite-failed: Teamem dev claude source prerequisites failed before launch planning. Fix the error diagnostics above and rerun the command.'
    );
  } else {
    lines.push('Source checkout prerequisites passed.');
  }

  return `${lines.join('\n')}\n`;
}

function hasSourceCheckoutError(report: DevSourceProbeReport): boolean {
  return report.diagnostics.some(
    (diagnostic) =>
      diagnostic.id === 'teamem-source-checkout' &&
      diagnostic.severity === 'error'
  );
}

function resolveDevSourceCheckout(options: {
  readonly cwd: string;
  readonly requestedTeamemRoot?: string;
  readonly requestedLaunchCwd: string;
  readonly fileSystem: DevSourceFileSystem;
}):
  | { readonly ok: true; readonly value: DevSourceResolution }
  | { readonly ok: false; readonly diagnostic: DevSourceDiagnostic } {
  if (options.requestedTeamemRoot) {
    const teamemRoot = resolve(options.requestedTeamemRoot);
    if (!isLikelyTeamemSourceRoot(options.fileSystem, teamemRoot)) {
      return {
        ok: false,
        diagnostic: sourceRequiredDiagnostic(
          `Explicit --teamem-root is not a Teamem source checkout: ${teamemRoot}`
        )
      };
    }
    return {
      ok: true,
      value: {
        teamemRoot,
        pluginRoot: join(teamemRoot, 'plugin'),
        launchCwd: options.requestedLaunchCwd,
        source: 'flag'
      }
    };
  }

  const detectedRoot = findTeamemSourceRoot(options.fileSystem, options.cwd);
  if (!detectedRoot) {
    return {
      ok: false,
      diagnostic: sourceRequiredDiagnostic(
        'No Teamem source checkout was found from the current working directory.'
      )
    };
  }

  return {
    ok: true,
    value: {
      teamemRoot: detectedRoot,
      pluginRoot: join(detectedRoot, 'plugin'),
      launchCwd: options.requestedLaunchCwd,
      source: 'cwd'
    }
  };
}

function findTeamemSourceRoot(
  fileSystem: DevSourceFileSystem,
  cwd: string
): string | undefined {
  let current = resolve(cwd);
  while (true) {
    if (isLikelyTeamemSourceRoot(fileSystem, current)) {
      return current;
    }
    const parent = current.endsWith(sep)
      ? current
      : current.slice(0, current.lastIndexOf(sep)) || sep;
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

function isLikelyTeamemSourceRoot(
  fileSystem: DevSourceFileSystem,
  root: string
): boolean {
  if (!fileSystem.isDirectory(root)) {
    return false;
  }
  const packagePath = join(root, 'package.json');
  if (!fileSystem.isReadableFile(packagePath)) {
    return false;
  }
  try {
    const parsed = JSON.parse(fileSystem.readFile(packagePath)) as {
      name?: unknown;
      private?: unknown;
    };
    return parsed.name === 'teamem' && parsed.private === true;
  } catch {
    return false;
  }
}

function diagnoseBun(options: {
  readonly commandRunner: CommandRunner;
}): DevSourceDiagnostic {
  const probe = options.commandRunner.run('bun', ['--version']);
  if (probe.exitCode === 0) {
    return {
      id: 'bun',
      label: 'Bun',
      severity: 'ok',
      summary: 'Detected via `bun --version`.',
      details: probe.stdout.trim() || undefined
    };
  }
  return {
    id: 'bun',
    label: 'Bun',
    severity: 'error',
    summary:
      probe.errorCode === 'ENOENT'
        ? 'The `bun` command is not available on PATH.'
        : 'The `bun --version` probe failed.',
    details: describeProbeFailure(probe),
    nextStep:
      'Install Bun before rerunning `teamem dev claude`; local source plugin servers run with Bun.'
  };
}

function diagnoseRealClaude(options: {
  readonly fileSystem: DevSourceFileSystem;
  readonly pathEnv?: string;
  readonly homeDir?: string;
}): DevSourceDiagnostic {
  const realClaudePath = resolveRealClaudeExecutable({
    fileSystem: options.fileSystem as unknown as ClaudeLauncherFileSystem,
    pathEnv: options.pathEnv,
    homeDir: options.homeDir
  });
  if (realClaudePath) {
    return {
      id: 'real-claude',
      label: 'Real Claude Code',
      severity: 'ok',
      summary: 'Detected a Claude Code executable outside Teamem-owned shim paths.',
      details: realClaudePath
    };
  }
  return {
    id: 'real-claude',
    label: 'Real Claude Code',
    severity: 'error',
    summary:
      "Could not find the real Claude Code executable outside Teamem's shim directory.",
    nextStep:
      'Install Claude Code or put the real `claude` executable on PATH before rerunning `teamem dev claude`.'
  };
}

function diagnosePluginSource(
  fileSystem: DevSourceFileSystem,
  resolution: DevSourceResolution
): readonly DevSourceDiagnostic[] {
  const manifestPath = join(
    resolution.pluginRoot,
    '.claude-plugin',
    'plugin.json'
  );
  const manifest = readJsonFile(fileSystem, manifestPath);
  if (!manifest.ok) {
    return [
      {
        id: 'plugin-manifest',
        label: 'Plugin manifest',
        severity: 'error',
        summary: manifest.message,
        details: manifestPath,
        nextStep:
          'Use a complete Teamem source checkout with plugin/.claude-plugin/plugin.json.'
      }
    ];
  }

  const manifestServersPath =
    isRecord(manifest.value) && typeof manifest.value.mcpServers === 'string'
      ? manifest.value.mcpServers
      : undefined;
  if (manifestServersPath !== './.mcp.json') {
    return [
      {
        id: 'plugin-manifest',
        label: 'Plugin manifest',
        severity: 'error',
        summary:
          'Plugin manifest does not point at the local plugin MCP declaration.',
        details: manifestPath,
        nextStep:
          'Restore the Teamem plugin manifest mcpServers entry to "./.mcp.json".'
      }
    ];
  }

  const mcpPath = join(resolution.pluginRoot, '.mcp.json');
  const mcp = readJsonFile(fileSystem, mcpPath);
  if (!mcp.ok) {
    return [
      okDiagnostic('plugin-manifest', 'Plugin manifest', manifestPath),
      {
        id: 'plugin-mcp',
        label: 'Plugin MCP declaration',
        severity: 'error',
        summary: mcp.message,
        details: mcpPath,
        nextStep: 'Restore plugin/.mcp.json in the Teamem source checkout.'
      }
    ];
  }

  const mcpServers = isRecord(mcp.value) ? mcp.value.mcpServers : undefined;
  if (!isRecord(mcpServers) || !isRecord(mcpServers.teamem)) {
    return [
      okDiagnostic('plugin-manifest', 'Plugin manifest', manifestPath),
      {
        id: 'plugin-mcp',
        label: 'Plugin MCP declaration',
        severity: 'error',
        summary: 'Plugin MCP declaration is missing the `teamem` server.',
        details: mcpPath,
        nextStep: 'Restore the Teamem bridge server declaration.'
      }
    ];
  }
  if (!isRecord(mcpServers['teamem-channel'])) {
    return [
      okDiagnostic('plugin-manifest', 'Plugin manifest', manifestPath),
      okDiagnostic('plugin-mcp', 'Plugin MCP declaration', mcpPath),
      {
        id: 'teamem-channel',
        label: 'Teamem channel declaration',
        severity: 'error',
        summary:
          'Plugin MCP declaration is missing the `teamem-channel` server.',
        details: mcpPath,
        nextStep:
          'Restore the local teamem-channel MCP declaration before using source-checkout dev launch.'
      }
    ];
  }

  return [
    okDiagnostic('plugin-manifest', 'Plugin manifest', manifestPath),
    okDiagnostic('plugin-mcp', 'Plugin MCP declaration', mcpPath),
    {
      id: 'teamem-channel',
      label: 'Teamem channel declaration',
      severity: 'ok',
      summary: 'Plugin MCP declaration includes `teamem-channel`.',
      details: mcpPath
    }
  ];
}

function diagnoseDirtySource(options: {
  readonly commandRunner: CommandRunner;
  readonly teamemRoot: string;
}): DevSourceDiagnostic {
  const branch = options.commandRunner.run('git', [
    '-C',
    options.teamemRoot,
    'branch',
    '--show-current'
  ]);
  const status = options.commandRunner.run('git', [
    '-C',
    options.teamemRoot,
    'status',
    '--short'
  ]);
  if (status.exitCode !== 0) {
    return {
      id: 'source-dirty',
      label: 'Source checkout state',
      severity: 'warning',
      summary: 'Could not inspect dirty state for the Teamem source checkout.',
      details: describeProbeFailure(status)
    };
  }
  const dirtyLines = status.stdout
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean);
  const branchName = branch.exitCode === 0 ? branch.stdout.trim() : '';
  if (dirtyLines.length === 0) {
    return {
      id: 'source-dirty',
      label: 'Source checkout state',
      severity: 'ok',
      summary: `Source checkout is clean${branchName ? ` on ${branchName}` : ''}.`
    };
  }
  return {
    id: 'source-dirty',
    label: 'Source checkout state',
    severity: 'warning',
    summary: `Source checkout has ${dirtyLines.length} dirty path(s)${
      branchName ? ` on ${branchName}` : ''
    }; continuing because dirty state is disclosed, not blocking.`,
    details: dirtyLines.slice(0, 5).join('\n')
  };
}

function sourceRequiredDiagnostic(summary: string): DevSourceDiagnostic {
  return {
    id: 'teamem-source-checkout',
    label: 'Teamem source checkout',
    severity: 'error',
    summary,
    nextStep:
      'Run `teamem dev claude` from inside a Teamem source checkout or pass --teamem-root <path-to-teamem-source>.'
  };
}

function okDiagnostic(
  id: 'plugin-manifest' | 'plugin-mcp',
  label: string,
  details: string
): DevSourceDiagnostic {
  return {
    id,
    label,
    severity: 'ok',
    summary: 'Found and validated.',
    details
  };
}

function readJsonFile(
  fileSystem: DevSourceFileSystem,
  path: string
): { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly message: string } {
  if (!fileSystem.isReadableFile(path)) {
    return { ok: false, message: 'Required JSON file is missing or unreadable.' };
  }
  try {
    return { ok: true, value: JSON.parse(fileSystem.readFile(path)) };
  } catch {
    return { ok: false, message: 'Required JSON file is malformed.' };
  }
}

function describeProbeFailure(probe: {
  readonly stdout: string;
  readonly stderr: string;
  readonly errorCode?: string;
}): string | undefined {
  return [probe.errorCode, probe.stderr.trim(), probe.stdout.trim()]
    .filter((value): value is string => Boolean(value))
    .join(' | ') || undefined;
}

function renderSeverity(severity: DiagnosticSeverity): string {
  switch (severity) {
    case 'ok':
      return '[ok]';
    case 'warning':
      return '[warning]';
    case 'error':
      return '[error]';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function splitDevPath(pathEnv: string): readonly string[] {
  return pathEnv
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
}
