import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

import {
  createNodeClaudeLauncherFileSystem,
  type ClaudeLauncherFileSystem
} from './claude-launcher.js';
import type { CommandRunner } from './prerequisites.js';
import type { PluginScope, ScopeResolution } from './plugin-installer.js';
import {
  readStatuslineDisplayCache,
  resolveStatuslineRenderContext,
  type StatuslineDisplayCacheOptions
} from './statusline-display-cache.js';

export type ClaudeStatuslineCommand =
  | 'install'
  | 'status'
  | 'uninstall'
  | 'render';

export type ClaudeStatuslineStatus = 'missing' | 'installed' | 'foreign';

export interface ClaudeStatuslineEnvironment {
  readonly cwd: string;
  readonly homeDir?: string;
  readonly fileSystem?: ClaudeLauncherFileSystem;
  readonly commandRunner?: CommandRunner;
  readonly scope?: PluginScope;
  readonly dryRun: boolean;
}

export interface ClaudeStatuslineResult {
  readonly ok: boolean;
  readonly command: Exclude<ClaudeStatuslineCommand, 'render'>;
  readonly dryRun: boolean;
  readonly status: ClaudeStatuslineStatus;
  readonly scope: ScopeResolution;
  readonly effectiveStatus: ClaudeStatuslineStatus;
  readonly effectiveScope?: PluginScope;
  readonly selectedEffective: boolean;
  readonly settingsPath: string;
  readonly statuslineCommand: string;
  readonly plannedWrites: readonly string[];
  readonly message: string;
  readonly details: readonly string[];
}

const SETTINGS_DIRECTORY = '.claude';
const SETTINGS_FILE = 'settings.json';
export const TEAMEM_STATUSLINE_COMMAND = 'teamem claude statusline render';

const ANSI_ESCAPE_SEQUENCE_PATTERN =
  /(?:\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)|\u001b[PX^_][\s\S]*?\u001b\\|\u001b[@-_])/g;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/g;
const ANSI_RESET = '\x1b[0m';
const ANSI_TEAMEM_BROWN = '\x1b[38;2;139;94;52m';
const ANSI_SPACE_CYAN = '\x1b[38;2;34;211;238m';
const ANSI_DIM_GRAY = '\x1b[2;38;2;156;163;175m';
const ANSI_CONTEXT_GREEN = '\x1b[38;2;34;197;94m';
const ANSI_CONTEXT_YELLOW = '\x1b[38;2;234;179;8m';
const ANSI_CONTEXT_RED = '\x1b[38;2;239;68;68m';

interface ClaudeSettings {
  [key: string]: unknown;
  statusLine?: unknown;
}

interface StatusLineCommand {
  readonly type: 'command';
  readonly command: string;
}

export function installClaudeStatusline(
  environment: ClaudeStatuslineEnvironment
): ClaudeStatuslineResult {
  const context = buildContext(environment);
  const settings = readSettings(context);
  if (!settings.ok) {
    return settingsFailure(
      'install',
      context,
      settings.message,
      environment.dryRun
    );
  }
  const current = classifyStatusline(settings.value);
  if (current === 'foreign') {
    return {
      ok: false,
      command: 'install',
      dryRun: environment.dryRun,
      status: 'foreign',
      scope: context.selectedScope,
      effectiveStatus: 'foreign',
      effectiveScope: context.selectedScope.scope,
      selectedEffective: true,
      settingsPath: context.settingsPath,
      statuslineCommand: TEAMEM_STATUSLINE_COMMAND,
      plannedWrites: [],
      message: 'Refusing to overwrite a non-Teamem Claude statusline.',
      details: [
        `Remove or edit ${context.settingsPath} before enabling Teamem statusline for this scope.`,
        'Teamem does not provide --force for statusline installation.'
      ]
    };
  }

  const nextSettings = {
    ...settings.value,
    statusLine: renderStatusLineSetting()
  };
  const effective = getEffectiveStatusline(context, {
    scope: context.selectedScope.scope,
    status: 'installed'
  });
  if (!environment.dryRun) {
    context.fileSystem.mkdir(context.selectedSettingsDir);
    context.fileSystem.writeFile(
      context.settingsPath,
      `${JSON.stringify(nextSettings, null, 2)}\n`
    );
  }

  return {
    ok: true,
    command: 'install',
    dryRun: environment.dryRun,
    status: 'installed',
    scope: context.selectedScope,
    effectiveStatus: effective.status,
    effectiveScope: effective.scope,
    selectedEffective: effective.scope === context.selectedScope.scope,
    settingsPath: context.settingsPath,
    statuslineCommand: TEAMEM_STATUSLINE_COMMAND,
    plannedWrites: [context.settingsPath],
    message:
      current === 'installed'
        ? 'Teamem Claude statusline was already installed.'
        : `Teamem Claude statusline was installed for ${context.selectedScope.scope} scope.`,
    details: [
      `Scope source: ${context.selectedScope.source}`,
      ...renderEffectiveDetails(context, 'installed', effective),
      'No backup or restore artifact was created.',
      'The renderer is standalone and does not call MCP, Teamem server, or monitor processes.'
    ]
  };
}

