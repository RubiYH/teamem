import { describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PluginValidationError,
  createClaudePluginTester,
  type ProcessRunRequest,
  type ProcessRunResult,
  type ProcessRunner
} from '../src/index.js';

const moduleRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const fakePluginDir = join(moduleRoot, 'fixtures', 'fake-plugin');

describe('plugin-e2e-module Claude plugin validation', () => {
  it('validates the source plugin through the structured Claude command', async () => {
    const calls: ProcessRunRequest[] = [];
    const artifactsDir = await mkdtemp(
      join(tmpdir(), 'claude-plugin-e2e-validation-')
    );
    const cwd = await mkdtemp(join(tmpdir(), 'claude-plugin-e2e-cwd-'));

    try {
      const tester = createClaudePluginTester({
        pluginDir: fakePluginDir,
        cwd,
        artifactsDir,
        cleanup: 'never',
        claudeCommand: { command: '/usr/bin/env', args: ['claude', '--shim'] },
        processRunner: createFakeClaudeRunner(calls)
      });

      const result = await tester.validatePlugin();
      const summary = JSON.parse(
        await readFile(result.artifacts.summaryPath, 'utf8')
      ) as {
        kind: string;
        target: { kind: string };
        pluginDir: string;
        command: { command: string; args: string[] };
        exitStatus: { exitCode: number };
      };

      expect(result).toMatchObject({
        kind: 'plugin-validation',
        target: { kind: 'source' },
        pluginDir: fakePluginDir,
        command: {
          command: '/usr/bin/env',
          args: [
            'claude',
            '--shim',
            'plugin',
            'validate',
            fakePluginDir,
            '--strict'
          ]
        },
        cwd,
        exitCode: 0,
        stdout: 'valid\n',
        stderr: ''
      });
      expect(calls.map((call) => [call.command, call.args])).toEqual([
        [
          '/usr/bin/env',
          ['claude', '--shim', 'plugin', 'validate', fakePluginDir, '--strict']
        ]
      ]);
      expect(calls[0].cwd).toBe(cwd);
      expect(summary).toMatchObject({
        kind: 'plugin-validation',
        target: { kind: 'source' },
        pluginDir: fakePluginDir,
        command: result.command,
        exitStatus: { exitCode: 0 }
      });
      await expect(stat(result.artifacts.rawStdoutPath)).resolves.toBeTruthy();
      expect(await readFile(result.artifacts.rawStdoutPath, 'utf8')).toBe(
        '[REDACTED]'
      );
      expect(result.stdout).toBe('valid\n');
    } finally {
      await rm(artifactsDir, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not run boot or auth checks before validation succeeds', async () => {
    const calls: ProcessRunRequest[] = [];
    const tester = createClaudePluginTester({
      pluginDir: fakePluginDir,
      processRunner: createFakeClaudeRunner(calls)
    });

    await tester.validatePlugin();

    expect(calls.map((call) => call.args)).toEqual([
      ['plugin', 'validate', fakePluginDir, '--strict']
    ]);
  });

  it('redacts validation failure artifacts and PluginValidationError details in safe mode', async () => {
    const calls: ProcessRunRequest[] = [];
    const artifactsDir = await mkdtemp(
      join(tmpdir(), 'claude-plugin-e2e-validation-fail-')
    );
    const stdoutSecret = 'validation-stdout-secret-must-not-leak';
    const stderrSecret = 'validation-stderr-secret-must-not-leak';

    try {
      const tester = createClaudePluginTester({
        pluginDir: fakePluginDir,
        artifactsDir,
        cleanup: 'on-success',
        processRunner: createFakeClaudeRunner(calls, {
          validationExitCode: 9,
          validationStdout: `partial validation stdout ${stdoutSecret}`,
          validationStderr: `strict validation failed ${stderrSecret}`
        })
      });

      let thrown: PluginValidationError | undefined;
      try {
        await tester.validatePlugin();
      } catch (error) {
        expect(error).toBeInstanceOf(PluginValidationError);
        thrown = error as PluginValidationError;
      }

      const runDirs = await readdir(artifactsDir);
      expect(runDirs).toHaveLength(1);
      const runDir = join(artifactsDir, runDirs[0]);
      const summaryPath = join(runDir, 'run-summary.json');
      const stdoutPath = join(runDir, 'raw', 'stdout.raw');
      const stderrPath = join(runDir, 'raw', 'stderr.raw');
      const summary = JSON.parse(await readFile(summaryPath, 'utf8')) as {
        exitStatus: { exitCode: number };
        artifacts: { rawStdoutPath: string; rawStderrPath: string };
      };

      expect(summary.exitStatus.exitCode).toBe(9);
      expect(summary.artifacts.rawStdoutPath).toBe(stdoutPath);
      expect(summary.artifacts.rawStderrPath).toBe(stderrPath);
      expect(await readFile(stdoutPath, 'utf8')).toBe('[REDACTED]');
      expect(await readFile(stderrPath, 'utf8')).toBe('[REDACTED]');
      expect(thrown?.exitCode).toBe(9);
      expect(thrown?.stdout).toBe('[REDACTED]');
      expect(thrown?.stderr).toBe('[REDACTED]');
      expect(thrown?.artifactsDir).toContain(artifactsDir);
      expect(thrown?.artifactPaths).toContain(summaryPath);
      expect(
        [
          await readFile(stdoutPath, 'utf8'),
          await readFile(stderrPath, 'utf8'),
          thrown?.stdout,
          thrown?.stderr
        ].join('\n')
      ).not.toContain('must-not-leak');
    } finally {
      await rm(artifactsDir, { recursive: true, force: true });
    }
  });

  it('preserves validation output artifacts when unredacted artifacts are explicitly allowed', async () => {
    const previousAllowUnredacted =
      process.env.CLAUDE_PLUGIN_E2E_ALLOW_UNREDACTED;
    process.env.CLAUDE_PLUGIN_E2E_ALLOW_UNREDACTED = '1';
    const artifactsDir = await mkdtemp(
      join(tmpdir(), 'claude-plugin-e2e-validation-unredacted-')
    );
    const secret = 'allowed-validation-secret';

    try {
      const tester = createClaudePluginTester({
        pluginDir: fakePluginDir,
        artifactsDir,
        cleanup: 'never',
        redaction: { mode: 'off' },
        processRunner: createFakeClaudeRunner([], {
          validationStdout: `valid ${secret}\n`,
          validationStderr: `debug ${secret}`
        })
      });

      const result = await tester.validatePlugin();

      expect(await readFile(result.artifacts.rawStdoutPath, 'utf8')).toContain(
        secret
      );
      expect(await readFile(result.artifacts.rawStderrPath, 'utf8')).toContain(
        secret
      );
      expect(await readFile(result.artifacts.debugLogPath, 'utf8')).toContain(
        secret
      );
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

  it('rejects unavailable validation targets with a typed error', async () => {
    const tester = createClaudePluginTester({
      pluginDir: fakePluginDir,
      processRunner: createFakeClaudeRunner([])
    });

    await expect(
      tester.validatePlugin({
        target: { kind: 'unsupported' } as never
      })
    ).rejects.toThrow(PluginValidationError);
  });
});

function createFakeClaudeRunner(
  calls: ProcessRunRequest[],
  overrides: {
    validationExitCode?: number;
    validationStdout?: string;
    validationStderr?: string;
  } = {}
): ProcessRunner {
  return async (request: ProcessRunRequest): Promise<ProcessRunResult> => {
    calls.push(request);
    const args = request.args;

    if (
      args.at(-4) === 'plugin' &&
      args.at(-3) === 'validate' &&
      args.at(-2) === fakePluginDir &&
      args.at(-1) === '--strict'
    ) {
      return {
        exitCode: overrides.validationExitCode ?? 0,
        stdout: overrides.validationStdout ?? 'valid\n',
        stderr: overrides.validationStderr ?? ''
      };
    }

    return {
      exitCode: 1,
      stdout: '',
      stderr: `Unexpected fake Claude call: ${args.join(' ')}`
    };
  };
}
