import { describe, expect, it } from 'bun:test';

import {
  buildDevLaunchPlan,
  renderDevLaunchBoundarySummary,
  renderDevLaunchDryRun
} from '../src/dev-launch.js';
import type { DevProfilePaths } from '../src/dev-profiles.js';
import type { DevSourceFileSystem, DevSourceResolution } from '../src/dev-source.js';

describe('buildDevLaunchPlan', () => {
  it('uses the real Claude binary, isolated profile env, local plugin, and strict MCP args', () => {
    const plan = buildDevLaunchPlan({
      source: source(),
      profile: profile(),
      claudeArgs: ['--model', 'opus'],
      env: {
        PATH: '/tmp/home/.teamem/bin:/opt/claude/bin',
        PARENT: 'kept',
        CLAUDE_PLUGIN_DATA: '/tmp/home/.claude/plugins/data/teamem',
        CLAUDE_PLUGIN_ROOT: '/tmp/home/.claude/plugins/cache/teamem-alpha',
        CLAUDE_SESSION_ID: 'stale-session',
        CLAUDE_PLUGIN_OPTION_DEFAULT_SPACE: 'stale-default',
        TEAMEM_SPACE: 'stale-space',
        TEAMEM_SPACE_ID: 'stale-space-id',
        TEAMEM_DEFAULT_SPACE: 'stale-teamem-default',
        TEAMEM_CLAUDE_LAUNCH_SPACE: 'stale-launch-space'
      },
      pathEnv: '/tmp/home/.teamem/bin:/opt/claude/bin',
      homeDir: '/tmp/home',
      fileSystem: executableFileSystem([
        '/tmp/home/.teamem/bin/claude',
        '/opt/claude/bin/claude'
      ])
    });

    expect(plan.command).toBe('/opt/claude/bin/claude');
    expect(plan.cwd).toBe('/work/project');
    expect(plan.args).toEqual([
      '--plugin-dir',
      '/src/teamem/plugin',
      '--mcp-config',
      '/tmp/home/.teamem/dev-profiles/alice/mcp.json',
      '--strict-mcp-config',
      '--dangerously-load-development-channels',
      'server:teamem-channel',
      '--name',
      'teamem-alice',
      '--model',
      'opus'
    ]);
    expect(plan.args).not.toContain('plugin:teamem@teamem-alpha');
    expect(plan.args).not.toContain('--setting-sources');
    expect(plan.args).not.toContain('--bare');
    expect(plan.env).toMatchObject({
      PATH: '/tmp/home/.teamem/bin:/opt/claude/bin',
      PARENT: 'kept',
      CLAUDE_CONFIG_DIR: '/tmp/home/.teamem/dev-profiles/alice/claude',
      CLAUDE_CODE_PLUGIN_CACHE_DIR:
        '/tmp/home/.teamem/dev-profiles/alice/claude/plugins',
      CLAUDE_CODE_MCP_ALLOWLIST_ENV: '1',
      CLAUDE_PLUGIN_DATA:
        '/tmp/home/.teamem/dev-profiles/alice/plugin-data/teamem',
      CLAUDE_PLUGIN_ROOT: '/src/teamem/plugin',
      TEAMEM_CREDENTIALS:
        '/tmp/home/.teamem/dev-profiles/alice/credentials.json',
      TEAMEM_CLAUDE_LAUNCH_INTENT: 'activate'
    });
    expect(plan.env.CLAUDE_SESSION_ID).toBeUndefined();
    expect(plan.env.CLAUDE_PLUGIN_OPTION_DEFAULT_SPACE).toBeUndefined();
    expect(plan.env.TEAMEM_SPACE).toBeUndefined();
    expect(plan.env.TEAMEM_SPACE_ID).toBeUndefined();
    expect(plan.env.TEAMEM_DEFAULT_SPACE).toBeUndefined();
    expect(plan.env.TEAMEM_CLAUDE_LAUNCH_SPACE).toBeUndefined();
    expect(JSON.stringify(plan.env)).not.toContain(
      '/tmp/home/.claude/plugins/data/teamem'
    );
    expect(JSON.stringify(plan.env)).not.toContain(
      '/tmp/home/.claude/plugins/cache/teamem-alpha'
    );
    expect(plan.envKeys).toEqual([
      'CLAUDE_CONFIG_DIR',
      'CLAUDE_CODE_PLUGIN_CACHE_DIR',
      'CLAUDE_CODE_MCP_ALLOWLIST_ENV',
      'CLAUDE_PLUGIN_DATA',
      'CLAUDE_PLUGIN_ROOT',
      'TEAMEM_CREDENTIALS',
      'TEAMEM_CLAUDE_LAUNCH_INTENT'
    ]);
  });

  it('preserves user-provided session names', () => {
    const plan = buildDevLaunchPlan({
      source: source(),
      profile: profile(),
      claudeArgs: ['-n=mine', '--continue'],
      pathEnv: '/opt/claude/bin',
      fileSystem: executableFileSystem(['/opt/claude/bin/claude'])
    });

    expect(plan.addedSessionName).toBe(false);
    expect(plan.args).toContain('-n=mine');
    expect(plan.args).not.toContain('teamem-alice');
  });

  it('renders the dry-run and normal boundary summaries without launching', () => {
    const plan = buildDevLaunchPlan({
      source: source(),
      profile: profile(),
      claudeArgs: [],
      pathEnv: '/opt/claude/bin',
      fileSystem: executableFileSystem(['/opt/claude/bin/claude'])
    });

    const dryRun = renderDevLaunchDryRun(plan);
    const summary = renderDevLaunchBoundarySummary(plan);

    expect(dryRun).toContain('Teamem dev Claude launch plan');
    expect(dryRun).toContain('dry-run: Claude Code will not be launched');
    expect(dryRun).toContain('Argv: /opt/claude/bin/claude');
    expect(dryRun).toContain('Source root: /src/teamem');
    expect(dryRun).toContain('Launch cwd: /work/project');
    expect(dryRun).toContain(
      'Plugin data: /tmp/home/.teamem/dev-profiles/alice/plugin-data/teamem'
    );
    expect(dryRun).toContain(
      'Logs: /tmp/home/.teamem/dev-profiles/alice/logs'
    );
    expect(dryRun).toContain('Channel source: server:teamem-channel');
    expect(dryRun).toContain(
      'Marketplace plugin ignored: teamem@teamem-alpha is not loaded for dev launch.'
    );
    expect(summary).toContain('Real Claude: /opt/claude/bin/claude');
    expect(summary).toContain(
      'Plugin data: /tmp/home/.teamem/dev-profiles/alice/plugin-data/teamem'
    );
    expect(summary).toContain(
      'Boundary: marketplace plugin identity teamem@teamem-alpha is ignored'
    );
  });
});