export function getClaudeStatuslineStatus(
  environment: ClaudeStatuslineEnvironment
): ClaudeStatuslineResult {
  const context = buildContext(environment);
  const settings = readSettings(context);
  if (!settings.ok) {
    return settingsFailure(
      'status',
      context,
      settings.message,
      environment.dryRun
    );
  }
  const status = classifyStatusline(settings.value);
  const effective = getEffectiveStatusline(context);
  const selectedEffective = effective.scope === context.selectedScope.scope;
  return {
    ok: status !== 'foreign' && !(status === 'installed' && !selectedEffective),
    command: 'status',
    dryRun: environment.dryRun,
    status,
    scope: context.selectedScope,
    effectiveStatus: effective.status,
    effectiveScope: effective.scope,
    selectedEffective,
    settingsPath: context.settingsPath,
    statuslineCommand: TEAMEM_STATUSLINE_COMMAND,
    plannedWrites: [],
    message:
      status === 'installed'
        ? `Teamem Claude statusline is installed for ${context.selectedScope.scope} scope.`
        : status === 'foreign'
          ? `A non-Teamem Claude statusline is configured for ${context.selectedScope.scope} scope.`
          : `Teamem Claude statusline is not installed for ${context.selectedScope.scope} scope.`,
    details:
      status === 'foreign'
        ? [
            'Teamem will not overwrite user-owned statusline settings.',
            `Remove or edit ${context.settingsPath} before enabling Teamem statusline.`,
            ...renderEffectiveDetails(context, status, effective)
          ]
        : [
            `Scope source: ${context.selectedScope.source}`,
            ...renderEffectiveDetails(context, status, effective)
          ]
  };
}

export function uninstallClaudeStatusline(
  environment: ClaudeStatuslineEnvironment
): ClaudeStatuslineResult {
  const context = buildContext(environment);
  const settings = readSettings(context);
  if (!settings.ok) {
    return settingsFailure(
      'uninstall',
      context,
      settings.message,
      environment.dryRun
    );
  }
  const status = classifyStatusline(settings.value);
  if (status !== 'installed') {
    const effective = getEffectiveStatusline(context);
    return {
      ok: true,
      command: 'uninstall',
      dryRun: environment.dryRun,
      status,
      scope: context.selectedScope,
      effectiveStatus: effective.status,
      effectiveScope: effective.scope,
      selectedEffective: effective.scope === context.selectedScope.scope,
      settingsPath: context.settingsPath,
      statuslineCommand: TEAMEM_STATUSLINE_COMMAND,
      plannedWrites: [],
      message:
        status === 'foreign'
          ? `Skipped cleanup because the ${context.selectedScope.scope} statusline is not Teamem-owned.`
          : `No Teamem Claude statusline was installed for ${context.selectedScope.scope} scope.`,
      details:
        status === 'foreign'
          ? ['Foreign or user-edited statusline was left untouched.']
          : [`Scope source: ${context.selectedScope.source}`]
    };
  }

  const nextSettings = { ...settings.value };
  delete nextSettings.statusLine;
  if (!environment.dryRun) {
    context.fileSystem.writeFile(
      context.settingsPath,
      `${JSON.stringify(nextSettings, null, 2)}\n`
    );
  }
  const effective = getEffectiveStatusline(context, {
    scope: context.selectedScope.scope,
    status: 'missing'
  });

  return {
    ok: true,
    command: 'uninstall',
    dryRun: environment.dryRun,
    status: 'missing',
    scope: context.selectedScope,
    effectiveStatus: effective.status,
    effectiveScope: effective.scope,
    selectedEffective: false,
    settingsPath: context.settingsPath,
    statuslineCommand: TEAMEM_STATUSLINE_COMMAND,
    plannedWrites: [context.settingsPath],
    message: `Teamem Claude statusline was removed from ${context.selectedScope.scope} scope.`,
    details: ['Only the exact Teamem wrapper command was removed.']
  };
}

