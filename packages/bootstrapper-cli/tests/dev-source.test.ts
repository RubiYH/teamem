import { describe, expect, it } from 'bun:test';

import {
  probeDevSourcePrerequisites,
  renderDevSourceProbeReport,
  type DevSourceFileSystem
} from '../src/dev-source.js';
import type {
  CommandProbeResult,
  CommandRunner
} from '../src/prerequisites.js';

describe('dev source checkout probes', () => {
  it('uses an explicit Teamem source root independently from launch cwd', () => {
    const report = probeDevSourcePrerequisites({
      cwd: '/work/launch-repo',
      requestedTeamemRoot: '/src/teamem',
      requestedLaunchCwd: '/work/launch-repo/subdir',
      pathEnv: '/home/.teamem/bin:/opt/claude/bin',
      homeDir: '/home',
      fileSystem: createDevSourceFileSystem({
        roots: ['/src/teamem'],
        executableFiles: ['/opt/claude/bin/claude']
      }),
      commandRunner: createDevSourceRunner('/src/teamem')
    });

    expect(report.hasErrors).toBe(false);
    expect(report.resolution).toEqual({
      teamemRoot: '/src/teamem',
      pluginRoot: '/src/teamem/plugin',
      launchCwd: '/work/launch-repo/subdir',
      source: 'flag'
    });
    expect(
      report.diagnostics.find(
        (diagnostic) => diagnostic.id === 'real-claude'
      )?.details
    ).toBe('/opt/claude/bin/claude');
  });

  it('detects a Teamem source checkout from a nested current directory', () => {
    const report = probeDevSourcePrerequisites({
      cwd: '/src/teamem/packages/bootstrapper-cli',
      pathEnv: '/opt/claude/bin',
      fileSystem: createDevSourceFileSystem({
        roots: ['/src/teamem'],
        executableFiles: ['/opt/claude/bin/claude']
      }),
      commandRunner: createDevSourceRunner('/src/teamem')
    });

    expect(report.hasErrors).toBe(false);
    expect(report.resolution?.teamemRoot).toBe('/src/teamem');
    expect(report.resolution?.launchCwd).toBe(
      '/src/teamem/packages/bootstrapper-cli'
    );
    expect(report.resolution?.source).toBe('cwd');
  });

  it('fails with source-checkout-required instead of marketplace fallback', () => {
    const report = probeDevSourcePrerequisites({
      cwd: '/published/bootstrapper-consumer',
      pathEnv: '/opt/claude/bin',
      fileSystem: createDevSourceFileSystem({
        executableFiles: ['/opt/claude/bin/claude']
      }),
      commandRunner: createDevSourceRunner('/src/teamem')
    });

    expect(report.hasErrors).toBe(true);
    expect(
      report.diagnostics.find(
        (diagnostic) => diagnostic.id === 'teamem-source-checkout'
      )?.summary
    ).toContain('No Teamem source checkout');
    expect(renderDevSourceProbeReport(report, { dryRun: true })).toContain(
      'source-checkout-required'
    );
  });

  it('reports missing local plugin manifest as a source checkout error', () => {
    const fileSystem = createDevSourceFileSystem({
      roots: ['/src/teamem'],
      executableFiles: ['/opt/claude/bin/claude']
    });
    fileSystem.files.delete('/src/teamem/plugin/.claude-plugin/plugin.json');

    const report = probeDevSourcePrerequisites({
      cwd: '/src/teamem',
      pathEnv: '/opt/claude/bin',
      fileSystem,
      commandRunner: createDevSourceRunner('/src/teamem')
    });

    expect(report.hasErrors).toBe(true);
    expect(
      report.diagnostics.find(
        (diagnostic) => diagnostic.id === 'plugin-manifest'
      )?.summary
    ).toContain('missing or unreadable');
  });

  it('reports missing plugin MCP and missing teamem-channel declarations', () => {
    const missingMcp = createDevSourceFileSystem({
      roots: ['/src/teamem'],
      executableFiles: ['/opt/claude/bin/claude']
    });
    missingMcp.files.delete('/src/teamem/plugin/.mcp.json');
    const missingMcpReport = probeDevSourcePrerequisites({
      cwd: '/src/teamem',
      pathEnv: '/opt/claude/bin',
      fileSystem: missingMcp,
      commandRunner: createDevSourceRunner('/src/teamem')
    });
    expect(
      missingMcpReport.diagnostics.find(
        (diagnostic) => diagnostic.id === 'plugin-mcp'
      )?.severity
    ).toBe('error');

    const missingChannel = createDevSourceFileSystem({
      roots: ['/src/teamem'],
      executableFiles: ['/opt/claude/bin/claude'],
      includeChannel: false
    });
    const missingChannelReport = probeDevSourcePrerequisites({
      cwd: '/src/teamem',
      pathEnv: '/opt/claude/bin',
      fileSystem: missingChannel,
      commandRunner: createDevSourceRunner('/src/teamem')
    });
    expect(
      missingChannelReport.diagnostics.find(
        (diagnostic) => diagnostic.id === 'teamem-channel'
      )?.severity
    ).toBe('error');
  });

  it('reports missing Bun and missing real Claude Code as prerequisite errors', () => {
    const report = probeDevSourcePrerequisites({
      cwd: '/src/teamem',
      pathEnv: '/home/.teamem/bin',
      homeDir: '/home',
      fileSystem: createDevSourceFileSystem({
        roots: ['/src/teamem'],
        executableFiles: ['/home/.teamem/bin/claude']
      }),
      commandRunner: createDevSourceRunner('/src/teamem', {
        bun: missing()
      })
    });

    expect(report.hasErrors).toBe(true);
    expect(
      report.diagnostics.find((diagnostic) => diagnostic.id === 'bun')
        ?.severity
    ).toBe('error');
    expect(
      report.diagnostics.find(
        (diagnostic) => diagnostic.id === 'real-claude'
      )?.severity
    ).toBe('error');
    expect(renderDevSourceProbeReport(report, { dryRun: true })).toContain(
      'prerequisite-failed'
    );
    expect(renderDevSourceProbeReport(report, { dryRun: true })).not.toContain(
      'source-checkout-required'
    );
  });

  it('discloses dirty source checkout state without blocking', () => {
    const report = probeDevSourcePrerequisites({
      cwd: '/src/teamem',
      pathEnv: '/opt/claude/bin',
      fileSystem: createDevSourceFileSystem({
        roots: ['/src/teamem'],
        executableFiles: ['/opt/claude/bin/claude']
      }),
      commandRunner: createDevSourceRunner('/src/teamem', {
        dirtyStatus: ' M packages/bootstrapper-cli/src/cli.ts\n?? scratch.md\n'
      })
    });

    expect(report.hasErrors).toBe(false);
    const dirty = report.diagnostics.find(
      (diagnostic) => diagnostic.id === 'source-dirty'
    );
    expect(dirty?.severity).toBe('warning');
    expect(dirty?.summary).toContain('2 dirty path(s)');
  });
});

