import { join, resolve } from 'node:path';

import type { DevProfilePaths } from './dev-profiles.js';
import type { DevSourceResolution } from './dev-source.js';

const PLUGIN_ROOT_PLACEHOLDER = '${CLAUDE_PLUGIN_ROOT}';
const REQUIRED_SERVERS = ['teamem', 'teamem-channel'] as const;
const MARKETPLACE_CACHE_PATTERNS = [
  '/cache/teamem',
  '/plugins/cache',
  '.claude/plugins/cache'
] as const;
const PLUGIN_ROOT_ESCAPE_ERROR =
  'Plugin MCP declaration contains a CLAUDE_PLUGIN_ROOT path outside the selected plugin checkout.';
const MCP_PROFILE_ENV_KEYS = new Set([
  'CLAUDE_PLUGIN_DATA',
  'CLAUDE_PLUGIN_ROOT',
  'CLAUDE_SESSION_ID',
  'CLAUDE_PLUGIN_OPTION_DEFAULT_SPACE',
  'TEAMEM_SPACE',
  'TEAMEM_SPACE_ID',
  'TEAMEM_DEFAULT_SPACE',
  'TEAMEM_CLAUDE_LAUNCH_SPACE'
]);

export interface DevMcpConfigFileSystem {
  isReadableFile(path: string): boolean;
  readFile(path: string): string;
}

export interface DevMcpConfigGeneration {
  readonly ok: true;
  readonly declarationPath: string;
  readonly json: string;
  readonly config: StrictMcpConfig;
}

export interface DevMcpConfigFailure {
  readonly ok: false;
  readonly declarationPath: string;
  readonly error: string;
}

export type DevMcpConfigGenerationResult =
  | DevMcpConfigGeneration
  | DevMcpConfigFailure;

export interface StrictMcpConfig {
  readonly mcpServers: Record<string, StrictMcpServer>;
}

export interface StrictMcpServer {
  readonly command?: unknown;
  readonly args?: unknown;
  readonly env: Record<string, string>;
  readonly [key: string]: unknown;
}

type ReplacementResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

type ValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

export function generateDevMcpConfig(options: {
  readonly source: DevSourceResolution;
  readonly profile: DevProfilePaths;
  readonly fileSystem: DevMcpConfigFileSystem;
}): DevMcpConfigGenerationResult {
  const declarationPath = join(options.source.pluginRoot, '.mcp.json');
  const parsed = readPluginMcpDeclaration(options.fileSystem, declarationPath);
  if (!parsed.ok) {
    return { ok: false, declarationPath, error: parsed.error };
  }

  const mcpServers = isRecord(parsed.value)
    ? parsed.value.mcpServers
    : undefined;
  if (!isRecord(mcpServers)) {
    return {
      ok: false,
      declarationPath,
      error: 'Plugin MCP declaration must contain an object mcpServers map.'
    };
  }

  for (const serverName of REQUIRED_SERVERS) {
    if (!isRecord(mcpServers[serverName])) {
      return {
        ok: false,
        declarationPath,
        error: `Plugin MCP declaration is missing required server: ${serverName}`
      };
    }
  }

  const placeholderReplacement = replacePluginRootPlaceholders(
    parsed.value,
    resolve(options.source.pluginRoot)
  );
  if (!placeholderReplacement.ok) {
    return {
      ok: false,
      declarationPath,
      error: placeholderReplacement.error
    };
  }

  const resolvedConfig = placeholderReplacement.value;
  if (!isRecord(resolvedConfig) || !isRecord(resolvedConfig.mcpServers)) {
    return {
      ok: false,
      declarationPath,
      error: 'Plugin MCP declaration resolved to an invalid mcpServers map.'
    };
  }

  for (const serverName of REQUIRED_SERVERS) {
    const validation = validateRequiredServer(
      serverName,
      resolvedConfig.mcpServers[serverName]
    );
    if (!validation.ok) {
      return { ok: false, declarationPath, error: validation.error };
    }
  }

  const strictServers: Record<string, StrictMcpServer> = {};
  for (const [serverName, serverValue] of Object.entries(
    resolvedConfig.mcpServers
  )) {
    if (!isRecord(serverValue)) {
      return {
        ok: false,
        declarationPath,
        error: `Plugin MCP server declaration must be an object: ${serverName}`
      };
    }
    const env = serverValue.env;
    if (env !== undefined && !isStringRecord(env)) {
      return {
        ok: false,
        declarationPath,
        error: `Plugin MCP server env must be a string map: ${serverName}`
      };
    }
    strictServers[serverName] = {
      ...serverValue,
      env: {
        ...scrubMcpServerProfileEnv(env ?? {}),
        CLAUDE_PLUGIN_DATA: options.profile.pluginDataDir,
        CLAUDE_PLUGIN_ROOT: options.source.pluginRoot,
        TEAMEM_CREDENTIALS: options.profile.credentialsPath
      }
    };
  }

  const config: StrictMcpConfig = { mcpServers: strictServers };
  const json = `${JSON.stringify(config, null, 2)}\n`;
  if (containsMarketplaceCachePath(json)) {
    return {
      ok: false,
      declarationPath,
      error:
        'Generated MCP config contains a marketplace cache path; use the selected local plugin declaration instead.'
    };
  }

  return {
    ok: true,
    declarationPath,
    json,
    config
  };
}