export function renderClaudeStatusline(
  input?: string,
  cacheOptions?: StatuslineDisplayCacheOptions
): string {
  return `${renderFallbackStatusline(input ?? readStatuslineStdin(), cacheOptions)}\n`;
}

export function renderFallbackStatusline(
  input: string,
  cacheOptions?: StatuslineDisplayCacheOptions
): string {
  try {
    const parsed = JSON.parse(input) as Record<string, unknown>;
    const model = readNestedString(parsed, ['model', 'display_name']);
    const cwd =
      readNestedString(parsed, ['workspace', 'current_dir']) ??
      readNestedString(parsed, ['cwd']);
    const contextPercent = readContextPercent(parsed);
    const displayState = readStatuslineDisplayCache(
      resolveStatuslineRenderContext(parsed),
      cacheOptions
    );
    const parts = [colorStatuslineSegment('Teamem', ANSI_TEAMEM_BROWN)];
    const spaceLabel = displayState.space?.label
      ? sanitizeStatuslineSegment(displayState.space.label)
      : undefined;
    if (spaceLabel) {
      parts.push(colorStatuslineSegment(spaceLabel, ANSI_SPACE_CYAN));
    }
    const sprintName = displayState.sprint?.name
      ? sanitizeStatuslineSegment(displayState.sprint.name)
      : undefined;
    if (sprintName) {
      parts.push(
        `${colorStatuslineSegment('Sprint', ANSI_DIM_GRAY)} ${sprintName}`
      );
    }
    if (contextPercent !== undefined) {
      parts.push(
        colorStatuslineSegment(
          `ctx ${contextPercent}%`,
          getContextStatuslineColor(contextPercent)
        )
      );
    }
    const modelLabel = model ? sanitizeStatuslineSegment(model) : undefined;
    if (modelLabel) {
      parts.push(colorStatuslineSegment(modelLabel, ANSI_DIM_GRAY));
    }
    const cwdLabel = cwd
      ? sanitizeStatuslineSegment(basename(cwd) || cwd)
      : undefined;
    if (cwdLabel) {
      parts.push(colorStatuslineSegment(cwdLabel, ANSI_DIM_GRAY));
    }
    return joinStatuslineSegments(parts);
  } catch {
    return 'Teamem | status unavailable';
  }
}

