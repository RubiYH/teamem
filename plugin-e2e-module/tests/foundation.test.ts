import { describe, expect, it } from 'bun:test';
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
  mkdir,
  stat
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ClaudeAuthError,
  ClaudeBinaryError,
  ClaudeFeatureError,
  ClaudeVersionError,
  PluginValidationError,
  RedactionConfigError,
  createClaudePluginTester,
  normalizeClaudeCommand,
  validatePluginSource,
  type ProcessRunner,
  type ProcessRunRequest,
  type ProcessRunResult
} from '../src/index.js';

const moduleRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const fakePluginDir = join(moduleRoot, 'fixtures', 'fake-plugin');

describe('plugin-e2e-module foundation', () => {
  it('normalizes claudeBin and structured claudeCommand without shell strings', () => {
    expect(normalizeClaudeCommand({ claudeBin: '/bin/claude' })).toEqual({
      command: '/bin/claude',
      args: []
    });
    expect(
      normalizeClaudeCommand({
        claudeCommand: { command: '/bin/env', args: ['claude'] }
      })
    ).toEqual({
      command: '/bin/env',
      args: ['claude']
    });
    expect(() =>
      normalizeClaudeCommand({
        claudeBin: 'claude',
        claudeCommand: { command: 'claude' }
      })
    ).toThrow(ClaudeBinaryError);
  });

  it('boots through command plus args and validates plugin source', async () => {
    const calls: ProcessRunRequest[] = [];
    const runner = createFakeClaudeRunner(calls);
    const tester = createClaudePluginTester({
      pluginDir: fakePluginDir,
      claudeCommand: { command: '/usr/bin/env', args: ['claude'] },
      processRunner: runner
    });

    const boot = await tester.boot();

    expect(boot.plugin.manifest.name).toBe('generic-fake-plugin');
    expect(boot.claudeVersion).toBe('2.1.158');
    expect(calls.map((call) => [call.command, call.args])).toEqual([
      ['/usr/bin/env', ['claude', '--version']],
      ['/usr/bin/env', ['claude', 'auth', 'status', '--json']],
      ['/usr/bin/env', ['claude', '--help']],
      ['/usr/bin/env', ['claude', '--version']]
    ]);
  });

  it('fails boot with typed errors for missing, unauthenticated, unsupported, and old Claude', async () => {
    await expect(
      createClaudePluginTester({
        pluginDir: fakePluginDir,
        processRunner: async () => ({
          exitCode: null,
          stdout: '',
          stderr: '',
          errorCode: 'ENOENT'
        })
      }).boot()
    ).rejects.toThrow(ClaudeBinaryError);

    await expect(
      createClaudePluginTester({
        pluginDir: fakePluginDir,
        processRunner: createFakeClaudeRunner([], {
          authStdout: '{"authenticated":false}'
        })
      }).boot()
    ).rejects.toThrow(ClaudeAuthError);

    await expect(
      createClaudePluginTester({
        pluginDir: fakePluginDir,
        processRunner: createFakeClaudeRunner([], {
          helpStdout: 'Usage: claude -p --output-format'
        })
      }).boot()
    ).rejects.toThrow(ClaudeFeatureError);

    await expect(
      createClaudePluginTester({
        pluginDir: fakePluginDir,
        minClaudeVersion: '9.0.0',
        processRunner: createFakeClaudeRunner([])
      }).boot()
    ).rejects.toThrow(ClaudeVersionError);
  });

  it('supports explicit minimum version opt-out', async () => {
    const tester = createClaudePluginTester({
      pluginDir: fakePluginDir,
      minClaudeVersion: false,
      processRunner: createFakeClaudeRunner([], {
        versionStdout: '0.1.0 (Claude Code)'
      })
    });

    await expect(tester.boot()).resolves.toMatchObject({
      claudeVersion: '0.1.0'
    });
  });

  it('validates manifest, hook, and MCP JSON shape locally', async () => {
    await expect(validatePluginSource(fakePluginDir)).resolves.toMatchObject({
      manifest: { name: 'generic-fake-plugin' }
    });

    const missingManifestDir = await mkdtemp(
      join(tmpdir(), 'claude-plugin-e2e-invalid-')
    );
    const badHooksDir = await mkdtemp(
      join(tmpdir(), 'claude-plugin-e2e-bad-hooks-')
    );
    try {
      await expect(validatePluginSource(missingManifestDir)).rejects.toThrow(
        PluginValidationError
      );

      await mkdir(join(badHooksDir, '.claude-plugin'), { recursive: true });
      await mkdir(join(badHooksDir, 'hooks'), { recursive: true });
      await writeFile(
        join(badHooksDir, '.claude-plugin', 'plugin.json'),
        '{"name":"bad-hooks"}',
        'utf8'
      );
      await writeFile(join(badHooksDir, 'hooks', 'hooks.json'), '{', 'utf8');

      await expect(validatePluginSource(badHooksDir)).rejects.toThrow(
        PluginValidationError
      );
    } finally {
      await rm(missingManifestDir, { recursive: true, force: true });
      await rm(badHooksDir, { recursive: true, force: true });
    }
  });

  it('creates per-run baseline artifacts with safe curated env redaction', async () => {
    const artifactsDir = await mkdtemp(
      join(tmpdir(), 'claude-plugin-e2e-art-')
    );
    try {
      const tester = createClaudePluginTester({
        pluginDir: fakePluginDir,
        artifactsDir,
        cleanup: 'never',
        env: {
          CLAUDE_PLUGIN_ROOT: '/secret/plugin',
          CLAUDE_PLUGIN_DATA: '/secret/data',
          CLAUDE_SESSION_ID: 'session-secret',
          CLAUDE_PROJECT_DIR: '/secret/project',
          SHOULD_NOT_BE_CAPTURED: 'secret'
        },
        processRunner: createFakeClaudeRunner([])
      });

      const result = await tester.prompt('hello');
      const environment = JSON.parse(
        await readFile(result.artifacts.environmentPath, 'utf8')
      ) as {
        redactionMode: string;
        env: Record<string, string>;
      };
      const summary = JSON.parse(
        await readFile(result.artifacts.summaryPath, 'utf8')
      ) as {
        kind: string;
        rawDir?: string;
        artifacts: { rawDir: string };
      };

      expect(result.kind).toBe('headless');
      expect(environment).toEqual({
        redactionMode: 'safe',
        env: {
          CLAUDE_PLUGIN_ROOT: '[REDACTED]',
          CLAUDE_PLUGIN_DATA: '[REDACTED]',
          CLAUDE_SESSION_ID: '[REDACTED]',
          CLAUDE_PROJECT_DIR: '[REDACTED]'
        }
      });
      expect(environment.env.SHOULD_NOT_BE_CAPTURED).toBeUndefined();
      expect(Object.keys(environment.env).sort()).toEqual([
        'CLAUDE_PLUGIN_DATA',
        'CLAUDE_PLUGIN_ROOT',
        'CLAUDE_PROJECT_DIR',
        'CLAUDE_SESSION_ID'
      ]);
      expect(summary.kind).toBe('headless-prompt');
      await expect(stat(summary.artifacts.rawDir)).resolves.toBeTruthy();
    } finally {
      await rm(artifactsDir, { recursive: true, force: true });
    }
  });

  it('requires an explicit process env gate before writing unredacted artifacts', async () => {
    const previousAllowUnredacted =
      process.env.CLAUDE_PLUGIN_E2E_ALLOW_UNREDACTED;
    delete process.env.CLAUDE_PLUGIN_E2E_ALLOW_UNREDACTED;

    await expect(
      createClaudePluginTester({
        pluginDir: fakePluginDir,
        cleanup: 'never',
        redaction: { mode: 'off' },
        env: {
          CLAUDE_PLUGIN_DATA: '/secret/data'
        },
        processRunner: createFakeClaudeRunner([])
      }).boot()
    ).rejects.toThrow(RedactionConfigError);

    process.env.CLAUDE_PLUGIN_E2E_ALLOW_UNREDACTED = '1';
    const artifactsDir = await mkdtemp(
      join(tmpdir(), 'claude-plugin-e2e-unredacted-')
    );
    try {
      const tester = createClaudePluginTester({
        pluginDir: fakePluginDir,
        artifactsDir,
        cleanup: 'never',
        redaction: { mode: 'off' },
        env: {
          CLAUDE_PLUGIN_DATA: '/secret/data'
        },
        processRunner: createFakeClaudeRunner([])
      });

      const result = await tester.prompt('hello');
      const environment = JSON.parse(
        await readFile(result.artifacts.environmentPath, 'utf8')
      ) as { redactionMode: string; env: Record<string, string> };

      expect(environment).toEqual({
        redactionMode: 'off',
        env: {
          CLAUDE_PLUGIN_DATA: '/secret/data'
        }
      });
    } finally {
      if (previousAllowUnredacted === undefined) {
        delete process.env.CLAUDE_PLUGIN_E2E_ALLOW_UNREDACTED;
      } else {
        process.env.CLAUDE_PLUGIN_E2E_ALLOW_UNREDACTED =
          previousAllowUnredacted;
      }
      await rm(artifactsDir, { recursive: true, force: true });
    }
  });

  it('uses a temporary artifact root by default when no persistent dir is configured', async () => {
    const tester = createClaudePluginTester({
      pluginDir: fakePluginDir,
      processRunner: createFakeClaudeRunner([])
    });

    const boot = await tester.boot();

    expect(boot.artifactsRoot.startsWith(join(tmpdir(), ''))).toBe(true);
    expect(boot.artifactsRoot).toContain('claude-plugin-e2e-');
  });

  it('defaults cleanup mode to always for headless prompt runs', async () => {
    const artifactsDir = await mkdtemp(
      join(tmpdir(), 'claude-plugin-e2e-cleanup-')
    );
    try {
      const tester = createClaudePluginTester({
        pluginDir: fakePluginDir,
        artifactsDir,
        processRunner: createFakeClaudeRunner([])
      });

      const result = await tester.prompt('cleanup');

      await expect(stat(result.artifacts.dir)).rejects.toThrow();
    } finally {
      await rm(artifactsDir, { recursive: true, force: true });
    }
  });

  it('cleanup mode always removes failed run artifacts', async () => {
    const artifactsDir = await mkdtemp(
      join(tmpdir(), 'claude-plugin-e2e-cleanup-fail-')
    );
    try {
      const tester = createClaudePluginTester({
        pluginDir: fakePluginDir,
        artifactsDir,
        cleanup: 'always',
        processRunner: createFakeClaudeRunner([], {
          promptExitCode: 9,
          promptStdout: 'partial stdout',
          promptStderr: 'partial stderr'
        })
      });

      await expect(tester.prompt('cleanup failure')).rejects.toThrow();

      expect(await readdir(artifactsDir)).toEqual([]);
    } finally {
      await rm(artifactsDir, { recursive: true, force: true });
    }
  });
});

