import { spawnSync } from 'node:child_process';

import type { DevProfilePaths } from './dev-profiles.js';
import type { DevSourceResolution, DevSourceFileSystem } from './dev-source.js';
import {
  resolveRealClaudeExecutable,
  type ClaudeLauncherFileSystem
} from './claude-launcher.js';

const DEV_CHANNEL_SOURCE = 'server:teamem-channel';
const LAUNCH_INTENT_ENV = 'TEAMEM_CLAUDE_LAUNCH_INTENT';
const ISOLATED_PROFILE_ENV_KEYS = new Set([
  'CLAUDE_PLUGIN_DATA',
  'CLAUDE_PLUGIN_ROOT',
  'CLAUDE_SESSION_ID',
  'CLAUDE_PLUGIN_OPTION_DEFAULT_SPACE',
  'TEAMEM_SPACE',
  'TEAMEM_SPACE_ID',
  'TEAMEM_DEFAULT_SPACE',
  'TEAMEM_CLAUDE_LAUNCH_SPACE'
]);

export interface DevClaudeProcessRunner {
  run(invocation: DevClaudeProcessInvocation): number | null;
}

export interface DevClaudeProcessInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
}

export interface DevLaunchPlan {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly envKeys: readonly string[];
  readonly cwd: string;
  readonly sourceRoot: string;
  readonly pluginRoot: string;
  readonly channelSource: string;
  readonly profile: DevProfilePaths;
  readonly userArgs: readonly string[];
  readonly addedSessionName: boolean;
  readonly marketplacePluginIgnored: true;
}

export function buildDevLaunchPlan(options: {
  readonly source: DevSourceResolution;
  readonly profile: DevProfilePaths;
  readonly claudeArgs: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly pathEnv?: string;
  readonly homeDir?: string;
  readonly fileSystem?: DevSourceFileSystem;
}): DevLaunchPlan {
  const command = resolveRealClaudeExecutable({
    fileSystem: options.fileSystem as ClaudeLauncherFileSystem | undefined,
    pathEnv: options.pathEnv,
    homeDir: options.homeDir
  });
  if (!command) {
    throw new Error(
      "Could not find the real Claude Code executable outside Teamem's shim directory."
    );
  }

  const userArgs = [...options.claudeArgs];
  const sessionArgs = hasUserProvidedSessionName(userArgs)
    ? userArgs
    : ['--name', `teamem-${options.profile.profileName}`, ...userArgs];
  const args = [
    '--plugin-dir',
    options.source.pluginRoot,
    '--mcp-config',
    options.profile.mcpConfigPath,
    '--strict-mcp-config',
    '--dangerously-load-development-channels',
    DEV_CHANNEL_SOURCE,
    ...sessionArgs
  ];
  const env: NodeJS.ProcessEnv = {
    ...scrubInheritedProfileEnv(options.env ?? process.env),
    CLAUDE_CONFIG_DIR: options.profile.claudeConfigDir,
    CLAUDE_CODE_PLUGIN_CACHE_DIR: options.profile.pluginCacheDir,
    CLAUDE_CODE_MCP_ALLOWLIST_ENV: '1',
    CLAUDE_PLUGIN_DATA: options.profile.pluginDataDir,
    CLAUDE_PLUGIN_ROOT: options.source.pluginRoot,
    TEAMEM_CREDENTIALS: options.profile.credentialsPath,
    [LAUNCH_INTENT_ENV]: 'activate'
  };
  const envKeys = [
    'CLAUDE_CONFIG_DIR',
    'CLAUDE_CODE_PLUGIN_CACHE_DIR',
    'CLAUDE_CODE_MCP_ALLOWLIST_ENV',
    'CLAUDE_PLUGIN_DATA',
    'CLAUDE_PLUGIN_ROOT',
    'TEAMEM_CREDENTIALS',
    LAUNCH_INTENT_ENV
  ];

  return {
    command,
    args,
    env,
    envKeys,
    cwd: options.source.launchCwd,
    sourceRoot: options.source.teamemRoot,
    pluginRoot: options.source.pluginRoot,
    channelSource: DEV_CHANNEL_SOURCE,
    profile: options.profile,
    userArgs,
    addedSessionName: !hasUserProvidedSessionName(userArgs),
    marketplacePluginIgnored: true
  };
}

export function renderDevLaunchDryRun(plan: DevLaunchPlan): string {
  return `${renderDevLaunchPlan(plan, 'dry-run: Claude Code will not be launched')}\n`;
}

export function renderDevLaunchBoundarySummary(plan: DevLaunchPlan): string {
  return [
    'Teamem dev Claude launch',
    `Real Claude: ${plan.command}`,
    `Profile: ${plan.profile.profileName}`,
    `Launch cwd: ${plan.cwd}`,
    `Source root: ${plan.sourceRoot}`,
    `Plugin source: ${plan.pluginRoot}`,
    `Plugin data: ${plan.profile.pluginDataDir}`,
    `Logs: ${plan.profile.logsDir}`,
    `Channel source: ${plan.channelSource}`,
    'Boundary: marketplace plugin identity teamem@teamem-alpha is ignored for this source-checkout launch.'
  ].join('\n') + '\n';
}

export function createNodeDevClaudeProcessRunner(): DevClaudeProcessRunner {
  return {
    run(invocation: DevClaudeProcessInvocation): number | null {
      const result = spawnSync(invocation.command, [...invocation.args], {
        cwd: invocation.cwd,
        env: invocation.env,
        stdio: 'inherit'
      });
      return result.status;
    }
  };
}

function renderDevLaunchPlan(plan: DevLaunchPlan, header: string): string {
  return [
    'Teamem dev Claude launch plan',
    header,
    `Command: ${plan.command}`,
    `Argv: ${[plan.command, ...plan.args].join(' ')}`,
    `Launch cwd: ${plan.cwd}`,
    `Source root: ${plan.sourceRoot}`,
    `Plugin source: ${plan.pluginRoot}`,
    `Channel source: ${plan.channelSource}`,
    `Marketplace plugin ignored: teamem@teamem-alpha is not loaded for dev launch.`,
    `Profile: ${plan.profile.profileName}`,
    `Profile root: ${plan.profile.profileRoot}`,
    `Claude config: ${plan.profile.claudeConfigDir}`,
    `Plugin cache: ${plan.profile.pluginCacheDir}`,
    `Plugin data: ${plan.profile.pluginDataDir}`,
    `Logs: ${plan.profile.logsDir}`,
    `Credentials: ${plan.profile.credentialsPath}`,
    `MCP config: ${plan.profile.mcpConfigPath}`,
    `Env keys: ${plan.envKeys.join(', ')}`,
    plan.addedSessionName
      ? `Session name: teamem-${plan.profile.profileName}`
      : 'Session name: preserved from user args'
  ].join('\n');
}

function scrubInheritedProfileEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const scrubbed: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (!ISOLATED_PROFILE_ENV_KEYS.has(key)) {
      scrubbed[key] = value;
    }
  }
  return scrubbed;
}

function hasUserProvidedSessionName(args: readonly string[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--name' || arg === '-n') {
      return typeof args[index + 1] === 'string' && args[index + 1] !== '';
    }
    if (arg.startsWith('--name=') || arg.startsWith('-n=')) {
      return arg.includes('=') && arg.slice(arg.indexOf('=') + 1) !== '';
    }
  }
  return false;
}