export function renderClaudeStatuslineReport(
  result: ClaudeStatuslineResult
): string {
  const lines = [
    `teamem claude statusline ${result.command}`,
    result.dryRun
      ? 'dry-run: no statusline settings were changed'
      : result.ok
        ? 'OK'
        : 'ERROR',
    '',
    `Status: ${result.status}`,
    `Scope: ${result.scope.scope}`,
    `Scope source: ${result.scope.source}`,
    `Settings: ${result.settingsPath}`,
    `Command: ${result.statuslineCommand}`,
    `Effective: ${result.effectiveStatus === 'installed' ? 'yes' : 'no'}`,
    `Selected effective: ${result.selectedEffective ? 'yes' : 'no'}`
  ];
  if (result.effectiveScope) {
    lines.push(`Effective scope: ${result.effectiveScope}`);
  }
  if (result.plannedWrites.length > 0) {
    lines.push('', 'Writes:');
    for (const path of result.plannedWrites) {
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

function buildContext(environment: ClaudeStatuslineEnvironment): {
  readonly fileSystem: ClaudeLauncherFileSystem;
  readonly selectedScope: ScopeResolution;
  readonly selectedSettingsDir: string;
  readonly settingsPath: string;
  readonly settingsPaths: Record<PluginScope, string>;
} {
  const selectedScope = resolveStatuslineScope(environment);
  const settingsPaths: Record<PluginScope, string> = {
    user: join(
      environment.homeDir ?? homedir(),
      SETTINGS_DIRECTORY,
      SETTINGS_FILE
    ),
    project: join(environment.cwd, SETTINGS_DIRECTORY, SETTINGS_FILE),
    local: join(environment.cwd, SETTINGS_DIRECTORY, 'settings.local.json')
  };
  const settingsPath = settingsPaths[selectedScope.scope];
  return {
    fileSystem: environment.fileSystem ?? createNodeClaudeLauncherFileSystem(),
    selectedScope,
    selectedSettingsDir: settingsPath.slice(0, settingsPath.lastIndexOf('/')),
    settingsPath,
    settingsPaths
  };
}

function readSettings(context: {
  readonly fileSystem: ClaudeLauncherFileSystem;
  readonly settingsPath: string;
}):
  | { readonly ok: true; readonly value: ClaudeSettings }
  | {
      readonly ok: false;
      readonly message: string;
    } {
  if (!context.fileSystem.exists(context.settingsPath)) {
    return { ok: true, value: {} };
  }
  try {
    const parsed = JSON.parse(
      context.fileSystem.readFile(context.settingsPath)
    );
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        ok: false,
        message: 'Claude settings must be a JSON object.'
      };
    }
    return { ok: true, value: parsed as ClaudeSettings };
  } catch {
    return {
      ok: false,
      message: 'Claude settings are not valid JSON.'
    };
  }
}

function classifyStatusline(settings: ClaudeSettings): ClaudeStatuslineStatus {
  if (settings.statusLine === undefined) {
    return 'missing';
  }
  return isTeamemStatusline(settings.statusLine) ? 'installed' : 'foreign';
}

function resolveStatuslineScope(
  environment: ClaudeStatuslineEnvironment
): ScopeResolution {
  if (environment.scope) {
    return { scope: environment.scope, source: 'flag' };
  }

  const result = environment.commandRunner?.run('git', [
    'rev-parse',
    '--is-inside-work-tree'
  ]);
  return {
    scope:
      result?.exitCode === 0 && result.stdout.trim() === 'true'
        ? 'project'
        : 'user',
    source: 'default'
  };
}

function getEffectiveStatusline(
  context: {
    readonly fileSystem: ClaudeLauncherFileSystem;
    readonly settingsPaths: Record<PluginScope, string>;
  },
  override?: {
    readonly scope: PluginScope;
    readonly status: ClaudeStatuslineStatus;
  }
): {
  readonly scope?: PluginScope;
  readonly status: ClaudeStatuslineStatus;
} {
  for (const scope of ['local', 'project', 'user'] as const) {
    const status =
      override?.scope === scope
        ? override.status
        : readScopeStatus(context.fileSystem, context.settingsPaths[scope]);
    if (status !== 'missing') {
      return { scope, status };
    }
  }
  return { status: 'missing' };
}

function readScopeStatus(
  fileSystem: ClaudeLauncherFileSystem,
  settingsPath: string
): ClaudeStatuslineStatus {
  if (!fileSystem.exists(settingsPath)) {
    return 'missing';
  }
  try {
    const parsed = JSON.parse(fileSystem.readFile(settingsPath));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return 'foreign';
    }
    return classifyStatusline(parsed as ClaudeSettings);
  } catch {
    return 'foreign';
  }
}

function renderEffectiveDetails(
  context: { readonly selectedScope: ScopeResolution },
  selectedStatus: ClaudeStatuslineStatus,
  effective: {
    readonly scope?: PluginScope;
    readonly status: ClaudeStatuslineStatus;
  }
): string[] {
  const details = [
    effective.status === 'installed'
      ? `Effective Teamem statusline scope: ${effective.scope ?? 'none'}`
      : 'Teamem statusline is not effective after Claude settings precedence.'
  ];

  if (
    selectedStatus === 'installed' &&
    effective.scope &&
    effective.scope !== context.selectedScope.scope
  ) {
    details.push(
      `installed-but-overridden: ${effective.scope} scope overrides selected ${context.selectedScope.scope} scope.`
    );
  }

  if (effective.status === 'foreign' && effective.scope) {
    details.push(
      `Overriding scope: ${effective.scope} contains a non-Teamem statusline.`
    );
  }

  return details;
}

function isTeamemStatusline(value: unknown): value is StatusLineCommand {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (value as { type?: unknown }).type === 'command' &&
    (value as { command?: unknown }).command === TEAMEM_STATUSLINE_COMMAND
  );
}

