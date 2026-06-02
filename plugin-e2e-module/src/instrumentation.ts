import { cp, chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PluginInstrumentationError } from './errors.js';
import { validatePluginSource } from './plugin-validation.js';
import type {
  HookShellCommand,
  InstrumentedPlugin,
  McpInstrumentationOptions,
  RedactionMode,
  RunArtifacts,
  ValidatedPluginSource
} from './types.js';

const moduleDir = dirname(fileURLToPath(import.meta.url));
const hookProxyRunnerPath = join(moduleDir, 'hook-proxy-runner.cjs');
const mcpProxyRunnerPath = join(moduleDir, 'mcp-proxy-runner.cjs');
const DEFAULT_MCP_SERVER_ENV_KEYS = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'CLAUDE_PLUGIN_ROOT',
  'CLAUDE_PLUGIN_DATA',
  'CLAUDE_PROJECT_DIR',
  'CLAUDE_SESSION_ID'
] as const;

export async function instrumentPlugin(input: {
  sourcePlugin: ValidatedPluginSource;
  artifactsRoot: string;
  hookShell: HookShellCommand;
  mcp?: McpInstrumentationOptions;
}): Promise<InstrumentedPlugin> {
  const workspaceDir = join(
    input.artifactsRoot,
    'instrumented-plugin-workspace'
  );
  await mkdir(workspaceDir, { recursive: true });
  const pluginDir = join(workspaceDir, `plugin-${randomUUID()}`);
  const hookTraceDir = join(input.artifactsRoot, 'hook-traces');
  const mcpTraceDir = join(input.artifactsRoot, 'mcp-traces');

  try {
    await cp(input.sourcePlugin.pluginDir, pluginDir, {
      recursive: true,
      preserveTimestamps: true,
      errorOnExist: true
    });
    await preserveModes(input.sourcePlugin.pluginDir, pluginDir);

    const copiedPlugin = await validatePluginSource(pluginDir);
    if (copiedPlugin.hooksPath) {
      await rewriteHooks(copiedPlugin.hooksPath, input.hookShell);
    }
    if (copiedPlugin.mcpPath) {
      await rewriteMcp(copiedPlugin.mcpPath, input.mcp ?? {});
    }
    await validatePluginSource(pluginDir);

    return {
      sourcePluginDir: input.sourcePlugin.pluginDir,
      pluginDir,
      workspaceDir,
      hookTraceDir,
      mcpTraceDir,
      hooksPath: copiedPlugin.hooksPath,
      mcpPath: copiedPlugin.mcpPath
    };
  } catch (error) {
    if (error instanceof PluginInstrumentationError) {
      throw error;
    }
    throw new PluginInstrumentationError(
      `Unable to instrument plugin copy at ${pluginDir}: ${formatUnknownError(
        error
      )}`
    );
  }
}

export async function materializeRunMcpConfig(input: {
  instrumentedPlugin: InstrumentedPlugin;
  artifacts: Pick<RunArtifacts, 'dir' | 'mcpTraceDir'>;
  env: NodeJS.ProcessEnv;
  redactionMode: RedactionMode;
  envPassthroughKeys?: readonly string[];
}): Promise<InstrumentedPlugin> {
  const sourceMcpPath = input.instrumentedPlugin.mcpPath;
  if (!sourceMcpPath) {
    return input.instrumentedPlugin;
  }

  const raw = await readFile(sourceMcpPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new PluginInstrumentationError(
      `Unable to parse instrumented MCP config at ${sourceMcpPath}: ${formatUnknownError(
        error
      )}`
    );
  }

  if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) {
    throw new PluginInstrumentationError(
      `Instrumented MCP config must include an mcpServers object: ${sourceMcpPath}`
    );
  }

  const runEnv = buildRunMcpServerEnv(input);
  for (const [serverName, serverConfig] of Object.entries(parsed.mcpServers)) {
    if (!isRecord(serverConfig)) {
      throw new PluginInstrumentationError(
        `MCP server ${serverName} must be an object in ${sourceMcpPath}`
      );
    }
    const existingEnv = serverConfig.env;
    if (existingEnv !== undefined && !isStringRecord(existingEnv)) {
      throw new PluginInstrumentationError(
        `MCP server ${serverName} env must be a string map in ${sourceMcpPath}`
      );
    }
    serverConfig.env = {
      ...(existingEnv ?? {}),
      ...runEnv
    };
  }

  const runMcpPath = join(input.artifacts.dir, 'mcp-config.json');
  await writeFile(runMcpPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  return {
    ...input.instrumentedPlugin,
    mcpPath: runMcpPath
  };
}

async function rewriteMcp(
  mcpPath: string,
  options: McpInstrumentationOptions
): Promise<void> {
  const raw = await readFile(mcpPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new PluginInstrumentationError(
      `Unable to parse MCP config at ${mcpPath}: ${formatUnknownError(error)}`
    );
  }

  if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) {
    throw new PluginInstrumentationError(
      `MCP config must include an mcpServers object: ${mcpPath}`
    );
  }

  for (const [serverName, serverConfig] of Object.entries(parsed.mcpServers)) {
    if (!shouldProxyMcpServer(serverName, options)) {
      if (options.mode === 'disable-non-included') {
        delete parsed.mcpServers[serverName];
      }
      continue;
    }
    if (!isRecord(serverConfig)) {
      throw new PluginInstrumentationError(
        `MCP server ${serverName} must be an object in ${mcpPath}`
      );
    }
    if (typeof serverConfig.command !== 'string') {
      throw new PluginInstrumentationError(
        `MCP server ${serverName} must include a string command in ${mcpPath}`
      );
    }

    const originalCommand = serverConfig.command;
    const originalArgs = readMcpArgs(serverName, serverConfig.args, mcpPath);
    serverConfig.command = process.execPath;
    serverConfig.args = createMcpProxyArgs({
      serverName,
      originalCommand,
      originalArgs
    });
  }

  await writeFile(mcpPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
}