function createDevSourceFileSystem(
  options: {
    readonly roots?: readonly string[];
    readonly executableFiles?: readonly string[];
    readonly includeChannel?: boolean;
  } = {}
): DevSourceFileSystem & {
  readonly files: Map<string, string>;
  readonly directories: Set<string>;
  readonly executableFiles: Set<string>;
} {
  const files = new Map<string, string>();
  const directories = new Set<string>();
  const executableFiles = new Set(options.executableFiles ?? []);

  for (const root of options.roots ?? []) {
    addDirectory(directories, root);
    addFile(
      files,
      directories,
      `${root}/package.json`,
      '{"name":"teamem","private":true}\n'
    );
    addFile(
      files,
      directories,
      `${root}/plugin/.claude-plugin/plugin.json`,
      '{"name":"teamem","mcpServers":"./.mcp.json"}\n'
    );
    addFile(
      files,
      directories,
      `${root}/plugin/.mcp.json`,
      JSON.stringify({
        mcpServers: {
          teamem: { command: 'bun', args: ['run', 'bridge.js'] },
          ...(options.includeChannel === false
            ? {}
            : {
                'teamem-channel': {
                  command: 'bun',
                  args: ['run', 'channel.js']
                }
              })
        }
      })
    );
  }

  return {
    files,
    directories,
    executableFiles,
    exists(path: string): boolean {
      return files.has(path) || directories.has(path) || executableFiles.has(path);
    },
    isDirectory(path: string): boolean {
      return directories.has(path);
    },
    isReadableFile(path: string): boolean {
      return files.has(path);
    },
    isExecutableFile(path: string): boolean {
      return executableFiles.has(path);
    },
    readFile(path: string): string {
      const value = files.get(path);
      if (value === undefined) {
        throw new Error(`Missing file: ${path}`);
      }
      return value;
    }
  };
}

function addFile(
  files: Map<string, string>,
  directories: Set<string>,
  path: string,
  content: string
): void {
  addDirectory(directories, path.slice(0, path.lastIndexOf('/')));
  files.set(path, content);
}

function addDirectory(directories: Set<string>, path: string): void {
  const parts = path.split('/').filter(Boolean);
  let current = path.startsWith('/') ? '' : '.';
  for (const part of parts) {
    current = current === '' ? `/${part}` : `${current}/${part}`;
    directories.add(current);
  }
}

function createDevSourceRunner(
  teamemRoot: string,
  options: {
    readonly bun?: CommandProbeResult;
    readonly dirtyStatus?: string;
  } = {}
): CommandRunner {
  return {
    run(command: string, args: readonly string[]): CommandProbeResult {
      const key = `${command} ${args.join(' ')}`;
      if (key === 'bun --version') {
        return options.bun ?? ok('1.2.0\n');
      }
      if (key === `git -C ${teamemRoot} branch --show-current`) {
        return ok('feature/dev-claude\n');
      }
      if (key === `git -C ${teamemRoot} status --short`) {
        return ok(options.dirtyStatus ?? '');
      }
      return missing();
    }
  };
}

function ok(stdout = ''): CommandProbeResult {
  return { exitCode: 0, stdout, stderr: '' };
}

function missing(): CommandProbeResult {
  return { exitCode: null, stdout: '', stderr: '', errorCode: 'ENOENT' };
}