function renderStatusLineSetting(): StatusLineCommand {
  return {
    type: 'command',
    command: TEAMEM_STATUSLINE_COMMAND
  };
}

function settingsFailure(
  command: Exclude<ClaudeStatuslineCommand, 'render'>,
  context: {
    readonly selectedScope: ScopeResolution;
    readonly settingsPath: string;
  },
  message: string,
  dryRun: boolean
): ClaudeStatuslineResult {
  return {
    ok: false,
    command,
    dryRun,
    status: 'foreign',
    scope: context.selectedScope,
    effectiveStatus: 'foreign',
    effectiveScope: context.selectedScope.scope,
    selectedEffective: true,
    settingsPath: context.settingsPath,
    statuslineCommand: TEAMEM_STATUSLINE_COMMAND,
    plannedWrites: [],
    message,
    details: [
      `Teamem left ${context.selectedScope.scope} Claude settings untouched.`
    ]
  };
}

function readStatuslineStdin(): string {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function readNestedString(
  value: Record<string, unknown>,
  path: readonly string[]
): string | undefined {
  let current: unknown = value;
  for (const key of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === 'string' && current.trim()
    ? current.trim()
    : undefined;
}

function readContextPercent(
  value: Record<string, unknown>
): number | undefined {
  const candidates = [
    readNestedNumber(value, ['context_window', 'used_percentage']),
    readNestedNumber(value, ['context_window', 'percent_available']),
    readNestedNumber(value, ['context_window', 'percentage']),
    readNestedNumber(value, ['context', 'percent_available']),
    readNestedNumber(value, ['context', 'percentage']),
    readNestedNumber(value, ['transcript', 'percent_available']),
    readCurrentUsageContextPercent(value)
  ];
  for (const candidate of candidates) {
    if (candidate === undefined || !Number.isFinite(candidate)) continue;
    const normalized = candidate <= 1 ? candidate * 100 : candidate;
    if (normalized >= 0 && normalized <= 100) {
      return Math.round(normalized);
    }
  }
  return undefined;
}

function readCurrentUsageContextPercent(
  value: Record<string, unknown>
): number | undefined {
  const contextWindowSize = readNestedNumber(value, [
    'context_window',
    'context_window_size'
  ]);
  if (!contextWindowSize || contextWindowSize <= 0) return undefined;
  const inputTokens = readNestedNumber(value, [
    'context_window',
    'current_usage',
    'input_tokens'
  ]);
  const cacheCreationInputTokens = readNestedNumber(value, [
    'context_window',
    'current_usage',
    'cache_creation_input_tokens'
  ]);
  const cacheReadInputTokens = readNestedNumber(value, [
    'context_window',
    'current_usage',
    'cache_read_input_tokens'
  ]);
  if (
    inputTokens === undefined &&
    cacheCreationInputTokens === undefined &&
    cacheReadInputTokens === undefined
  ) {
    return undefined;
  }
  return (
    (((inputTokens ?? 0) +
      (cacheCreationInputTokens ?? 0) +
      (cacheReadInputTokens ?? 0)) /
      contextWindowSize) *
    100
  );
}

function readNestedNumber(
  value: Record<string, unknown>,
  path: readonly string[]
): number | undefined {
  let current: unknown = value;
  for (const key of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  if (typeof current === 'number') {
    return current;
  }
  if (typeof current === 'string' && current.trim()) {
    const parsed = Number(current);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function sanitizeStatuslineSegment(value: string): string | undefined {
  const sanitized = value
    .replace(ANSI_ESCAPE_SEQUENCE_PATTERN, '')
    .replace(CONTROL_CHARACTER_PATTERN, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return sanitized || undefined;
}

function joinStatuslineSegments(parts: readonly string[]): string {
  return parts.join(` ${colorStatuslineSegment('|', ANSI_DIM_GRAY)} `);
}

function colorStatuslineSegment(value: string, color: string): string {
  return `${color}${value}${ANSI_RESET}`;
}

function getContextStatuslineColor(percent: number): string {
  if (percent >= 90) return ANSI_CONTEXT_RED;
  if (percent >= 70) return ANSI_CONTEXT_YELLOW;
  return ANSI_CONTEXT_GREEN;
}