function source(): DevSourceResolution {
  return {
    teamemRoot: '/src/teamem',
    pluginRoot: '/src/teamem/plugin',
    launchCwd: '/work/project',
    source: 'flag'
  };
}

function profile(): DevProfilePaths {
  return {
    profileName: 'alice',
    profilesRoot: '/tmp/home/.teamem/dev-profiles',
    profileRoot: '/tmp/home/.teamem/dev-profiles/alice',
    claudeConfigDir: '/tmp/home/.teamem/dev-profiles/alice/claude',
    pluginCacheDir: '/tmp/home/.teamem/dev-profiles/alice/claude/plugins',
    pluginDataDir: '/tmp/home/.teamem/dev-profiles/alice/plugin-data/teamem',
    credentialsPath: '/tmp/home/.teamem/dev-profiles/alice/credentials.json',
    mcpConfigPath: '/tmp/home/.teamem/dev-profiles/alice/mcp.json',
    metadataPath: '/tmp/home/.teamem/dev-profiles/alice/metadata.json',
    logsDir: '/tmp/home/.teamem/dev-profiles/alice/logs'
  };
}

function executableFileSystem(
  executableFiles: readonly string[]
): DevSourceFileSystem {
  const executable = new Set(executableFiles);
  return {
    exists(path: string): boolean {
      return executable.has(path);
    },
    isDirectory(): boolean {
      return false;
    },
    isReadableFile(): boolean {
      return false;
    },
    isExecutableFile(path: string): boolean {
      return executable.has(path);
    },
    readFile(path: string): string {
      throw new Error(`Unexpected read: ${path}`);
    }
  };
}
