import { describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import {
  cp,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TraceAssertionError,
  createClaudePluginTester,
  expectMcpMethod,
  findMcpMessages,
  readMcpTraces,
  type ProcessRunRequest,
  type ProcessRunResult,
  type ProcessRunner
} from '../src/index.js';

const moduleRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const fakePluginDir = join(moduleRoot, 'fixtures', 'fake-plugin');

describe('plugin-e2e-module MCP instrumentation', () => {
  it('rewrites copied .mcp.json to the stdio proxy without mutating source', async () => {
    const artifactsDir = await mkdtemp(
      join(tmpdir(), 'claude-plugin-e2e-mcp-rewrite-')
    );

    try {
      const tester = createClaudePluginTester({
        pluginDir: fakePluginDir,
        artifactsDir,
        cleanup: 'never',
        processRunner: createBootRunner()
      });

      const boot = await tester.boot();
      const sourceConfig = JSON.parse(
        await readFile(join(fakePluginDir, '.mcp.json'), 'utf8')
      ) as McpConfig;
      const copiedConfig = JSON.parse(
        await readFile(
          join(boot.instrumentedPlugin.pluginDir, '.mcp.json'),
          'utf8'
        )
      ) as McpConfig;
      const copiedServer = copiedConfig.mcpServers['generic-fake'];

      expect(copiedServer.command).toBe(process.execPath);
      expect(copiedServer.args[0]).toContain('mcp-proxy-runner.cjs');
      expect(copiedServer.args).toContain('--server-name');
      expect(copiedServer.args).toContain('generic-fake');
      expect(copiedServer.args).not.toEqual(
        sourceConfig.mcpServers['generic-fake'].args
      );
      expect(await readMcpConfig(fakePluginDir)).toEqual(sourceConfig);
    } finally {
      await rm(artifactsDir, { recursive: true, force: true });
    }
  });

  it('uses structured spawn and only expands ${VAR} placeholders', async () => {
    const artifactsDir = await mkdtemp(
      join(tmpdir(), 'claude-plugin-e2e-mcp-placeholder-')
    );
    const sourceDir = await copyFakePlugin();

    try {
      await writeMcpConfig(sourceDir, {
        mcpServers: {
          placeholder: {
            command: '${NODE_BIN}',
            args: ['${ECHO_SCRIPT}', '$UNSUPPORTED', '*.js']
          }
        }
      });
      const tester = createClaudePluginTester({
        pluginDir: sourceDir,
        artifactsDir,
        cleanup: 'never',
        processRunner: createBootRunner(),
        env: {
          ...process.env,
          NODE_BIN: process.execPath,
          ECHO_SCRIPT: join(sourceDir, 'scripts', 'mcp-echo.js')
        }
      });

      const boot = await tester.boot();
      const traceDir = join(artifactsDir, 'manual-mcp-placeholder-traces');
      const run = await runConfiguredMcpServer({
        pluginDir: boot.instrumentedPlugin.pluginDir,
        serverName: 'placeholder',
        traceDir,
        stdin: `${JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize'
        })}\n`,
        env: {
          NODE_BIN: process.execPath,
          ECHO_SCRIPT: join(sourceDir, 'scripts', 'mcp-echo.js')
        }
      });

      expect(run.exitCode).toBe(0);
      const trace = expectMcpMethod(
        await readMcpTraces(traceDir),
        'initialize'
      );
      const fullTrace = (await readMcpTraces(traceDir))[0];
      expect(fullTrace.command).toBe('[REDACTED]');
      expect(fullTrace.args).toEqual(['[REDACTED]', '[REDACTED]', '[REDACTED]']);
      expect(fullTrace.placeholderExpansion).toEqual({
        supportedPattern: '${VAR}',
        unsupportedShellExpansion: true
      });
      expect(trace.direction).toBe('client-to-server');
    } finally {
      await rm(artifactsDir, { recursive: true, force: true });
      await rm(sourceDir, { recursive: true, force: true });
    }
  });

  it('uses literal secret MCP args for child spawn but redacts persisted safe trace command metadata', async () => {
    const artifactsDir = await mkdtemp(
      join(tmpdir(), 'claude-plugin-e2e-mcp-literal-secret-')
    );
    const sourceDir = await copyFakePlugin();
    const literalSecret = 'literal-mcp-arg-secret-must-not-leak';
    const checkerScript = join(
      sourceDir,
      'scripts',
      'mcp-literal-secret-check.js'
    );

    try {
      await writeFile(
        checkerScript,
        [
          `if (process.argv[2] !== ${JSON.stringify(literalSecret)}) {`,
          "  process.stderr.write('missing literal secret argument');",
          '  process.exit(42);',
          '}',
          'process.stdin.resume();',
          "process.stdin.on('data', (chunk) => process.stdout.write(chunk));",
          "process.stdin.on('end', () => process.exit(0));"
        ].join('\n'),
        'utf8'
      );
      await writeMcpConfig(sourceDir, {
        mcpServers: {
          literalSecret: {
            command: process.execPath,
            args: [checkerScript, literalSecret]
          }
        }
      });
      const tester = createClaudePluginTester({
        pluginDir: sourceDir,
        artifactsDir,
        cleanup: 'never',
        processRunner: createBootRunner()
      });

      const boot = await tester.boot();
      const traceDir = join(artifactsDir, 'manual-mcp-literal-secret-traces');
      const run = await runConfiguredMcpServer({
        pluginDir: boot.instrumentedPlugin.pluginDir,
        serverName: 'literalSecret',
        traceDir,
        stdin: `${JSON.stringify({
          jsonrpc: '2.0',
          id: 11,
          method: 'initialize'
        })}\n`
      });

      expect(run.exitCode).toBe(0);
      const trace = (await readMcpTraces(traceDir))[0];
      expect(trace.command).toBe('[REDACTED]');
      expect(trace.args).toEqual(['[REDACTED]', '[REDACTED]']);
      expect(await readTraceArtifactText(traceDir)).not.toContain(literalSecret);
    } finally {
      await rm(artifactsDir, { recursive: true, force: true });
      await rm(sourceDir, { recursive: true, force: true });
    }
  });

  it('expands secret placeholders only for child spawn and keeps MCP artifacts safe by default', async () => {
    const artifactsDir = await mkdtemp(
      join(tmpdir(), 'claude-plugin-e2e-mcp-secret-')
    );
    const sourceDir = await copyFakePlugin();
    const secretToken = 'secret-token-must-not-leak';
    const checkerScript = join(sourceDir, 'scripts', 'mcp-secret-check.js');

    try {
      await writeFile(
        checkerScript,
        [
          'if (process.argv[2] !== process.env.SECRET_TOKEN) {',
          "  process.stderr.write('missing expanded secret argument');",
          '  process.exit(42);',
          '}',
          'process.stdin.resume();',
          "process.stdin.on('data', (chunk) => process.stdout.write(chunk));",
          "process.stdin.on('end', () => process.exit(0));"
        ].join('\n'),
        'utf8'
      );
      await writeMcpConfig(sourceDir, {
        mcpServers: {
          secret: {
            command: '${NODE_BIN}',
            args: [checkerScript, '${SECRET_TOKEN}']
          }
        }
      });
      const tester = createClaudePluginTester({
        pluginDir: sourceDir,
        artifactsDir,
        cleanup: 'never',
        processRunner: createBootRunner(),
        env: {
          ...process.env,
          NODE_BIN: process.execPath,
          SECRET_TOKEN: secretToken
        }
      });

      const boot = await tester.boot();
      const traceDir = join(artifactsDir, 'manual-mcp-secret-traces');
      const run = await runConfiguredMcpServer({
        pluginDir: boot.instrumentedPlugin.pluginDir,
        serverName: 'secret',
        traceDir,
        stdin: `${JSON.stringify({
          jsonrpc: '2.0',
          id: 7,
          method: 'initialize'
        })}\n`,
        env: {
          NODE_BIN: process.execPath,
          SECRET_TOKEN: secretToken
        }
      });

      expect(run.exitCode).toBe(0);
      const trace = (await readMcpTraces(traceDir))[0];
      expect(trace.command).toBe('[REDACTED]');
      expect(trace.args).toEqual(['[REDACTED]', '[REDACTED]']);
      expect(await readTraceArtifactText(traceDir)).not.toContain(secretToken);
    } finally {
      await rm(artifactsDir, { recursive: true, force: true });
      await rm(sourceDir, { recursive: true, force: true });
    }
  });

  it('proxies all MCP servers by default and supports include/exclude filters', async () => {
    const artifactsDir = await mkdtemp(
      join(tmpdir(), 'claude-plugin-e2e-mcp-filter-')
    );
    const sourceDir = await copyFakePlugin();

    try {
      await writeTwoServerConfig(sourceDir);

      const allTester = createClaudePluginTester({
        pluginDir: sourceDir,
        artifactsDir,
        cleanup: 'never',
        processRunner: createBootRunner()
      });
      const allBoot = await allTester.boot();
      expect(
        proxyServerNames(
          await readMcpConfig(allBoot.instrumentedPlugin.pluginDir)
        )
      ).toEqual(['alpha', 'beta']);

      const includeTester = createClaudePluginTester({
        pluginDir: sourceDir,
        artifactsDir,
        cleanup: 'never',
        mcp: { include: ['beta'] },
        processRunner: createBootRunner()
      });
      const includeBoot = await includeTester.boot();
      const includeConfig = await readMcpConfig(
        includeBoot.instrumentedPlugin.pluginDir
      );
      expect(serverNames(includeConfig)).toEqual(['alpha', 'beta']);
      expect(proxyServerNames(includeConfig)).toEqual(['beta']);
      expect(includeConfig.mcpServers.alpha.command).toBe('node');

      const excludeTester = createClaudePluginTester({
        pluginDir: sourceDir,
        artifactsDir,
        cleanup: 'never',
        mcp: { exclude: ['alpha'] },
        processRunner: createBootRunner()
      });
      const excludeBoot = await excludeTester.boot();
      const excludeConfig = await readMcpConfig(
        excludeBoot.instrumentedPlugin.pluginDir
      );
      expect(serverNames(excludeConfig)).toEqual(['alpha', 'beta']);
      expect(proxyServerNames(excludeConfig)).toEqual(['beta']);
      expect(excludeConfig.mcpServers.alpha.command).toBe('node');
    } finally {
      await rm(artifactsDir, { recursive: true, force: true });
      await rm(sourceDir, { recursive: true, force: true });
    }
  });

  it('removes non-included MCP servers when disable-non-included mode is enabled', async () => {
    const artifactsDir = await mkdtemp(
      join(tmpdir(), 'claude-plugin-e2e-mcp-disable-')
    );
    const sourceDir = await copyFakePlugin();

    try {
      await writeTwoServerConfig(sourceDir);

      const includeTester = createClaudePluginTester({
        pluginDir: sourceDir,
        artifactsDir,
        cleanup: 'never',
        mcp: { include: ['beta'], mode: 'disable-non-included' },
        processRunner: createBootRunner()
      });
      const includeBoot = await includeTester.boot();
      const includeConfig = await readMcpConfig(
        includeBoot.instrumentedPlugin.pluginDir
      );
      expect(serverNames(includeConfig)).toEqual(['beta']);
      expect(proxyServerNames(includeConfig)).toEqual(['beta']);

      const excludeTester = createClaudePluginTester({
        pluginDir: sourceDir,
        artifactsDir,
        cleanup: 'never',
        mcp: { exclude: ['alpha'], mode: 'disable-non-included' },
        processRunner: createBootRunner()
      });
      const excludeBoot = await excludeTester.boot();
      const excludeConfig = await readMcpConfig(
        excludeBoot.instrumentedPlugin.pluginDir
      );
      expect(serverNames(excludeConfig)).toEqual(['beta']);
      expect(proxyServerNames(excludeConfig)).toEqual(['beta']);
    } finally {
      await rm(artifactsDir, { recursive: true, force: true });
      await rm(sourceDir, { recursive: true, force: true });
    }
  });

  it('creates safe MCP proxy artifacts with redacted payloads and curated env by default', async () => {
    const artifactsDir = await mkdtemp(
      join(tmpdir(), 'claude-plugin-e2e-mcp-artifacts-')
    );
    const secret = 'mcp-secret-must-not-leak';

    try {
      const tester = createClaudePluginTester({
        pluginDir: fakePluginDir,
        artifactsDir,
        cleanup: 'never',
        processRunner: createBootRunner()
      });
      const boot = await tester.boot();
      const traceDir = join(artifactsDir, 'manual-mcp-artifact-traces');
      const request = `${JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: { token: secret }
      })}\n`;

      const run = await runConfiguredMcpServer({
        pluginDir: boot.instrumentedPlugin.pluginDir,
        serverName: 'generic-fake',
        traceDir,
        stdin: request,
        env: {
          MCP_ECHO_STDERR: 'mcp stderr proof\n',
          CLAUDE_PLUGIN_ROOT: '/secret/root',
          CLAUDE_PROJECT_DIR: '/secret/project',
          SHOULD_NOT_BE_CAPTURED: 'arbitrary-secret'
        }
      });

      expect(run.exitCode).toBe(0);
      const traces = await readMcpTraces(traceDir);
      const trace = traces[0];
      expect(trace.serverName).toBe('generic-fake');
      expect(trace.exitCode).toBe(0);
      expect(trace.signal).toBeNull();
      expect(trace.stdin).toBe('[REDACTED]');
      expect(trace.stdout).toBe('[REDACTED]');
      expect(trace.stderr).toBe('[REDACTED]');
      expect(trace.partial).toBe(false);
      expect(trace.terminationReason).toBe('child-close');
      expect(trace.durationMs).toBeGreaterThanOrEqual(0);
      expect(findMcpMessages(traces, 'tools/list')).toHaveLength(2);
      const message = expectMcpMethod(traces, 'tools/list');
      expect(message.method).toBe('tools/list');
      expect(message.raw).toBe('[REDACTED]');
      expect(message.json).toEqual({
        jsonrpc: '[REDACTED]',
        id: 2,
        method: '[REDACTED]',
        params: { token: '[REDACTED]' }
      });
      expect(trace.environment).toEqual({
        redactionMode: 'safe',
        env: {
          CLAUDE_PLUGIN_ROOT: '[REDACTED]',
          CLAUDE_PROJECT_DIR: '[REDACTED]'
        }
      });
      expect(trace.environment?.env).not.toHaveProperty(
        'SHOULD_NOT_BE_CAPTURED'
      );
      expect(await readTraceArtifactText(traceDir)).not.toContain(secret);
      expect(await readTraceArtifactText(traceDir)).not.toContain(
        'arbitrary-secret'
      );
      await expect(stat(trace.artifacts.tracePath)).resolves.toBeTruthy();
      await expect(stat(trace.artifacts.stdinPath)).resolves.toBeTruthy();
      await expect(stat(trace.artifacts.stdoutPath)).resolves.toBeTruthy();
      await expect(stat(trace.artifacts.stderrPath)).resolves.toBeTruthy();
    } finally {
      await rm(artifactsDir, { recursive: true, force: true });
    }
  });

  it('flushes partial MCP artifacts when the proxy is terminated before child close', async () => {
    const artifactsDir = await mkdtemp(
      join(tmpdir(), 'claude-plugin-e2e-mcp-partial-')
    );
    const sourceDir = await copyFakePlugin();
    const hangingScript = join(sourceDir, 'scripts', 'mcp-hanging-echo.js');

    try {
      await writeFile(
        hangingScript,
        [
          'process.stdin.resume();',
          "process.stdin.on('data', (chunk) => process.stdout.write(chunk));",
          'setInterval(() => {}, 1000);'
        ].join('\n'),
        'utf8'
      );
      await writeMcpConfig(sourceDir, {
        mcpServers: {
          partial: {
            command: process.execPath,
            args: [hangingScript]
          }
        }
      });
      const tester = createClaudePluginTester({
        pluginDir: sourceDir,
        artifactsDir,
        cleanup: 'never',
        processRunner: createBootRunner()
      });

      const boot = await tester.boot();
      const traceDir = join(artifactsDir, 'manual-mcp-partial-traces');
      const request = `${JSON.stringify({
        jsonrpc: '2.0',
        id: 8,
        method: 'initialize'
      })}\n`;
      const run = await runConfiguredMcpServerAndTerminate({
        pluginDir: boot.instrumentedPlugin.pluginDir,
        serverName: 'partial',
        traceDir,
        stdin: request,
        signal: 'SIGTERM'
      });

      expect(run.exitCode).not.toBe(0);
      const trace = (await readMcpTraces(traceDir))[0];
      expect(trace.partial).toBe(true);
      expect(trace.terminationReason).toBe('process-signal:SIGTERM');
      expect(trace.stdin).toBe('[REDACTED]');
      expect(
        trace.messages.some((message) => message.method === 'initialize')
      ).toBe(true);
      await expect(stat(trace.artifacts.tracePath)).resolves.toBeTruthy();
      await expect(stat(trace.artifacts.stdinPath)).resolves.toBeTruthy();
      await expect(stat(trace.artifacts.stdoutPath)).resolves.toBeTruthy();
      await expect(stat(trace.artifacts.stderrPath)).resolves.toBeTruthy();
    } finally {
      await rm(artifactsDir, { recursive: true, force: true });
      await rm(sourceDir, { recursive: true, force: true });
    }
  });

  it('surfaces MCP traces on prompt results and assertion helpers', async () => {
    const artifactsDir = await mkdtemp(
      join(tmpdir(), 'claude-plugin-e2e-mcp-prompt-')
    );

    try {
      const tester = createClaudePluginTester({
        pluginDir: fakePluginDir,
        artifactsDir,
        cleanup: 'never',
        processRunner: createPromptRunnerThatInvokesMcp()
      });

      const result = await tester.prompt('trigger mcp');
      const message = result.expectMcpMethod('initialize');

      expect(result.findMcpMessages('initialize')).toHaveLength(2);
      expect(findMcpMessages(result, /initial/)).toHaveLength(2);
      expect(message.serverName).toBe('generic-fake');
      expect(result.expectText('assistant after mcp')).toBe(result);

      expect(() => result.expectMcpMethod('tools/call')).toThrow(
        TraceAssertionError
      );
      try {
        result.expectMcpMethod('tools/call');
      } catch (error) {
        expect(error).toBeInstanceOf(TraceAssertionError);
        expect((error as TraceAssertionError).artifactsDir).toBe(
          result.artifacts.dir
        );
        expect((error as TraceAssertionError).artifactPaths).toContain(
          result.mcpTraces[0].artifacts.tracePath
        );
      }
    } finally {
      await rm(artifactsDir, { recursive: true, force: true });
    }
  });

  it('preserves MCP proxy payloads when redaction off is explicitly gated', async () => {
    const previousAllowUnredacted =
      process.env.CLAUDE_PLUGIN_E2E_ALLOW_UNREDACTED;
    process.env.CLAUDE_PLUGIN_E2E_ALLOW_UNREDACTED = '1';
    const artifactsDir = await mkdtemp(
      join(tmpdir(), 'claude-plugin-e2e-mcp-unredacted-')
    );
    const secret = 'mcp-secret-allowed';

    try {
      const tester = createClaudePluginTester({
        pluginDir: fakePluginDir,
        artifactsDir,
        cleanup: 'never',
        redaction: { mode: 'off' },
        env: { CLAUDE_PROJECT_DIR: '/visible/project' },
        processRunner: createPromptRunnerThatInvokesMcp()
      });

      const result = await tester.prompt(secret);
      const trace = result.mcpTraces[0];
      const message = result.expectMcpMethod('initialize');

      expect(trace.stdin).toContain(secret);
      expect(trace.stdout).toContain(secret);
      expect(trace.command).not.toBe('[REDACTED]');
      expect(trace.args).not.toEqual(['[REDACTED]']);
      expect(message.raw).toContain(secret);
      expect(message.json).toEqual({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { prompt: secret }
      });
      expect(trace.environment).toEqual({
        redactionMode: 'off',
        env: { CLAUDE_PROJECT_DIR: '/visible/project' }
      });
      expect(await readFile(trace.artifacts.stdinPath, 'utf8')).toContain(
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
});

type McpConfig = {
  mcpServers: Record<string, { command: string; args: string[] }>;
};

async function copyFakePlugin(): Promise<string> {
  const sourceDir = await mkdtemp(join(tmpdir(), 'claude-plugin-e2e-source-'));
  await cp(fakePluginDir, sourceDir, { recursive: true });
  return sourceDir;
}

async function writeTwoServerConfig(pluginDir: string): Promise<void> {
  await writeMcpConfig(pluginDir, {
    mcpServers: {
      alpha: {
        command: 'node',
        args: ['scripts/mcp-echo.js']
      },
      beta: {
        command: 'node',
        args: ['scripts/mcp-echo.js']
      }
    }
  });
}

async function writeMcpConfig(
  pluginDir: string,
  config: McpConfig
): Promise<void> {
  await writeFile(
    join(pluginDir, '.mcp.json'),
    `${JSON.stringify(config, null, 2)}\n`,
    'utf8'
  );
}

async function readMcpConfig(pluginDir: string): Promise<McpConfig> {
  return JSON.parse(await readFile(join(pluginDir, '.mcp.json'), 'utf8'));
}

function proxyServerNames(config: McpConfig): string[] {
  return Object.entries(config.mcpServers)
    .filter(([, server]) => server.args[0]?.includes('mcp-proxy-runner.cjs'))
    .map(([name]) => name)
    .sort();
}

function serverNames(config: McpConfig): string[] {
  return Object.keys(config.mcpServers).sort();
}

async function runConfiguredMcpServer(input: {
  pluginDir: string;
  serverName: string;
  traceDir: string;
  stdin: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ProcessRunResult> {
  const config = await readMcpConfig(input.pluginDir);
  const server = config.mcpServers[input.serverName];
  return runStructuredCommand({
    command: server.command,
    args: server.args,
    cwd: input.pluginDir,
    stdin: input.stdin,
    env: {
      ...process.env,
      ...input.env,
      CLAUDE_PLUGIN_E2E_MCP_TRACE_DIR: input.traceDir
    }
  });
}

async function runConfiguredMcpServerAndTerminate(input: {
  pluginDir: string;
  serverName: string;
  traceDir: string;
  stdin: string;
  signal: NodeJS.Signals;
}): Promise<ProcessRunResult> {
  const config = await readMcpConfig(input.pluginDir);
  const server = config.mcpServers[input.serverName];
  return runStructuredCommandAndTerminate({
    command: server.command,
    args: server.args,
    cwd: input.pluginDir,
    stdin: input.stdin,
    signal: input.signal,
    env: {
      ...process.env,
      CLAUDE_PLUGIN_E2E_MCP_TRACE_DIR: input.traceDir
    }
  });
}

function createPromptRunnerThatInvokesMcp(): ProcessRunner {
  return async (request: ProcessRunRequest): Promise<ProcessRunResult> => {
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

      const mcpRun = await runConfiguredMcpServer({
        pluginDir: promptRun.pluginDir,
        serverName: 'generic-fake',
        traceDir: request.env?.CLAUDE_PLUGIN_E2E_MCP_TRACE_DIR ?? '',
        stdin: `${JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { prompt: promptRun.prompt }
        })}\n`,
        env: request.env
      });
      if (mcpRun.exitCode !== 0) {
        return mcpRun;
      }

      return ok(
        `${JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'assistant after mcp' }]
          }
        })}\n`
      );
    }

    return unexpected(request);
  };
}

function createBootRunner(): ProcessRunner {
  return async (request: ProcessRunRequest): Promise<ProcessRunResult> => {
    const boot = matchBootRequest(request);
    if (boot) {
      return boot;
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

async function runStructuredCommand(input: {
  command: string;
  args: string[];
  cwd: string;
  stdin: string;
  env: NodeJS.ProcessEnv;
}): Promise<ProcessRunResult> {
  return new Promise((resolve) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: input.env,
      shell: false
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

async function runStructuredCommandAndTerminate(input: {
  command: string;
  args: string[];
  cwd: string;
  stdin: string;
  signal: NodeJS.Signals;
  env: NodeJS.ProcessEnv;
}): Promise<ProcessRunResult> {
  return new Promise((resolve) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: input.env,
      shell: false
    });
    let stdout = '';
    let stderr = '';
    let terminated = false;
    const terminate = () => {
      if (terminated) {
        return;
      }
      terminated = true;
      child.kill(input.signal);
    };
    const fallbackTimer = setTimeout(terminate, 500);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (stdout.includes(input.stdin)) {
        terminate();
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('close', (exitCode) => {
      clearTimeout(fallbackTimer);
      resolve({ exitCode, stdout, stderr });
    });
    child.stdin.write(input.stdin);
  });
}

async function readTraceArtifactText(traceDir: string): Promise<string> {
  const invocationDirs = await readdir(traceDir, { withFileTypes: true });
  const chunks = await Promise.all(
    invocationDirs
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        const dir = join(traceDir, entry.name);
        return ['trace.json', 'stdin.raw', 'stdout.raw', 'stderr.raw'].map(
          async (file) => readFile(join(dir, file), 'utf8')
        );
      })
  );
  return chunks.join('\n');
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