function scrubMcpServerProfileEnv(
  env: Record<string, string>
): Record<string, string> {
  const scrubbed: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!MCP_PROFILE_ENV_KEYS.has(key)) {
      scrubbed[key] = value;
    }
  }
  return scrubbed;
}

function readPluginMcpDeclaration(
  fileSystem: DevMcpConfigFileSystem,
  declarationPath: string
):
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: string } {
  if (!fileSystem.isReadableFile(declarationPath)) {
    return {
      ok: false,
      error: `Plugin MCP declaration is missing or unreadable: ${declarationPath}`
    };
  }
  try {
    return {
      ok: true,
      value: JSON.parse(fileSystem.readFile(declarationPath))
    };
  } catch {
    return {
      ok: false,
      error: `Plugin MCP declaration is malformed JSON: ${declarationPath}`
    };
  }
}

function replacePluginRootPlaceholders(
  value: unknown,
  pluginRoot: string
): ReplacementResult<unknown> {
  if (typeof value === 'string') {
    return replacePluginRootPlaceholderInString(value, pluginRoot);
  }
  if (Array.isArray(value)) {
    const replaced = [];
    for (const entry of value) {
      const result = replacePluginRootPlaceholders(entry, pluginRoot);
      if (!result.ok) {
        return result;
      }
      replaced.push(result.value);
    }
    return { ok: true, value: replaced };
  }
  if (isRecord(value)) {
    const replaced: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const result = replacePluginRootPlaceholders(entry, pluginRoot);
      if (!result.ok) {
        return result;
      }
      replaced[key] = result.value;
    }
    return { ok: true, value: replaced };
  }
  return { ok: true, value };
}

function replacePluginRootPlaceholderInString(
  value: string,
  pluginRoot: string
): ReplacementResult<string> {
  if (!value.includes(PLUGIN_ROOT_PLACEHOLDER)) {
    return { ok: true, value };
  }

  let resolvedValue = '';
  let cursor = 0;
  while (cursor < value.length) {
    const placeholderIndex = value.indexOf(PLUGIN_ROOT_PLACEHOLDER, cursor);
    if (placeholderIndex === -1) {
      resolvedValue += value.slice(cursor);
      break;
    }

    resolvedValue += value.slice(cursor, placeholderIndex);
    const suffixStart = placeholderIndex + PLUGIN_ROOT_PLACEHOLDER.length;
    const pathEnd = findEmbeddedPathEnd(value, suffixStart);
    const resolvedPath = resolve(
      `${pluginRoot}${value.slice(suffixStart, pathEnd)}`
    );
    if (!isPathWithin(pluginRoot, resolvedPath)) {
      return { ok: false, error: PLUGIN_ROOT_ESCAPE_ERROR };
    }
    resolvedValue += resolvedPath;
    cursor = pathEnd;
  }

  return { ok: true, value: resolvedValue };
}

function validateRequiredServer(
  serverName: (typeof REQUIRED_SERVERS)[number],
  serverValue: unknown
): ValidationResult {
  if (!isRecord(serverValue)) {
    return {
      ok: false,
      error: `Plugin MCP declaration is missing required server: ${serverName}`
    };
  }
  if (typeof serverValue.command !== 'string') {
    return {
      ok: false,
      error: `Plugin MCP required server command must be a string: ${serverName}`
    };
  }
  if (
    serverValue.args !== undefined &&
    (!Array.isArray(serverValue.args) ||
      serverValue.args.some((arg) => typeof arg !== 'string'))
  ) {
    return {
      ok: false,
      error: `Plugin MCP required server args must be a string array: ${serverName}`
    };
  }
  return { ok: true };
}

function isPathWithin(root: string, path: string): boolean {
  const resolvedRoot = resolve(root);
  return path === resolvedRoot || path.startsWith(`${resolvedRoot}/`);
}

function findEmbeddedPathEnd(value: string, start: number): number {
  for (let index = start; index < value.length; index += 1) {
    if (isEmbeddedPathTerminator(value[index])) {
      return index;
    }
  }
  return value.length;
}

function isEmbeddedPathTerminator(value: string): boolean {
  return [' ', '\t', '\n', '\r', '"', "'", '`', ',', ';', ':'].includes(value);
}

function containsMarketplaceCachePath(json: string): boolean {
  return MARKETPLACE_CACHE_PATTERNS.some((pattern) => json.includes(pattern));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.values(value).every((entry) => typeof entry === 'string')
  );
}
