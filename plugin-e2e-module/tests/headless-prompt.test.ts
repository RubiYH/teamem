import { describe, expect, it } from 'bun:test';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ClaudeRunError,
  TraceAssertionError,
  createClaudePluginTester,
  type ProcessRunRequest,
  type ProcessRunResult,
  type ProcessRunner
} from '../src/index.js';

const moduleRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const fakePluginDir = join(moduleRoot, 'fixtures', 'fake-plugin');

describe('plugin-e2e-module headless prompt execution', () => {
  it('runs each prompt as an independent structured Claude invocation', async () => {
    const calls: ProcessRunRequest[] = [];
    const artifactsDir = await mkdtemp(
      join(tmpdir(), 'claude-plugin-e2e-headless-')
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

      const first = await tester.prompt('first prompt');
      const second = await tester.prompt('second prompt');

      expect(first.expectText('assistant saw: first prompt')).toBe(first);
      expect(second.expectText(/assistant saw: second/)).toBe(second);

      const promptCalls = calls.filter((call) =>
        call.args.includes('--include-hook-events')
      );
      expect(promptCalls).toHaveLength(2);
      expect(promptCalls.map((call) => call.cwd)).toEqual([cwd, cwd]);
      expect(promptCalls.map((call) => [call.command, call.args])).toEqual([
        [
          '/usr/bin/env',
          [
            'claude',
            '--shim',
            '--plugin-dir',
            first.command.args.at(3) ?? '',
            '-p',
            '--output-format',
            'stream-json',
            '--verbose',
            '--include-hook-events',
            '--permission-mode',
            'auto',
            '--max-turns',
            '3',
            '--',
            'first prompt'
          ]
        ],
        [
          '/usr/bin/env',
          [
            'claude',
            '--shim',
            '--plugin-dir',
            second.command.args.at(3) ?? '',
            '-p',
            '--output-format',
            'stream-json',
            '--verbose',
            '--include-hook-events',
            '--permission-mode',
            'auto',
            '--max-turns',
            '3',
            '--',
            'second prompt'
          ]
        ]
      ]);
      expect(first.command.args.at(2)).toBe('--plugin-dir');
      expect(first.command.args.at(3)).toContain(
        'instrumented-plugin-workspace'
      );
      expect(first.command.args.at(3)).not.toBe(fakePluginDir);
    } finally {
      await rm(artifactsDir, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('passes headless Claude launch options through structured args', async () => {
    const calls: ProcessRunRequest[] = [];
    const artifactsDir = await mkdtemp(
      join(tmpdir(), 'claude-plugin-e2e-headless-options-')
    );

    try {
      const tester = createClaudePluginTester({
        pluginDir: fakePluginDir,
        artifactsDir,
        cleanup: 'never',
        processRunner: createFakeClaudeRunner(calls)
      });

      const result = await tester.prompt('option prompt', {
        permissionMode: 'plan',
        allowedTools: ['Read', 'Bash(git status)'],
        disallowedTools: ['Edit'],
        settingSources: ['user', 'project'],
        systemPrompt: 'system text',
        appendSystemPrompt: 'append text',
        model: 'claude-sonnet-4-6',
        maxBudgetUsd: 1.25,
        useInstrumentedMcpConfig: true,
        strictMcpConfig: true,
        maxTurns: 9
      });

      const promptCall = calls.find((call) =>
        call.args.includes('--include-hook-events')
      );

      expect(result.expectText('assistant saw: option prompt')).toBe(result);
      expect(promptCall?.command).toBe('claude');
      expect(promptCall?.timeoutMs).toBe(120_000);
      expect(
        calls.filter((call) => call.args.at(-1) === '--version')[0]?.timeoutMs
      ).toBe(10_000);
      expect(promptCall?.args).not.toContain('--settings');
      expect(promptCall?.args).not.toContain('--isolation');
      const mcpConfigPath =
        result.command.args[
          result.command.args.findIndex((arg) => arg === '--mcp-config') + 1
        ];
      if (!mcpConfigPath) {
        throw new Error('Expected headless command to include --mcp-config.');
      }
      expect(promptCall?.args).toEqual([
        '--plugin-dir',
        result.command.args.at(1) ?? '',
        '-p',
        '--output-format',
        'stream-json',
        '--verbose',
        '--include-hook-events',
        '--permission-mode',
        'plan',
        '--mcp-config',
        mcpConfigPath,
        '--strict-mcp-config',
        '--setting-sources',
        'user,project',
        '--system-prompt',
        'system text',
        '--append-system-prompt',
        'append text',
        '--model',
        'claude-sonnet-4-6',
        '--max-budget-usd',
        '1.25',
        '--max-turns',
        '9',
        '--allowedTools',
        'Read',
        '--allowedTools',
        'Bash(git status)',
        '--disallowedTools',
        'Edit',
        '--',
        'option prompt'
      ]);
      const mcpConfig = JSON.parse(await readFile(mcpConfigPath, 'utf8')) as {
        mcpServers: Record<string, { env?: Record<string, string> }>;
      };
      expect(
        mcpConfig.mcpServers['generic-fake'].env
          ?.CLAUDE_PLUGIN_E2E_MCP_TRACE_DIR
      ).toBe(result.artifacts.mcpTraceDir);

      const stringSourceResult = await tester.prompt('string source prompt', {
        settingSources: 'local'
      });
      expect(stringSourceResult.command.args).toContain('--setting-sources');
      expect(
        stringSourceResult.command.args[
          stringSourceResult.command.args.indexOf('--setting-sources') + 1
        ]
      ).toBe('local');
    } finally {
      await rm(artifactsDir, { recursive: true, force: true });
    }
  });

  it('supports every documented headless permission mode', async () => {
    const calls: ProcessRunRequest[] = [];
    const artifactsDir = await mkdtemp(
      join(tmpdir(), 'claude-plugin-e2e-permission-modes-')
    );
    const modes = [
      'default',
      'acceptEdits',
      'plan',
      'auto',
      'dontAsk',
      'bypassPermissions'
    ] as const;

    try {
      const tester = createClaudePluginTester({
        pluginDir: fakePluginDir,
        artifactsDir,
        cleanup: 'never',
        processRunner: createFakeClaudeRunner(calls)
      });

      for (const mode of modes) {
        await tester.prompt(`permission ${mode}`, { permissionMode: mode });
      }

      const promptCalls = calls.filter((call) =>
        call.args.includes('--include-hook-events')
      );
      expect(
        promptCalls.map(
          (call) => call.args[call.args.indexOf('--permission-mode') + 1]
        )
      ).toEqual([...modes]);
    } finally {
      await rm(artifactsDir, { recursive: true, force: true });
    }
  });

  it('exercises a namespaced slash command through headless prompt text and MCP evidence', async () => {
    const calls: ProcessRunRequest[] = [];
    const artifactsDir = await mkdtemp(
      join(tmpdir(), 'claude-plugin-e2e-slash-dispatch-')
    );

    try {
      const tester = createClaudePluginTester({
        pluginDir: fakePluginDir,
        artifactsDir,
        cleanup: 'never',
        processRunner: createSlashCommandDispatchRunner(calls)
      });
      const prompt = await tester.slashCommandPrompt('echo', 'issue 07 proof');

      const result = await tester.prompt(prompt);

      expect(prompt).toBe('/generic-fake-plugin:echo issue 07 proof');
      expect(result.prompt).toBe(prompt);
      expect(result.command.args.at(-1)).toBe(prompt);
      expect(result.expectText('slash command observed')).toBe(result);
      expect(result.expectMcpMethod('tools/call').method).toBe('tools/call');
      expect(result.findMcpMessages('tools/call')[0].json).toMatchObject({
        method: 'tools/call',
        params: {
          prompt
        }
      });
      expect(
        calls
          .filter((call) => call.args.includes('--include-hook-events'))
          .map((call) => call.args.at(-1))
      ).toEqual([prompt]);
    } finally {
      await rm(artifactsDir, { recursive: true, force: true });
    }
  });

  it('writes raw debug artifacts, parsed event access, and redacted safe artifacts', async () => {
    const artifactsDir = await mkdtemp(
      join(tmpdir(), 'claude-plugin-e2e-artifacts-')
    );

    try {
      const tester = createClaudePluginTester({
        pluginDir: fakePluginDir,
        artifactsDir,
        cleanup: 'never',
        processRunner: createFakeClaudeRunner([], {
          promptStdout: [
            JSON.stringify({ type: 'system', subtype: 'start' }),
            JSON.stringify({
              type: 'assistant',
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'artifact proof' }]
              }
            }),
            'not-json',
            ''
          ].join('\n'),
          promptStderr: 'stderr proof'
        })
      });

      const result = await tester.prompt('artifact prompt');
      const summary = JSON.parse(
        await readFile(result.artifacts.summaryPath, 'utf8')
      ) as {
        command: { args: string[]; promptArgIndex: number };
        exitStatus: { exitCode: number };
        result: {
          eventCount: number;
          parseErrorCount: number;
          assistantTextPreview: string;
        };
      };
      const events = JSON.parse(
        await readFile(result.artifacts.streamEventsPath, 'utf8')
      ) as unknown[];
      const parseErrors = JSON.parse(
        await readFile(result.artifacts.streamParseErrorsPath, 'utf8')
      ) as Array<{ text: string }>;

      expect(await readFile(result.artifacts.rawStdoutPath, 'utf8')).toBe(
        '[REDACTED]'
      );
      expect(await readFile(result.artifacts.rawStderrPath, 'utf8')).toBe(
        '[REDACTED]'
      );
      expect(events).toHaveLength(2);
      expect(parseErrors).toHaveLength(1);
      expect(JSON.stringify(events)).not.toContain('artifact proof');
      expect(parseErrors[0].text).toBe('[REDACTED]');
      expect(result.eventsByType('assistant')).toHaveLength(1);
      expect(result.assistantText()).toContain('artifact proof');
      expect(await readFile(result.artifacts.debugLogPath, 'utf8')).toBe(
        '[REDACTED]'
      );
      expect(summary.command.args.at(-1)).toBe('[PROMPT_REDACTED]');
      expect(summary.command.promptArgIndex).toBe(
        summary.command.args.length - 1
      );
      expect(summary.exitStatus.exitCode).toBe(0);
      expect(summary.result).toMatchObject({
        eventCount: 2,
        parseErrorCount: 1,
        assistantTextPreview: '[REDACTED]'
      });
    } finally {
      await rm(artifactsDir, { recursive: true, force: true });
    }
  });

  it('preserves parsed stream event values when unredacted artifacts are explicitly allowed', async () => {
    const previousAllowUnredacted =
      process.env.CLAUDE_PLUGIN_E2E_ALLOW_UNREDACTED;
    process.env.CLAUDE_PLUGIN_E2E_ALLOW_UNREDACTED = '1';
    const artifactsDir = await mkdtemp(
      join(tmpdir(), 'claude-plugin-e2e-headless-unredacted-')
    );
    const secret = 'allowed-stream-secret';

    try {
      const tester = createClaudePluginTester({
        pluginDir: fakePluginDir,
        artifactsDir,
        cleanup: 'never',
        redaction: { mode: 'off' },
        processRunner: createFakeClaudeRunner([], {
          promptStdout: `${JSON.stringify({
            type: 'assistant',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: secret }]
            }
          })}\n`
        })
      });

      const result = await tester.prompt('unredacted prompt');

      expect(
        await readFile(result.artifacts.streamEventsPath, 'utf8')
      ).toContain(secret);
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

  it('redacts raw headless process artifacts that contain arbitrary secrets in safe mode', async () => {
    const artifactsDir = await mkdtemp(
      join(tmpdir(), 'claude-plugin-e2e-headless-safe-output-')
    );
    const stdoutSecret = 'headless-stdout-secret-must-not-leak';
    const stderrSecret = 'headless-stderr-secret-must-not-leak';

    try {
      const tester = createClaudePluginTester({
        pluginDir: fakePluginDir,
        artifactsDir,
        cleanup: 'never',
        processRunner: createFakeClaudeRunner([], {
          promptStdout: `${JSON.stringify({
            type: 'assistant',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: stdoutSecret }]
            }
          })}\n`,
          promptStderr: `debug log includes ${stderrSecret}`
        })
      });

      const result = await tester.prompt('safe output prompt');

      expect(result.stdout).toContain(stdoutSecret);
      expect(result.stderr).toContain(stderrSecret);
      expect(
        await readFile(result.artifacts.rawStdoutPath, 'utf8')
      ).not.toContain(stdoutSecret);
      expect(
        await readFile(result.artifacts.rawStderrPath, 'utf8')
      ).not.toContain(stderrSecret);
      expect(
        await readFile(result.artifacts.debugLogPath, 'utf8')
      ).not.toContain(stderrSecret);
      expect(await readFile(result.artifacts.rawStdoutPath, 'utf8')).toBe(
        '[REDACTED]'
      );
      expect(await readFile(result.artifacts.rawStderrPath, 'utf8')).toBe(
        '[REDACTED]'
      );
      expect(await readFile(result.artifacts.debugLogPath, 'utf8')).toBe(
        '[REDACTED]'
      );
    } finally {
      await rm(artifactsDir, { recursive: true, force: true });
    }
  });

  it('does not synthesize CLAUDE_PLUGIN_DATA in the headless Claude env', async () => {
    const calls: ProcessRunRequest[] = [];
    const artifactsDir = await mkdtemp(
      join(tmpdir(), 'claude-plugin-e2e-headless-env-')
    );

    try {
      const tester = createClaudePluginTester({
        pluginDir: fakePluginDir,
        artifactsDir,
        cleanup: 'never',
        env: {
          PATH: process.env.PATH
        },
        processRunner: createFakeClaudeRunner(calls)
      });

      await tester.prompt('env prompt');
      const promptCall = calls.find((call) =>
        call.args.includes('--include-hook-events')
      );

      expect(promptCall?.env).not.toHaveProperty('CLAUDE_PLUGIN_DATA');
    } finally {
      await rm(artifactsDir, { recursive: true, force: true });
    }
  });

  it('throws TraceAssertionError with artifact paths when text is missing', async () => {
    const artifactsDir = await mkdtemp(
      join(tmpdir(), 'claude-plugin-e2e-assert-')
    );

    try {
      const tester = createClaudePluginTester({
        pluginDir: fakePluginDir,
        artifactsDir,
        cleanup: 'never',
        processRunner: createFakeClaudeRunner([], {
          promptStdout: `${JSON.stringify({
            type: 'assistant',
            message: { role: 'assistant', content: [{ text: 'actual text' }] }
          })}\n`
        })
      });

      const result = await tester.prompt('assert prompt');

      expect(() => result.expectText('missing text')).toThrow(
        TraceAssertionError
      );

      try {
        result.expectText('missing text');
      } catch (error) {
        expect(error).toBeInstanceOf(TraceAssertionError);
        expect((error as Error).message).toContain('[REDACTED_EXPECTATION]');
        expect((error as Error).message).not.toContain('missing text');
        expect((error as TraceAssertionError).artifactsDir).toBe(
          result.artifacts.dir
        );
        expect((error as TraceAssertionError).artifactPaths).toContain(
          result.artifacts.rawStdoutPath
        );
      }
    } finally {
      await rm(artifactsDir, { recursive: true, force: true });
    }
  });

  it('does not satisfy expectText from non-assistant stdout events', async () => {
    const artifactsDir = await mkdtemp(
      join(tmpdir(), 'claude-plugin-e2e-non-assistant-')
    );

    try {
      const tester = createClaudePluginTester({
        pluginDir: fakePluginDir,
        artifactsDir,
        cleanup: 'never',
        processRunner: createFakeClaudeRunner([], {
          promptStdout: `${JSON.stringify({
            type: 'system',
            message: {
              content: [{ type: 'text', text: 'non-assistant match' }]
            }
          })}\n`
        })
      });

      const result = await tester.prompt('non-assistant prompt');
      const summary = JSON.parse(
        await readFile(result.artifacts.summaryPath, 'utf8')
      ) as { result: { assistantTextPreview: string } };

      expect(result.stdout).toContain('non-assistant match');
      expect(result.assistantText()).toBe('');
      expect(summary.result.assistantTextPreview).toBe('');
      expect(() => result.expectText('non-assistant match')).toThrow(
        TraceAssertionError
      );
    } finally {
      await rm(artifactsDir, { recursive: true, force: true });
    }
  });

  it('preserves run artifacts before throwing typed Claude run failures', async () => {
    const artifactsDir = await mkdtemp(
      join(tmpdir(), 'claude-plugin-e2e-run-fail-')
    );

    try {
      const tester = createClaudePluginTester({
        pluginDir: fakePluginDir,
        artifactsDir,
        cleanup: 'never',
        processRunner: createFakeClaudeRunner([], {
          promptExitCode: 7,
          promptStdout: 'partial stdout',
          promptStderr: 'partial stderr'
        })
      });

      await expect(tester.prompt('fail prompt')).rejects.toThrow(
        ClaudeRunError
      );
      const runDirs = (await readdir(artifactsDir)).filter((entry) =>
        entry.includes('-prompt-')
      );

      expect(runDirs).toHaveLength(1);
      const summary = JSON.parse(
        await readFile(
          join(artifactsDir, runDirs[0], 'run-summary.json'),
          'utf8'
        )
      ) as { exitStatus: { exitCode: number } };
      expect(summary.exitStatus.exitCode).toBe(7);
    } finally {
      await rm(artifactsDir, { recursive: true, force: true });
    }
  });

  it('preserves failed run artifacts when cleanup is on-success', async () => {
    const artifactsDir = await mkdtemp(
      join(tmpdir(), 'claude-plugin-e2e-on-success-fail-')
    );

    try {
      const tester = createClaudePluginTester({
        pluginDir: fakePluginDir,
        artifactsDir,
        cleanup: 'on-success',
        processRunner: createFakeClaudeRunner([], {
          promptExitCode: 7,
          promptStdout: 'partial stdout',
          promptStderr: 'partial stderr'
        })
      });

      await expect(tester.prompt('fail prompt')).rejects.toThrow(
        ClaudeRunError
      );
      const runDirs = (await readdir(artifactsDir)).filter((entry) =>
        entry.includes('-prompt-')
      );

      expect(runDirs).toHaveLength(1);
      await expect(
        stat(join(artifactsDir, runDirs[0], 'run-summary.json'))
      ).resolves.toBeTruthy();
    } finally {
      await rm(artifactsDir, { recursive: true, force: true });
    }
  });

  it('cleans instrumented plugin workspaces after successful runs when cleanup is on-success', async () => {
    const artifactsDir = await mkdtemp(
      join(tmpdir(), 'claude-plugin-e2e-clean-success-')
    );

    try {
      const tester = createClaudePluginTester({
        pluginDir: fakePluginDir,
        artifactsDir,
        cleanup: 'on-success',
        processRunner: createFakeClaudeRunner([])
      });
      const boot = await tester.boot();

      await expect(
        stat(boot.instrumentedPlugin.pluginDir)
      ).resolves.toBeTruthy();
      await tester.prompt('cleanup prompt');

      await expect(stat(boot.instrumentedPlugin.pluginDir)).rejects.toThrow();
      await expect(
        stat(boot.instrumentedPlugin.workspaceDir)
      ).rejects.toThrow();
    } finally {
      await rm(artifactsDir, { recursive: true, force: true });
    }
  });

  it('preserves instrumented plugin workspaces after failed runs when cleanup is on-success', async () => {
    const artifactsDir = await mkdtemp(
      join(tmpdir(), 'claude-plugin-e2e-clean-failure-')
    );

    try {
      const tester = createClaudePluginTester({
        pluginDir: fakePluginDir,
        artifactsDir,
        cleanup: 'on-success',
        processRunner: createFakeClaudeRunner([], {
          promptExitCode: 7,
          promptStdout: 'partial stdout',
          promptStderr: 'partial stderr'
        })
      });
      const boot = await tester.boot();

      await expect(tester.prompt('fail prompt')).rejects.toThrow(
        ClaudeRunError
      );
      await expect(
        stat(boot.instrumentedPlugin.pluginDir)
      ).resolves.toBeTruthy();
    } finally {
      await rm(artifactsDir, { recursive: true, force: true });
    }
  });
});

function createSlashCommandDispatchRunner(
  calls: ProcessRunRequest[]
): ProcessRunner {
  return async (request: ProcessRunRequest): Promise<ProcessRunResult> => {
    calls.push(request);
    const boot = matchBootRequest(request);
    if (boot) {
      return boot;
    }

    const promptRun = parseHeadlessPromptArgs(request.args);
    if (promptRun) {
      const expectedPrompt = '/generic-fake-plugin:echo issue 07 proof';
      if (promptRun.prompt !== expectedPrompt) {
        return {
          exitCode: 1,
          stdout: '',
          stderr: `Expected slash command prompt text ${expectedPrompt}, got ${promptRun.prompt}`
        };
      }

      await writeFakeMcpTrace({
        traceDir: request.env?.CLAUDE_PLUGIN_E2E_MCP_TRACE_DIR ?? '',
        prompt: promptRun.prompt
      });

      return ok(
        `${JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: `slash command observed: ${promptRun.prompt}`
              }
            ]
          }
        })}\n`
      );
    }

    return unexpected(request);
  };
}

function matchBootRequest(
  request: ProcessRunRequest
): ProcessRunResult | undefined {
  const args = request.args;
  const subcommand = args.slice(-4).join(' ');

  if (args.at(-1) === '--version') {
    return ok('2.1.158 (Claude Code)');
  }

  if (subcommand.endsWith('auth status --json')) {
    return ok('{"authenticated":true}');
  }

  if (args.at(-1) === '--help') {
    return ok(
      'Usage: claude --plugin-dir ./plugin -p --output-format stream-json --verbose --include-hook-events --permission-mode auto'
    );
  }

  return undefined;
}

async function writeFakeMcpTrace(input: {
  traceDir: string;
  prompt: string;
}): Promise<void> {
  const invocationDir = join(input.traceDir, 'slash-command-echo');
  const startedAt = new Date().toISOString();
  const message = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'echo',
      prompt: input.prompt
    }
  };

  await mkdir(invocationDir, { recursive: true });
  await Promise.all([
    writeFile(join(invocationDir, 'stdin.raw'), `${JSON.stringify(message)}\n`),
    writeFile(join(invocationDir, 'stdout.raw'), ''),
    writeFile(join(invocationDir, 'stderr.raw'), ''),
    writeFile(
      join(invocationDir, 'trace.json'),
      `${JSON.stringify(
        {
          serverName: 'generic-fake',
          command: 'fake-claude-mcp-dispatch',
          args: [],
          startedAt,
          endedAt: startedAt,
          durationMs: 0,
          exitCode: 0,
          signal: null,
          partial: false,
          terminationReason: 'fake-claude-dispatch',
          stdin: `${JSON.stringify(message)}\n`,
          stdout: '',
          stderr: '',
          messages: [
            {
              serverName: 'generic-fake',
              direction: 'client-to-server',
              raw: JSON.stringify(message),
              json: message,
              method: 'tools/call',
              timestamp: startedAt,
              offsetMs: 0
            }
          ]
        },
        null,
        2
      )}\n`
    )
  ]);
}

function createFakeClaudeRunner(
  calls: ProcessRunRequest[],
  overrides: {
    promptExitCode?: number;
    promptStdout?: string;
    promptStderr?: string;
  } = {}
): ProcessRunner {
  return async (request: ProcessRunRequest): Promise<ProcessRunResult> => {
    calls.push(request);
    const boot = matchBootRequest(request);
    if (boot) {
      return boot;
    }

    const promptRun = parseHeadlessPromptArgs(request.args);
    if (promptRun) {
      if (
        !promptRun.pluginDir.includes('instrumented-plugin-workspace') ||
        promptRun.pluginDir === fakePluginDir
      ) {
        return {
          exitCode: 1,
          stdout: '',
          stderr: `Fake Claude expected --plugin-dir to point at instrumented plugin, got ${promptRun.pluginDir}`
        };
      }
      return {
        exitCode: overrides.promptExitCode ?? 0,
        stdout:
          overrides.promptStdout ??
          `${JSON.stringify({
            type: 'assistant',
            message: {
              role: 'assistant',
              content: [{ text: `assistant saw: ${promptRun.prompt}` }]
            }
          })}\n`,
        stderr: overrides.promptStderr ?? ''
      };
    }

    return {
      exitCode: 1,
      stdout: '',
      stderr: `Unexpected fake Claude call: ${request.args.join(' ')}`
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

function unexpected(request: ProcessRunRequest): ProcessRunResult {
  return {
    exitCode: 1,
    stdout: '',
    stderr: `Unexpected fake Claude call: ${request.args.join(' ')}`
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
    args[promptIndex + 3] !== '--verbose' ||
    args[promptIndex + 4] !== '--include-hook-events'
  ) {
    return undefined;
  }

  return {
    pluginDir: args[pluginDirIndex + 1],
    prompt: args.at(-1) ?? ''
  };
}
