import { describe, expect, it } from 'bun:test';

import { resolveDevProfilePaths } from '../src/dev-profiles.js';
import {
  generateDevMcpConfig,
  type DevMcpConfigFileSystem
} from '../src/dev-mcp-config.js';
import type { DevSourceResolution } from '../src/dev-source.js';

describe('dev MCP config generation', () => {
  it('derives server command and args from the local plugin MCP declaration', () => {
    const result = generate({
      declaration: {
        mcpServers: {
          teamem: {
            command: 'custom-bun',
            args: ['run', '${CLAUDE_PLUGIN_ROOT}/lib/custom-bridge.js']
          },
          'teamem-channel': {
            command: 'custom-bun',
            args: ['run', '${CLAUDE_PLUGIN_ROOT}/lib/custom-channel.js']
          }
        }
      }
    });

    expect(result.ok).toBe(true);
    expect(
      result.ok ? result.config.mcpServers.teamem.command : undefined
    ).toBe('custom-bun');
    expect(
      result.ok ? result.config.mcpServers.teamem.args : undefined
    ).toEqual(['run', '/src/teamem/plugin/lib/custom-bridge.js']);
    expect(
      result.ok ? result.config.mcpServers['teamem-channel'].args : undefined
    ).toEqual(['run', '/src/teamem/plugin/lib/custom-channel.js']);
  });

  it('resolves plugin-root placeholders structurally in args and env strings', () => {
    const result = generate({
      declaration: {
        mcpServers: {
          teamem: {
            command: 'bun',
            args: ['run', '${CLAUDE_PLUGIN_ROOT}/lib/bridge.js'],
            env: {
              TEAMEM_BRIDGE_LOG: '${CLAUDE_PLUGIN_ROOT}/logs/bridge.log'
            }
          },
          'teamem-channel': {
            command: 'bun',
            args: ['run', '${CLAUDE_PLUGIN_ROOT}/lib/channel.js'],
            env: {
              TEAMEM_CHANNEL_LOG: '${CLAUDE_PLUGIN_ROOT}/logs/channel.log'
            }
          }
        }
      }
    });

    expect(result.ok).toBe(true);
    const json = result.ok ? result.json : '';
    expect(json).toContain('/src/teamem/plugin/lib/bridge.js');
    expect(json).toContain('/src/teamem/plugin/logs/channel.log');
    expect(json).not.toContain('${CLAUDE_PLUGIN_ROOT}');
  });

  it('pins strict MCP server env to profile-owned plugin data and local plugin root', () => {
    const result = generate({
      declaration: {
        mcpServers: {
          teamem: {
            command: 'bun',
            args: ['run', '${CLAUDE_PLUGIN_ROOT}/lib/bridge.js'],
            env: {
              CLAUDE_PLUGIN_DATA: '/tmp/home/.claude/plugins/data/teamem',
              CLAUDE_PLUGIN_ROOT:
                '/tmp/home/.claude/plugins/cache/teamem-alpha',
              CLAUDE_SESSION_ID: 'stale-session',
              CLAUDE_PLUGIN_OPTION_DEFAULT_SPACE: 'stale-default',
              TEAMEM_SPACE: 'stale-space',
              TEAMEM_SPACE_ID: 'stale-space-id',
              TEAMEM_DEFAULT_SPACE: 'stale-teamem-default',
              TEAMEM_CLAUDE_LAUNCH_SPACE: 'stale-launch-space',
              PRESERVED: 'kept'
            }
          },
          'teamem-channel': {
            command: 'bun',
            args: ['run', '${CLAUDE_PLUGIN_ROOT}/lib/channel.js'],
            env: {
              CLAUDE_PLUGIN_DATA: '/tmp/home/.claude/plugins/data/teamem',
              CLAUDE_PLUGIN_ROOT: '/stale/plugin/root',
              TEAMEM_SPACE: 'stale-space'
            }
          }
        }
      }
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    for (const server of Object.values(result.config.mcpServers)) {
      expect(server.env).toMatchObject({
        CLAUDE_PLUGIN_DATA:
          '/tmp/home/.teamem/dev-profiles/alice/plugin-data/teamem',
        CLAUDE_PLUGIN_ROOT: '/src/teamem/plugin',
        TEAMEM_CREDENTIALS:
          '/tmp/home/.teamem/dev-profiles/alice/credentials.json'
      });
      expect(server.env.CLAUDE_SESSION_ID).toBeUndefined();
      expect(server.env.CLAUDE_PLUGIN_OPTION_DEFAULT_SPACE).toBeUndefined();
      expect(server.env.TEAMEM_SPACE).toBeUndefined();
      expect(server.env.TEAMEM_SPACE_ID).toBeUndefined();
      expect(server.env.TEAMEM_DEFAULT_SPACE).toBeUndefined();
      expect(server.env.TEAMEM_CLAUDE_LAUNCH_SPACE).toBeUndefined();
    }
    expect(result.config.mcpServers.teamem.env.PRESERVED).toBe('kept');
    expect(result.json).not.toContain('/tmp/home/.claude/plugins/data/teamem');
    expect(result.json).not.toContain('/tmp/home/.claude/plugins/cache');
    expect(result.json).not.toContain('/stale/plugin/root');
    expect(result.json).not.toContain('stale-session');
    expect(result.json).not.toContain('stale-space');
  });

  it('requires both Teamem bridge and channel server declarations', () => {
    const missingBridge = generate({
      declaration: {
        mcpServers: {
          'teamem-channel': { command: 'bun' }
        }
      }
    });
    const missingChannel = generate({
      declaration: {
        mcpServers: {
          teamem: { command: 'bun' }
        }
      }
    });

    expect(missingBridge).toMatchObject({
      ok: false,
      error: 'Plugin MCP declaration is missing required server: teamem'
    });
    expect(missingChannel).toMatchObject({
      ok: false,
      error: 'Plugin MCP declaration is missing required server: teamem-channel'
    });
  });

  it('rejects required server declarations without string commands', () => {
    const missingCommand = generate({
      declaration: {
        mcpServers: {
          teamem: {
            args: ['run', '${CLAUDE_PLUGIN_ROOT}/lib/bridge.js']
          },
          'teamem-channel': {
            command: 'bun',
            args: ['run', '${CLAUDE_PLUGIN_ROOT}/lib/channel.js']
          }
        }
      }
    });
    const nonStringCommand = generate({
      declaration: {
        mcpServers: {
          teamem: {
            command: 123,
            args: ['run', '${CLAUDE_PLUGIN_ROOT}/lib/bridge.js']
          },
          'teamem-channel': {
            command: 'bun',
            args: ['run', '${CLAUDE_PLUGIN_ROOT}/lib/channel.js']
          }
        }
      }
    });

    expect(missingCommand).toMatchObject({
      ok: false,
      error: 'Plugin MCP required server command must be a string: teamem'
    });
    expect(nonStringCommand).toMatchObject({
      ok: false,
      error: 'Plugin MCP required server command must be a string: teamem'
    });
  });

  it('rejects required server declarations with invalid args', () => {
    const nonArrayArgs = generate({
      declaration: {
        mcpServers: {
          teamem: {
            command: 'bun',
            args: 'run ${CLAUDE_PLUGIN_ROOT}/lib/bridge.js'
          },
          'teamem-channel': {
            command: 'bun',
            args: ['run', '${CLAUDE_PLUGIN_ROOT}/lib/channel.js']
          }
        }
      }
    });
    const nonStringArg = generate({
      declaration: {
        mcpServers: {
          teamem: {
            command: 'bun',
            args: ['run', 123]
          },
          'teamem-channel': {
            command: 'bun',
            args: ['run', '${CLAUDE_PLUGIN_ROOT}/lib/channel.js']
          }
        }
      }
    });

    expect(nonArrayArgs).toMatchObject({
      ok: false,
      error: 'Plugin MCP required server args must be a string array: teamem'
    });
    expect(nonStringArg).toMatchObject({
      ok: false,
      error: 'Plugin MCP required server args must be a string array: teamem'
    });
  });

  it('adds profile-scoped env to every generated server', () => {
    const result = generate({
      declaration: {
        mcpServers: {
          teamem: {
            command: 'bun',
            env: {
              EXISTING: 'kept'
            }
          },
          'teamem-channel': {
            command: 'bun'
          }
        }
      }
    });

    expect(result.ok).toBe(true);
    expect(result.ok ? result.config.mcpServers.teamem.env : undefined).toEqual(
      {
        EXISTING: 'kept',
        CLAUDE_PLUGIN_DATA:
          '/tmp/home/.teamem/dev-profiles/alice/plugin-data/teamem',
        CLAUDE_PLUGIN_ROOT: '/src/teamem/plugin',
        TEAMEM_CREDENTIALS:
          '/tmp/home/.teamem/dev-profiles/alice/credentials.json'
      }
    );
    expect(
      result.ok ? result.config.mcpServers['teamem-channel'].env : undefined
    ).toEqual({
      CLAUDE_PLUGIN_DATA:
        '/tmp/home/.teamem/dev-profiles/alice/plugin-data/teamem',
      CLAUDE_PLUGIN_ROOT: '/src/teamem/plugin',
      TEAMEM_CREDENTIALS:
        '/tmp/home/.teamem/dev-profiles/alice/credentials.json'
    });
  });

  it('does not copy broad parent env while MCP allowlist env mode is active', () => {
    const original = process.env.CLAUDE_CODE_MCP_ALLOWLIST_ENV;
    const leaked = process.env.PARENT_ONLY_SECRET;
    process.env.CLAUDE_CODE_MCP_ALLOWLIST_ENV = '1';
    process.env.PARENT_ONLY_SECRET = 'do-not-copy';
    try {
      const result = generate();

      expect(result.ok).toBe(true);
      const env = result.ok ? result.config.mcpServers.teamem.env : {};
      expect(env.CLAUDE_CODE_MCP_ALLOWLIST_ENV).toBeUndefined();
      expect(env.PARENT_ONLY_SECRET).toBeUndefined();
      expect(env.CLAUDE_PLUGIN_DATA).toBe(
        '/tmp/home/.teamem/dev-profiles/alice/plugin-data/teamem'
      );
      expect(env.CLAUDE_PLUGIN_ROOT).toBe('/src/teamem/plugin');
      expect(env.TEAMEM_CREDENTIALS).toBe(
        '/tmp/home/.teamem/dev-profiles/alice/credentials.json'
      );
    } finally {
      restoreEnv('CLAUDE_CODE_MCP_ALLOWLIST_ENV', original);
      restoreEnv('PARENT_ONLY_SECRET', leaked);
    }
  });

  it('rejects plugin-root placeholder paths that escape the selected plugin checkout', () => {
    const escapedBridge = generate({
      declaration: {
        mcpServers: {
          teamem: {
            command: 'bun',
            args: ['run', '${CLAUDE_PLUGIN_ROOT}/../../outside/bridge.js']
          },
          'teamem-channel': {
            command: 'bun',
            args: ['run', '${CLAUDE_PLUGIN_ROOT}/lib/channel.js']
          }
        }
      }
    });
    const escapedEnv = generate({
      declaration: {
        mcpServers: {
          teamem: {
            command: 'bun',
            args: ['run', '${CLAUDE_PLUGIN_ROOT}/lib/bridge.js'],
            env: {
              TEAMEM_BRIDGE_LOG: '${CLAUDE_PLUGIN_ROOT}/../outside.log'
            }
          },
          'teamem-channel': {
            command: 'bun',
            args: ['run', '${CLAUDE_PLUGIN_ROOT}/lib/channel.js']
          }
        }
      }
    });
    const escapedEmbeddedArg = generate({
      declaration: {
        mcpServers: {
          teamem: {
            command: 'bun',
            args: [
              'run',
              '${CLAUDE_PLUGIN_ROOT}/lib/bridge.js',
              '--log=${CLAUDE_PLUGIN_ROOT}/../../outside.log'
            ]
          },
          'teamem-channel': {
            command: 'bun',
            args: ['run', '${CLAUDE_PLUGIN_ROOT}/lib/channel.js']
          }
        }
      }
    });

    expect(escapedBridge).toMatchObject({
      ok: false,
      error:
        'Plugin MCP declaration contains a CLAUDE_PLUGIN_ROOT path outside the selected plugin checkout.'
    });
    expect(escapedEnv).toMatchObject({
      ok: false,
      error:
        'Plugin MCP declaration contains a CLAUDE_PLUGIN_ROOT path outside the selected plugin checkout.'
    });
    expect(escapedEmbeddedArg).toMatchObject({
      ok: false,
      error:
        'Plugin MCP declaration contains a CLAUDE_PLUGIN_ROOT path outside the selected plugin checkout.'
    });
  });

  it('rejects marketplace cache paths in generated config', () => {
    const result = generate({
      declaration: {
        mcpServers: {
          teamem: {
            command: 'bun',
            args: [
              'run',
              '/Users/me/.claude/plugins/cache/teamem/lib/bridge.js'
            ]
          },
          'teamem-channel': {
            command: 'bun',
            args: ['run', '${CLAUDE_PLUGIN_ROOT}/lib/channel.js']
          }
        }
      }
    });

    expect(result).toMatchObject({
      ok: false,
      error:
        'Generated MCP config contains a marketplace cache path; use the selected local plugin declaration instead.'
    });
  });

  it('rejects invalid plugin MCP declarations', () => {
    expect(generate({ content: '{' })).toMatchObject({
      ok: false,
      error:
        'Plugin MCP declaration is malformed JSON: /src/teamem/plugin/.mcp.json'
    });
    expect(generate({ declaration: { nope: {} } })).toMatchObject({
      ok: false,
      error: 'Plugin MCP declaration must contain an object mcpServers map.'
    });
    expect(
      generate({
        declaration: {
          mcpServers: {
            teamem: {
              command: 'bun',
              env: { BAD: 123 }
            },
            'teamem-channel': {
              command: 'bun'
            }
          }
        }
      })
    ).toMatchObject({
      ok: false,
      error: 'Plugin MCP server env must be a string map: teamem'
    });
  });
});

function generate(
  options: {
    readonly declaration?: unknown;
    readonly content?: string;
  } = {}
): ReturnType<typeof generateDevMcpConfig> {
  return generateDevMcpConfig({
    source: sourceResolution(),
    profile: resolveDevProfilePaths({
      homeDir: '/tmp/home',
      profileName: 'alice'
    }),
    fileSystem: pluginDeclarationFileSystem(
      options.content ??
        JSON.stringify(
          options.declaration ?? {
            mcpServers: {
              teamem: {
                command: 'bun',
                args: ['run', '${CLAUDE_PLUGIN_ROOT}/lib/bridge.js']
              },
              'teamem-channel': {
                command: 'bun',
                args: ['run', '${CLAUDE_PLUGIN_ROOT}/lib/channel.js']
              }
            }
          }
        )
    )
  });
}

function sourceResolution(): DevSourceResolution {
  return {
    teamemRoot: '/src/teamem',
    pluginRoot: '/src/teamem/plugin',
    launchCwd: '/work/project',
    source: 'flag'
  };
}

function pluginDeclarationFileSystem(content: string): DevMcpConfigFileSystem {
  return {
    isReadableFile(path: string): boolean {
      return path === '/src/teamem/plugin/.mcp.json';
    },
    readFile(path: string): string {
      if (path !== '/src/teamem/plugin/.mcp.json') {
        throw new Error(`Unexpected read: ${path}`);
      }
      return content;
    }
  };
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