function createFakeClaudeRunner(
  calls: ProcessRunRequest[],
  overrides: {
    versionStdout?: string;
    authStdout?: string;
    helpStdout?: string;
    promptExitCode?: number;
    promptStdout?: string;
    promptStderr?: string;
  } = {}
): ProcessRunner {
  return async (request: ProcessRunRequest): Promise<ProcessRunResult> => {
    calls.push(request);
    const args = request.args;
    const subcommand = args.slice(-4).join(' ');

    if (args.at(-1) === '--version') {
      return ok(overrides.versionStdout ?? '2.1.158 (Claude Code)');
    }

    if (subcommand.endsWith('auth status --json')) {
      return ok(overrides.authStdout ?? '{"authenticated":true}');
    }

    if (args.at(-1) === '--help') {
      return ok(
        overrides.helpStdout ??
          'Usage: claude --plugin-dir ./plugin -p --output-format stream-json --verbose --include-hook-events --permission-mode auto'
      );
    }

    if (
      args.includes('-p') &&
      args.includes('--output-format') &&
      args.includes('stream-json') &&
      args.includes('--include-hook-events')
    ) {
      return {
        exitCode: overrides.promptExitCode ?? 0,
        stdout:
          overrides.promptStdout ??
          `${JSON.stringify({
            type: 'assistant',
            message: { role: 'assistant', content: [{ text: 'fake hello' }] }
          })}\n`,
        stderr: overrides.promptStderr ?? ''
      };
    }

    return {
      exitCode: 1,
      stdout: '',
      stderr: `Unexpected fake Claude call: ${args.join(' ')}`
    };
  };
}

function ok(stdout: string): ProcessRunResult {
  return {
    exitCode: 0,
    stdout,
    stderr: ''
  };
}
