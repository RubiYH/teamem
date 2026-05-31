import { describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import { chmod, cp, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TraceAssertionError,
  createClaudePluginTester,
  expectHook,
  findHook,
  readHookTraces,
  type ProcessRunRequest,
  type ProcessRunResult,
  type ProcessRunner
} from '../src/index.js';

const moduleRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const fakePluginDir = join(moduleRoot, 'fixtures', 'fake-plugin');

describe('plugin-e2e-module hook instrumentation', () => {
  it('copies the plugin once per tester and preserves executable bits', async () => {
    const artifactsDir = await mkdtemp(
      join(tmpdir(), 'claude-plugin-e2e-copy-')
    );
    const sourceDir = await mkdtemp(
      join(tmpdir(), 'claude-plugin-e2e-source-')
    );

    try {
      await cp(fakePluginDir, sourceDir, { recursive: true });
      const sourceScript = join(sourceDir, 'scripts', 'session-start.js');
      await chmod(sourceScript, 0o755);

      const tester = createClaudePluginTester({
        pluginDir: sourceDir,
        artifactsDir,
        cleanup: 'never',
        processRunner: createBootRunner()
      });

      const firstBoot = await tester.boot();
      const secondBoot = await tester.boot();
      const copiedScript = join(
        firstBoot.instrumentedPlugin.pluginDir,
        'scripts',
        'session-start.js'
      );

      expect(firstBoot.instrumentedPlugin.pluginDir).toBe(
        secondBoot.instrumentedPlugin.pluginDir
      );
      expect(firstBoot.instrumentedPlugin.pluginDir).not.toBe(sourceDir);
      expect((await stat(copiedScript)).mode & 0o111).toBe(0o111);
      expect(
        await readFile(join(sourceDir, 'hooks', 'hooks.json'), 'utf8')
      ).toBe(
        await readFile(join(fakePluginDir, 'hooks', 'hooks.json'), 'utf8')
      );
    } finally {
      await rm(artifactsDir, { recursive: true, force: true });
      await rm(sourceDir, { recursive: true, force: true });
    }
  });

  it('rewrites command hooks in the copy and preserves hook metadata', async () => {
    const artifactsDir = await mkdtemp(
      join(tmpdir(), 'claude-plugin-e2e-rewrite-')
    );

    try {
      const tester = createClaudePluginTester({
        pluginDir: fakePluginDir,
        artifactsDir,
        cleanup: 'never',
        hookShell: 'bash -lc',
        processRunner: createBootRunner()
      });

      const boot = await tester.boot();
      const sourceConfig = JSON.parse(
        await readFile(join(fakePluginDir, 'hooks', 'hooks.json'), 'utf8')
      ) as HookConfig;
      const copiedConfig = JSON.parse(
        await readFile(
          join(boot.instrumentedPlugin.pluginDir, 'hooks', 'hooks.json'),
          'utf8'
        )
      ) as HookConfig;
      const sourceHook = sourceConfig.hooks.SessionStart[0].hooks[0];
      const copiedHook = copiedConfig.hooks.SessionStart[0].hooks[0];

      expect(copiedConfig.hooks.SessionStart[0].matcher).toBe('*');
      expect(copiedHook.type).toBe(sourceHook.type);
      expect(copiedHook.timeout).toBe(sourceHook.timeout);
      expect(copiedHook.command).toContain('hook-proxy-runner.cjs');
      expect(copiedHook.command).toContain('--event');
      expect(copiedHook.command).toContain('SessionStart');
      expect(copiedHook.command).not.toBe(sourceHook.command);
      expect(
        await readFile(join(fakePluginDir, 'hooks', 'hooks.json'), 'utf8')
      ).toContain('node scripts/session-start.js');
    } finally {
      await rm(artifactsDir, { recursive: true, force: true });
    }
  });

  it('creates safe hook proxy traces with redacted payloads and curated env by default', async () => {
    const artifactsDir = await mkdtemp(
      join(tmpdir(), 'claude-plugin-e2e-hook-proxy-')
    );
    const secret = 'hook-secret-must-not-leak';

    try {
      const tester = createClaudePluginTester({
        pluginDir: fakePluginDir,
        artifactsDir,
        cleanup: 'never',
        processRunner: createBootRunner()
      });
      const boot = await tester.boot();
      const traceDir = join(artifactsDir, 'manual-hook-traces');
      const command = await readSessionStartHookCommand(
        boot.instrumentedPlugin.pluginDir
      );

      const hookRun = await runShellCommand({
        command,
        cwd: boot.instrumentedPlugin.pluginDir,
        stdin: JSON.stringify({ hook: 'SessionStart', secret }),
        env: {
          CLAUDE_PLUGIN_E2E_HOOK_TRACE_DIR: traceDir,
          CLAUDE_PLUGIN_ROOT: '/secret/root',
          CLAUDE_SESSION_ID: 'secret-session-id',
          SHOULD_NOT_BE_CAPTURED: 'arbitrary-secret'
        }
      });

      expect(hookRun.exitCode).toBe(0);
      const traces = await readHookTraces(traceDir);
      const trace = expectHook(traces, 'SessionStart');
      expect(trace.stdin).toBe('[REDACTED]');
      expect(trace.stdinJson).toEqual({
        hook: '[REDACTED]',
        secret: '[REDACTED]'
      });
      expect(trace.stdout).toBe('[REDACTED]');
      expect(trace.stderr).toBe('');
      expect(trace.exitCode).toBe(0);
      expect(trace.durationMs).toBeGreaterThanOrEqual(0);
      expect(trace.environment).toEqual({
        redactionMode: 'safe',
        env: {
          CLAUDE_PLUGIN_ROOT: '[REDACTED]',
          CLAUDE_SESSION_ID: '[REDACTED]'
        }
      });
      expect(trace.environment?.env).not.toHaveProperty(
        'SHOULD_NOT_BE_CAPTURED'
      );
      await expect(readFile(trace.artifacts.stdinPath, 'utf8')).resolves.toBe(
        '[REDACTED]'
      );
      await expect(readFile(trace.artifacts.stdoutPath, 'utf8')).resolves.toBe(
        '[REDACTED]'
      );
      await expect(stat(trace.artifacts.stdinPath)).resolves.toBeTruthy();
      await expect(stat(trace.artifacts.stdoutPath)).resolves.toBeTruthy();
      await expect(stat(trace.artifacts.stderrPath)).resolves.toBeTruthy();
    } finally {
      await rm(artifactsDir, { recursive: true, force: true });
    }
  });

  it('passes the original hook command as the final argument to quoted hookShell args', async () => {
    const artifactsDir = await mkdtemp(
      join(tmpdir(), 'claude-plugin-e2e-hook-shell-')
    );

    try {
      const tester = createClaudePluginTester({
        pluginDir: fakePluginDir,
        artifactsDir,
        cleanup: 'never',
        hookShell:
          'bash -c \'printf "shell-final:%s\\n" "$1"; eval "$1"\' hook-shell',
        processRunner: createBootRunner()
      });
      const boot = await tester.boot();
      const traceDir = join(artifactsDir, 'manual-hook-shell-traces');
      const command = await readSessionStartHookCommand(
        boot.instrumentedPlugin.pluginDir
      );

      const hookRun = await runShellCommand({
        command,
        cwd: boot.instrumentedPlugin.pluginDir,
        stdin: '{"hook":"SessionStart"}',
        env: { CLAUDE_PLUGIN_E2E_HOOK_TRACE_DIR: traceDir }
      });

      expect(hookRun.exitCode).toBe(0);
      expect(hookRun.stdout).toContain(
        'shell-final:node scripts/session-start.js'
      );
      expect(hookRun.stdout).toContain('generic fake plugin session started');
    } finally {
      await rm(artifactsDir, { recursive: true, force: true });
    }
  });

  it('surfaces hook traces on prompt results and assertion helpers', async () => {
    const artifactsDir = await mkdtemp(
      join(tmpdir(), 'claude-plugin-e2e-hook-prompt-')
    );

    try {
      const tester = createClaudePluginTester({
        pluginDir: fakePluginDir,
        artifactsDir,
        cleanup: 'never',
        processRunner: createPromptRunnerThatInvokesHook()
      });

      const result = await tester.prompt('trigger hook');
      const trace = result.expectHook((item) => item.event === 'SessionStart');

      expect(result.findHook('SessionStart')).toBe(trace);
      expect(findHook(result, /Session/)).toBe(trace);
      expect(trace.stdinJson).toEqual({ prompt: '[REDACTED]' });
      expect(trace.stdout).toBe('[REDACTED]');
      expect(result.expectText('assistant after hook')).toBe(result);

      expect(() => result.expectHook('PreToolUse')).toThrow(
        TraceAssertionError
      );
      try {
        result.expectHook('PreToolUse');
      } catch (error) {
        expect(error).toBeInstanceOf(TraceAssertionError);
        expect((error as TraceAssertionError).artifactsDir).toBe(
          result.artifacts.dir
        );
        expect((error as TraceAssertionError).artifactPaths).toContain(
          trace.artifacts.tracePath
        );
      }
    } finally {
      await rm(artifactsDir, { recursive: true, force: true });
    }
  });

  it('preserves hook proxy payloads when redaction off is explicitly gated', async () => {
    const previousAllowUnredacted =
      process.env.CLAUDE_PLUGIN_E2E_ALLOW_UNREDACTED;
    process.env.CLAUDE_PLUGIN_E2E_ALLOW_UNREDACTED = '1';
    const artifactsDir = await mkdtemp(
      join(tmpdir(), 'claude-plugin-e2e-hook-unredacted-')
    );
    const secret = 'hook-secret-allowed';

    try {
      const tester = createClaudePluginTester({
        pluginDir: fakePluginDir,
        artifactsDir,
        cleanup: 'never',
        redaction: { mode: 'off' },
        env: { CLAUDE_SESSION_ID: 'visible-session-id' },
        processRunner: createPromptRunnerThatInvokesHook()
      });

      const result = await tester.prompt(secret);
      const trace = result.expectHook('SessionStart');

      expect(trace.stdin).toBe(JSON.stringify({ prompt: secret }));
      expect(trace.stdinJson).toEqual({ prompt: secret });
      expect(trace.stdout).toContain('generic fake plugin session started');
      expect(trace.environment).toEqual({
        redactionMode: 'off',
        env: { CLAUDE_SESSION_ID: 'visible-session-id' }
      });
      await expect(readFile(trace.artifacts.stdinPath, 'utf8')).resolves.toBe(
        JSON.stringify({ prompt: secret })
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

  it('validates the instrumented plugin copy when requested', async () => {
    const calls: ProcessRunRequest[] = [];
    const artifactsDir = await mkdtemp(
      join(tmpdir(), 'claude-plugin-e2e-instrumented-validation-')
    );

    try {
      const tester = createClaudePluginTester({
        pluginDir: fakePluginDir,
        artifactsDir,
        cleanup: 'never',
        processRunner: createValidationRunner(calls)
      });

      const result = await tester.validatePlugin({
        target: { kind: 'instrumented' }
      });

      expect(result.target).toEqual({ kind: 'instrumented' });
      expect(result.pluginDir).toContain('instrumented-plugin-workspace');
      expect(result.pluginDir).not.toBe(fakePluginDir);
      expect(calls).toHaveLength(1);
      expect(calls[0].args.at(-3)).toBe('validate');
      expect(calls[0].args.at(-2)).toBe(result.pluginDir);
      expect(calls[0].args.at(-1)).toBe('--strict');
    } finally {
      await rm(artifactsDir, { recursive: true, force: true });
    }
  });
});

type HookConfig = {
  hooks: {
    SessionStart: Array<{
      matcher: string;
      hooks: Array<{ type: string; command: string; timeout: number }>;
    }>;
  };
};

function createBootRunner(): ProcessRunner {
  return async (request: ProcessRunRequest): Promise<ProcessRunResult> => {
    const boot = matchBootRequest(request);
    if (boot) {
      return boot;
    }
    return unexpected(request);
  };
}

function createValidationRunner(calls: ProcessRunRequest[]): ProcessRunner {
  return async (request: ProcessRunRequest): Promise<ProcessRunResult> => {
    calls.push(request);
    if (
      request.args.at(-4) === 'plugin' &&
      request.args.at(-3) === 'validate' &&
      request.args.at(-1) === '--strict'
    ) {
      return ok('valid\n');
    }
    return unexpected(request);
  };
}

function createPromptRunnerThatInvokesHook(): ProcessRunner {
  return async (request: ProcessRunRequest): Promise<ProcessRunResult> => {
    const boot = matchBootRequest(request);
    if (boot) {
      return boot;
    }

    const promptRun = parseHeadlessPromptArgs(request.args);
    if (promptRun) {
      const pluginDir = promptRun.pluginDir;
      if (
        !pluginDir.includes('instrumented-plugin-workspace') ||
        pluginDir === fakePluginDir
      ) {
        return {
          exitCode: 1,
          stdout: '',
          stderr: `Fake Claude expected --plugin-dir to point at instrumented plugin, got ${pluginDir}`
        };
      }
      const command = await readSessionStartHookCommand(pluginDir);
      const hookRun = await runShellCommand({
        command,
        cwd: pluginDir,
        stdin: JSON.stringify({ prompt: promptRun.prompt }),
        env: request.env ?? {}
      });
      if (hookRun.exitCode !== 0) {
        return {
          exitCode: hookRun.exitCode,
          stdout: hookRun.stdout,
          stderr: hookRun.stderr
        };
      }
      return ok(
        `${JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'assistant after hook' }]
          }
        })}\n`
      );
    }

    return unexpected(request);
  };
}

function parseHeadlessPromptArgs(
  args: string[]
): { pluginDir: string; prompt: string } | undefined {
  const pluginDirIndex = args.indexOf('--plugin-dir');
  if (pluginDirIndex < 0 || pluginDirIndex + 1 >= args.length) {
    return undefined;
  }

  const promptIndex = args.indexOf('-p', pluginDirIndex + 2);
  if (
    promptIndex < 0 ||
    args[promptIndex + 1] !== '--output-format' ||
    args[promptIndex + 2] !== 'stream-json' ||
    args[promptIndex + 3] !== '--include-hook-events'
  ) {
    return undefined;
  }

  return {
    pluginDir: args[pluginDirIndex + 1],
    prompt: args.at(-1) ?? ''
  };
}

function matchBootRequest(
  request: ProcessRunRequest
): ProcessRunResult | undefined {
  const subcommand = request.args.slice(-4).join(' ');
  if (request.args.at(-1) === '--version') {
    return ok('2.1.158 (Claude Code)');
  }
  if (subcommand.endsWith('auth status --json')) {
    return ok('{"authenticated":true}');
  }
  if (request.args.at(-1) === '--help') {
    return ok(
      'Usage: claude -p --output-format stream-json --include-hook-events'
    );
  }
  return undefined;
}

async function readSessionStartHookCommand(pluginDir: string): Promise<string> {
  const config = JSON.parse(
    await readFile(join(pluginDir, 'hooks', 'hooks.json'), 'utf8')
  ) as HookConfig;
  return config.hooks.SessionStart[0].hooks[0].command;
}

async function runShellCommand(input: {
  command: string;
  cwd: string;
  stdin: string;
  env: NodeJS.ProcessEnv;
}): Promise<ProcessRunResult> {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-lc', input.command], {
      cwd: input.cwd,
      env: { ...process.env, ...input.env }
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('close', (exitCode) => {
      resolve({ exitCode, stdout, stderr });
    });
    child.stdin.end(input.stdin);
  });
}

function ok(stdout: string): ProcessRunResult {
  return {
    exitCode: 0,
    stdout,
    stderr: ''
  };
}

function unexpected(request: ProcessRunRequest): ProcessRunResult {
  return {
    exitCode: 1,
    stdout: '',
    stderr: `Unexpected fake Claude call: ${request.args.join(' ')}`
  };
}