function createMcpProxyArgs(input: {
  serverName: string;
  originalCommand: string;
  originalArgs: string[];
}): string[] {
  return [
    mcpProxyRunnerPath,
    '--server-name',
    input.serverName,
    '--command-base64',
    Buffer.from(input.originalCommand, 'utf8').toString('base64'),
    ...input.originalArgs.flatMap((arg) => [
      '--arg-base64',
      Buffer.from(arg, 'utf8').toString('base64')
    ])
  ];
}

function readMcpArgs(
  serverName: string,
  value: unknown,
  mcpPath: string
): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || !value.every((arg) => typeof arg === 'string')) {
    throw new PluginInstrumentationError(
      `MCP server ${serverName} args must be an array of strings in ${mcpPath}`
    );
  }
  return [...value];
}

function buildRunMcpServerEnv(input: {
  artifacts: Pick<RunArtifacts, 'mcpTraceDir'>;
  env: NodeJS.ProcessEnv;
  redactionMode: RedactionMode;
  envPassthroughKeys?: readonly string[];
}): Record<string, string> {
  return {
    ...pickStringEnv(input.env, [
      ...DEFAULT_MCP_SERVER_ENV_KEYS,
      ...(input.envPassthroughKeys ?? [])
    ]),
    CLAUDE_PLUGIN_E2E_MCP_TRACE_DIR: input.artifacts.mcpTraceDir,
    CLAUDE_PLUGIN_E2E_REDACTION_MODE: input.redactionMode,
    ...(input.redactionMode === 'off' &&
    process.env.CLAUDE_PLUGIN_E2E_ALLOW_UNREDACTED === '1'
      ? { CLAUDE_PLUGIN_E2E_ALLOW_UNREDACTED: '1' }
      : {})
  };
}

function pickStringEnv(
  env: NodeJS.ProcessEnv,
  keys: readonly string[]
): Record<string, string> {
  return Object.fromEntries(
    keys.flatMap((key) => {
      const value = env[key];
      return typeof value === 'string' && value.length > 0
        ? [[key, value]]
        : [];
    })
  );
}

function shouldProxyMcpServer(
  serverName: string,
  options: McpInstrumentationOptions
): boolean {
  const include = options.include ?? [];
  const exclude = options.exclude ?? [];
  const included = include.length === 0 || include.includes(serverName);
  return included && !exclude.includes(serverName);
}

async function preserveModes(
  sourceDir: string,
  targetDir: string
): Promise<void> {
  const glob = new Bun.Glob('**/*');
  for await (const entry of glob.scan({
    cwd: sourceDir,
    dot: true,
    onlyFiles: false
  })) {
    const sourcePath = join(sourceDir, entry);
    const targetPath = join(targetDir, entry);
    const sourceStats = await stat(sourcePath);
    await chmod(targetPath, sourceStats.mode);
  }
}

async function rewriteHooks(
  hooksPath: string,
  hookShell: HookShellCommand
): Promise<void> {
  const raw = await readFile(hooksPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new PluginInstrumentationError(
      `Unable to parse hook config at ${hooksPath}: ${formatUnknownError(error)}`
    );
  }

  if (!isRecord(parsed) || !isRecord(parsed.hooks)) {
    throw new PluginInstrumentationError(
      `Hook config must include a hooks object: ${hooksPath}`
    );
  }

  for (const [event, hookGroups] of Object.entries(parsed.hooks)) {
    if (!Array.isArray(hookGroups)) {
      throw new PluginInstrumentationError(
        `Hook event ${event} must be an array in ${hooksPath}`
      );
    }

    for (const group of hookGroups) {
      if (!isRecord(group) || !Array.isArray(group.hooks)) {
        throw new PluginInstrumentationError(
          `Hook event ${event} group must include a hooks array in ${hooksPath}`
        );
      }

      group.hooks = group.hooks.map((hook) =>
        rewriteHook(event, hook, hookShell)
      );
    }
  }

  await writeFile(hooksPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
}

function rewriteHook(
  event: string,
  hook: unknown,
  hookShell: HookShellCommand
): unknown {
  if (!isRecord(hook)) {
    return hook;
  }
  if (hook.type !== 'command' || typeof hook.command !== 'string') {
    return hook;
  }

  return {
    ...hook,
    command: createHookProxyCommand({
      event,
      originalCommand: hook.command,
      hookShell
    })
  };
}

function createHookProxyCommand(input: {
  event: string;
  originalCommand: string;
  hookShell: HookShellCommand;
}): string {
  const encodedCommand = Buffer.from(input.originalCommand, 'utf8').toString(
    'base64'
  );
  return [
    'node',
    shellQuote(hookProxyRunnerPath),
    '--event',
    shellQuote(input.event),
    '--shell-command',
    shellQuote(input.hookShell.command),
    ...(input.hookShell.args ?? []).flatMap((arg) => [
      '--shell-arg',
      shellQuote(arg)
    ]),
    '--command-base64',
    shellQuote(encodedCommand)
  ].join(' ');
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.values(value).every((field) => typeof field === 'string')
  );
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
