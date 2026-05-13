import type { PluginScope } from './plugin-installer.js';

export interface ClaudePluginListEntry {
  readonly id?: string;
  readonly name?: string;
  readonly plugin?: string;
  readonly scope?: PluginScope;
  readonly installPath?: string;
}

export interface InstalledTeamemPlugin {
  readonly id?: string;
  readonly name?: string;
  readonly plugin?: string;
  readonly scope: PluginScope;
  readonly installPath: string;
}

const PLUGIN_SCOPE_PRECEDENCE: readonly PluginScope[] = [
  'project',
  'user',
  'local'
];

export function parseClaudePluginListJson(
  stdout: string
): ClaudePluginListEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }

  const entries = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.plugins)
      ? parsed.plugins
      : [];

  return entries.flatMap((entry): ClaudePluginListEntry[] => {
    if (!isRecord(entry)) {
      return [];
    }

    return [
      {
        id: typeof entry.id === 'string' ? entry.id : undefined,
        name: typeof entry.name === 'string' ? entry.name : undefined,
        plugin: typeof entry.plugin === 'string' ? entry.plugin : undefined,
        scope: isPluginScope(entry.scope) ? entry.scope : undefined,
        installPath:
          typeof entry.installPath === 'string' ? entry.installPath : undefined
      }
    ];
  });
}

export function detectInstalledTeamemScopeFromJson(
  stdout: string,
  pluginId: string
): PluginScope | undefined {
  const matchingScopes = new Set(
    parseClaudePluginListJson(stdout)
      .filter((entry) => isExactPluginEntry(entry, pluginId))
      .flatMap((entry) => (entry.scope ? [entry.scope] : []))
  );

  return PLUGIN_SCOPE_PRECEDENCE.find((scope) => matchingScopes.has(scope));
}

export function findInstalledTeamemPlugin(
  stdout: string,
  pluginId: string,
  scope: PluginScope
): InstalledTeamemPlugin | undefined {
  return parseClaudePluginListJson(stdout).find(
    isInstalledTeamemPlugin(pluginId, scope)
  );
}

function isTeamemPluginEntry(
  entry: ClaudePluginListEntry,
  pluginId: string
): boolean {
  return isExactPluginEntry(entry, pluginId);
}

function isExactPluginEntry(
  entry: ClaudePluginListEntry,
  pluginId: string
): boolean {
  return [entry.id, entry.name, entry.plugin].some(
    (value) => value === pluginId
  );
}

function isInstalledTeamemPlugin(
  pluginId: string,
  scope: PluginScope
): (entry: ClaudePluginListEntry) => entry is InstalledTeamemPlugin {
  return (entry): entry is InstalledTeamemPlugin =>
    isTeamemPluginEntry(entry, pluginId) &&
    entry.scope === scope &&
    typeof entry.installPath === 'string';
}

function isPluginScope(value: unknown): value is PluginScope {
  return value === 'project' || value === 'user' || value === 'local';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
