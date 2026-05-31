import { readdir, rm, rmdir } from 'node:fs/promises';
import {
  createArtifactManager,
  redactArtifactText,
  type ArtifactManager
} from './artifacts.js';
import { normalizeClaudeCommand, withClaudeArgs } from './command.js';
import {
  ClaudeAuthError,
  ClaudeBinaryError,
  ClaudeFeatureError,
  PluginValidationError,
  ClaudeRunError,
  ClaudeVersionError,
  InteractiveProcessError,
  PluginInstrumentationError,
  TraceAssertionError
} from './errors.js';
import { expectHook, findHook, readHookTraces } from './hook-traces.js';
import { instrumentPlugin } from './instrumentation.js';
import { buildClaudeLaunchOptionArgs } from './launch-options.js';
import {
  DEFAULT_INTERACTIVE_CLOSE_TIMEOUT_MS,
  DEFAULT_INTERACTIVE_READINESS_TIMEOUT_MS,
  DEFAULT_INTERACTIVE_WAIT_TIMEOUT_MS,
  launchInteractiveRun,
  nodePtyAdapter
} from './interactive.js';
import {
  expectMcpMethod,
  findMcpMessages,
  readMcpTraces
} from './mcp-traces.js';
import { runProcess } from './process-runner.js';
import { validatePluginSource } from './plugin-validation.js';
import { readSlashCommands } from './slash-commands.js';
import { compareVersions, parseVersion } from './version.js';
import type {
  BootResult,
  ClaudePluginTester,
  ClaudePluginTesterOptions,
  CleanupMode,
  HeadlessPromptOptions,
  HookShellCommand,
  HookTraceMatcher,
  InstrumentedPlugin,
  InteractiveLaunchOptions,
  InteractiveSession,
  InteractivePtyAdapter,
  McpInstrumentationOptions,
  McpMessageMatcher,
  NormalizedClaudeCommand,
  ProcessRunner,
  PluginValidationResult,
  PromptResult,
  RunArtifacts,
  RedactionMode,
  SlashCommandInventory,
  ValidatePluginOptions
} from './types.js';

export const DEFAULT_MIN_CLAUDE_VERSION = '2.1.158';
export const REQUIRED_CLAUDE_HELP_FEATURES = [
  '-p',
  '--output-format',
  '--verbose',
  '--include-hook-events'
] as const;

const DEFAULT_BOOT_TIMEOUT_MS = 10_000;
const DEFAULT_HEADLESS_RUN_TIMEOUT_MS = 120_000;
const DEFAULT_VALIDATION_TIMEOUT_MS = 30_000;
const DEFAULT_HOOK_SHELL = 'bash -lc';
const DEFAULT_HEADLESS_MAX_TURNS = 3;
const PROXY_REDACTION_MODE_ENV = 'CLAUDE_PLUGIN_E2E_REDACTION_MODE';

export function createClaudePluginTester(
  options: ClaudePluginTesterOptions
): ClaudePluginTester {
  const normalized = normalizeOptions(options);
  let bootPromise: Promise<BootResult> | undefined;
  let artifactManagerPromise: Promise<ArtifactManager> | undefined;
  let instrumentedPluginPromise: Promise<InstrumentedPlugin> | undefined;

  const getArtifactManager = async (): Promise<ArtifactManager> => {
    artifactManagerPromise ??= createArtifactManager({
      artifactsDir: normalized.artifactsDir,
      cleanup: normalized.cleanup,
      redactionMode: normalized.redactionMode
    });
    return artifactManagerPromise;
  };

  const ensureInstrumentedPlugin = async (
    plugin?: BootResult['plugin']
  ): Promise<InstrumentedPlugin> => {
    instrumentedPluginPromise ??= (async () => {
      const [sourcePlugin, artifacts] = await Promise.all([
        plugin
          ? Promise.resolve(plugin)
          : validatePluginSource(normalized.pluginDir),
        getArtifactManager()
      ]);
      return instrumentPlugin({
        sourcePlugin,
        artifactsRoot: artifacts.root,
        hookShell: normalized.hookShell,
        mcp: normalized.mcp
      });
    })();
    return instrumentedPluginPromise;
  };
  const cleanupInstrumentedPlugin = async (
    plugin: InstrumentedPlugin,
    success: boolean
  ): Promise<void> => {
    if (!shouldCleanup(normalized.cleanup, success)) {
      return;
    }

    await cleanupInstrumentedWorkspace(plugin);
    instrumentedPluginPromise = undefined;
    bootPromise = undefined;
  };

  const boot = async (): Promise<BootResult> => {
    if (bootPromise) {
      return bootPromise;
    }

    bootPromise = (async () => {
      const [plugin, artifacts] = await Promise.all([
        validatePluginSource(normalized.pluginDir),
        getArtifactManager()
      ]);
      const instrumentedPlugin = await ensureInstrumentedPlugin(plugin);

      await assertBinaryExists(normalized);
      const auth = await assertAuthenticated(normalized);
      const helpOutput = await readHelp(normalized);
      assertRequiredFeatures(helpOutput);
      const claudeVersion = await readVersion(normalized);
      assertMinimumVersion(claudeVersion, normalized.minClaudeVersion);

      return {
        claudeCommand: normalized.claudeCommand,
        claudeVersion,
        helpOutput,
        auth,
        plugin,
        instrumentedPlugin,
        artifactsRoot: artifacts.root
      };
    })();

    return bootPromise;
  };

  return {
    boot,
    async slashCommands(): Promise<SlashCommandInventory> {
      return readSlashCommands(normalized.pluginDir);
    },
    async slashCommandPrompt(
      commandName: string,
      args?: string
    ): Promise<string> {
      const [plugin, inventory] = await Promise.all([
        validatePluginSource(normalized.pluginDir),
        readSlashCommands(normalized.pluginDir)
      ]);
      const command = inventory.commands.find(
        (candidate) => candidate.name === commandName
      );
      if (!command) {
        throw new PluginValidationError(
          `Slash command was not found in plugin inventory: ${commandName}`
        );
      }

      const invocation = `/${plugin.manifest.name}:${command.name}`;
      const trimmedArgs = args?.trim();
      return trimmedArgs ? `${invocation} ${trimmedArgs}` : invocation;
    },
    async validatePlugin(
      options: ValidatePluginOptions = {}
    ): Promise<PluginValidationResult> {
      return runPluginValidation(
        await getArtifactManager(),
        normalized,
        ensureInstrumentedPlugin,
        cleanupInstrumentedPlugin,
        options
      );
    },
    async prompt(
      prompt: string,
      options: HeadlessPromptOptions = {}
    ): Promise<PromptResult> {
      await boot();
      return runHeadlessPrompt(
        await getArtifactManager(),
        normalized,
        ensureInstrumentedPlugin,
        cleanupInstrumentedPlugin,
        prompt,
        options
      );
    },
    async launchInteractive(
      options: InteractiveLaunchOptions = {}
    ): Promise<InteractiveSession> {
      await boot();
      return launchInteractiveRun({
        artifactManager: await getArtifactManager(),
        normalized,
        instrumentedPlugin: await ensureInstrumentedPlugin(),
        cleanupInstrumentedPlugin,
        options
      });
    }
  };
}

type NormalizedOptions = {
  pluginDir: string;
  hookShell: HookShellCommand;
  mcp: McpInstrumentationOptions;
  cwd?: string;
  claudeCommand: NormalizedClaudeCommand;
  minClaudeVersion: string | false;
  artifactsDir?: string;
  cleanup: CleanupMode;
  redactionMode: RedactionMode;
  env: NodeJS.ProcessEnv;
  bootTimeoutMs: number;
  headlessRunTimeoutMs: number;
  validationTimeoutMs: number;
  interactiveReadinessTimeoutMs: number;
  interactiveWaitTimeoutMs: number;
  interactiveCloseTimeoutMs: number;
  processRunner: ProcessRunner;
  ptyAdapter: InteractivePtyAdapter;
};

function normalizeOptions(
  options: ClaudePluginTesterOptions
): NormalizedOptions {
  return {
    pluginDir: options.pluginDir,
    hookShell: normalizeHookShell(options.hookShell ?? DEFAULT_HOOK_SHELL),
    mcp: normalizeMcpInstrumentationOptions(options.mcp),
    cwd: options.cwd,
    claudeCommand: normalizeClaudeCommand(options),
    minClaudeVersion:
      options.minClaudeVersion === undefined
        ? DEFAULT_MIN_CLAUDE_VERSION
        : options.minClaudeVersion,
    artifactsDir: options.artifactsDir,
    cleanup: options.cleanup ?? 'always',
    redactionMode: options.redaction?.mode ?? 'safe',
    env: options.env ?? process.env,
    bootTimeoutMs: options.timeouts?.bootMs ?? DEFAULT_BOOT_TIMEOUT_MS,
    headlessRunTimeoutMs:
      options.timeouts?.headlessRunMs ?? DEFAULT_HEADLESS_RUN_TIMEOUT_MS,
    validationTimeoutMs:
      options.timeouts?.validationMs ?? DEFAULT_VALIDATION_TIMEOUT_MS,
    interactiveReadinessTimeoutMs:
      options.timeouts?.interactiveReadinessMs ??
      DEFAULT_INTERACTIVE_READINESS_TIMEOUT_MS,
    interactiveWaitTimeoutMs:
      options.timeouts?.interactiveWaitMs ??
      DEFAULT_INTERACTIVE_WAIT_TIMEOUT_MS,
    interactiveCloseTimeoutMs:
      options.timeouts?.interactiveCloseMs ??
      DEFAULT_INTERACTIVE_CLOSE_TIMEOUT_MS,
    processRunner: options.processRunner ?? runProcess,
    ptyAdapter: options.ptyAdapter ?? nodePtyAdapter
  };
}

function normalizeMcpInstrumentationOptions(
  options: McpInstrumentationOptions | undefined
): McpInstrumentationOptions {
  return {
    include: [...(options?.include ?? [])],
    exclude: [...(options?.exclude ?? [])],
    mode: options?.mode ?? 'proxy-only'
  };
}

function normalizeHookShell(
  hookShell: string | HookShellCommand
): HookShellCommand {
  if (typeof hookShell !== 'string') {
    if (!hookShell.command.trim()) {
      throw new PluginInstrumentationError(
        'hookShell.command must not be empty.'
      );
    }
    return {
      command: hookShell.command,
      args: [...(hookShell.args ?? [])]
    };
  }

  const parts = splitShellWords(hookShell);
  const [command, ...args] = parts;
  if (!command) {
    throw new PluginInstrumentationError('hookShell must not be empty.');
  }
  return { command, args };
}

function splitShellWords(input: string): string[] {
  const words: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  let escaped = false;
  let hasToken = false;

  for (const char of input) {
    if (escaped) {
      current += char;
      escaped = false;
      hasToken = true;
      continue;
    }

    if (char === '\\' && quote !== "'") {
      escaped = true;
      hasToken = true;
      continue;
    }

    if ((char === '"' || char === "'") && !quote) {
      quote = char;
      hasToken = true;
      continue;
    }

    if (char === quote) {
      quote = undefined;
      hasToken = true;
      continue;
    }

    if (!quote && /\s/.test(char)) {
      if (hasToken) {
        words.push(current);
        current = '';
        hasToken = false;
      }
      continue;
    }

    current += char;
    hasToken = true;
  }

  if (escaped) {
    current += '\\';
  }
  if (quote) {
    throw new PluginInstrumentationError(
      `hookShell contains an unterminated ${quote} quote.`
    );
  }
  if (hasToken) {
    words.push(current);
  }

  return words;
}

function shouldCleanup(cleanup: CleanupMode, success: boolean): boolean {
  return cleanup === 'always' || (cleanup === 'on-success' && success);
}

async function cleanupInstrumentedWorkspace(
  plugin: InstrumentedPlugin
): Promise<void> {
  await rm(plugin.pluginDir, { recursive: true, force: true });

  try {
    if ((await readdir(plugin.workspaceDir)).length === 0) {
      await rmdir(plugin.workspaceDir);
    }
  } catch {
    // Best-effort cleanup must not mask the run result.
  }
}

async function runPluginValidation(
  artifactManager: ArtifactManager,
  normalized: NormalizedOptions,
  ensureInstrumentedPlugin: () => Promise<InstrumentedPlugin>,
  cleanupInstrumentedPlugin: (
    plugin: InstrumentedPlugin,
    success: boolean
  ) => Promise<void>,
  options: ValidatePluginOptions
): Promise<PluginValidationResult> {
  const rawTarget = (options as { target?: { kind: string } }).target ?? {
    kind: 'source'
  };
  if (rawTarget.kind !== 'source' && rawTarget.kind !== 'instrumented') {
    throw new PluginValidationError(
      `Unsupported plugin validation target: ${rawTarget.kind}`
    );
  }
  const target = rawTarget as { kind: 'source' | 'instrumented' };

  const instrumentedPlugin =
    target.kind === 'instrumented'
      ? await ensureInstrumentedPlugin()
      : undefined;
  const plugin = await validatePluginSource(
    instrumentedPlugin?.pluginDir ?? normalized.pluginDir
  );
  const artifacts =
    await artifactManager.createRunArtifacts('plugin-validation');
  const command = withClaudeArgs(normalized.claudeCommand, [
    'plugin',
    'validate',
    plugin.pluginDir,
    '--strict'
  ]);
  const startedAt = new Date();
  const startNs = process.hrtime.bigint();
  let success = false;

  try {
    await artifactManager.writeRunBaseline(artifacts, normalized.env);
    const result = await normalized.processRunner({
      command: command.command,
      args: command.args,
      cwd: normalized.cwd,
      env: normalized.env,
      timeoutMs: normalized.validationTimeoutMs
    });
    const endedAt = new Date();
    const durationMs = Number(process.hrtime.bigint() - startNs) / 1_000_000;

    await Promise.all([
      artifactManager.writeTextArtifact(
        artifacts.rawStdoutPath,
        redactArtifactText(result.stdout, normalized.redactionMode)
      ),
      artifactManager.writeTextArtifact(
        artifacts.rawStderrPath,
        redactArtifactText(result.stderr, normalized.redactionMode)
      ),
      writeDebugLogArtifact(
        artifactManager,
        artifacts,
        result.stderr,
        normalized.redactionMode
      ),
      artifactManager.writeJsonArtifact(
        artifacts.summaryPath,
        createValidationSummary({
          artifacts,
          command,
          cwd: normalized.cwd,
          target,
          pluginDir: plugin.pluginDir,
          exitCode: result.exitCode,
          errorCode: result.errorCode,
          startedAt,
          endedAt,
          durationMs,
          stdoutBytes: Buffer.byteLength(result.stdout),
          stderrBytes: Buffer.byteLength(result.stderr)
        })
      )
    ]);

    if (result.errorCode === 'ENOENT') {
      throw new ClaudeBinaryError(
        `Claude binary was not found: ${normalized.claudeCommand.command}`
      );
    }

    if (result.exitCode !== 0 || result.errorCode) {
      if (claudeOutputRequiresAuth(result.stdout, result.stderr)) {
        await assertAuthenticated(normalized);
      }

      throw new PluginValidationError(
        `Claude plugin validation failed for ${plugin.pluginDir}. Artifacts: ${artifacts.dir}`,
        {
          stdout: redactArtifactText(result.stdout, normalized.redactionMode),
          stderr: redactArtifactText(result.stderr, normalized.redactionMode),
          exitCode: result.exitCode,
          artifactsDir: artifacts.dir,
          artifactPaths: [
            artifacts.summaryPath,
            artifacts.rawStdoutPath,
            artifacts.rawStderrPath
          ]
        }
      );
    }

    success = true;
    return {
      kind: 'plugin-validation',
      target,
      pluginDir: plugin.pluginDir,
      command,
      cwd: normalized.cwd,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      artifacts
    };
  } finally {
    await artifactManager.cleanupRun(artifacts, success);
    if (instrumentedPlugin) {
      await cleanupInstrumentedPlugin(instrumentedPlugin, success);
    }
  }
}

async function runHeadlessPrompt(
  artifactManager: ArtifactManager,
  normalized: NormalizedOptions,
  ensureInstrumentedPlugin: () => Promise<InstrumentedPlugin>,
  cleanupInstrumentedPlugin: (
    plugin: InstrumentedPlugin,
    success: boolean
  ) => Promise<void>,
  prompt: string,
  options: HeadlessPromptOptions
): Promise<PromptResult> {
  const instrumentedPlugin = await ensureInstrumentedPlugin();
  const artifacts = await artifactManager.createRunArtifacts('prompt');
  const headlessArgs = [
    '--plugin-dir',
    instrumentedPlugin.pluginDir,
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-hook-events',
    ...buildHeadlessOptionArgs(options),
    prompt
  ];
  const command = withClaudeArgs(normalized.claudeCommand, headlessArgs);
  const startedAt = new Date();
  const startNs = process.hrtime.bigint();
  let success = false;

  try {
    await artifactManager.writeRunBaseline(artifacts, normalized.env);
    const result = await normalized.processRunner({
      command: command.command,
      args: command.args,
      cwd: normalized.cwd,
      env: {
        ...normalized.env,
        CLAUDE_PLUGIN_E2E_HOOK_TRACE_DIR: artifacts.hookTraceDir,
        CLAUDE_PLUGIN_E2E_FALLBACK_HOOK_TRACE_DIR:
          instrumentedPlugin.hookTraceDir,
        CLAUDE_PLUGIN_E2E_MCP_TRACE_DIR: artifacts.mcpTraceDir,
        CLAUDE_PLUGIN_E2E_FALLBACK_MCP_TRACE_DIR:
          instrumentedPlugin.mcpTraceDir,
        [PROXY_REDACTION_MODE_ENV]: normalized.redactionMode,
        ...(normalized.redactionMode === 'off' &&
        process.env.CLAUDE_PLUGIN_E2E_ALLOW_UNREDACTED === '1'
          ? { CLAUDE_PLUGIN_E2E_ALLOW_UNREDACTED: '1' }
          : {})
      },
      timeoutMs: normalized.headlessRunTimeoutMs
    });
    const endedAt = new Date();
    const durationMs = Number(process.hrtime.bigint() - startNs) / 1_000_000;
    const parsed = parseStreamEvents(result.stdout);

    await Promise.all([
      artifactManager.writeTextArtifact(
        artifacts.rawStdoutPath,
        redactArtifactText(result.stdout, normalized.redactionMode)
      ),
      artifactManager.writeTextArtifact(
        artifacts.rawStderrPath,
        redactArtifactText(result.stderr, normalized.redactionMode)
      ),
      writeDebugLogArtifact(
        artifactManager,
        artifacts,
        result.stderr,
        normalized.redactionMode
      ),
      artifactManager.writeJsonArtifact(
        artifacts.streamEventsPath,
        redactStreamArtifact(parsed.events, normalized.redactionMode)
      ),
      artifactManager.writeJsonArtifact(
        artifacts.streamParseErrorsPath,
        redactParseErrors(parsed.parseErrors, normalized.redactionMode)
      )
    ]);

    const assistantText = extractAssistantText(parsed.events);
    const hookTraces = await readHookTraces(artifacts.hookTraceDir);
    const mcpTraces = await readMcpTraces(artifacts.mcpTraceDir);
    await artifactManager.writeJsonArtifact(
      artifacts.summaryPath,
      createRunSummary({
        artifacts,
        command,
        cwd: normalized.cwd,
        promptArgIndex: command.args.length - 1,
        exitCode: result.exitCode,
        errorCode: result.errorCode,
        startedAt,
        endedAt,
        durationMs,
        eventCount: parsed.events.length,
        parseErrorCount: parsed.parseErrors.length,
        hookTraceCount: hookTraces.length,
        mcpTraceCount: mcpTraces.length,
        stdoutBytes: Buffer.byteLength(result.stdout),
        stderrBytes: Buffer.byteLength(result.stderr),
        assistantText
      })
    );

    if (result.errorCode === 'ETIMEDOUT') {
      throw new ClaudeRunError(
        `Headless Claude prompt timed out after ${normalized.headlessRunTimeoutMs}ms. Artifacts: ${artifacts.dir}`
      );
    }

    if (result.errorCode === 'ENOENT') {
      throw new ClaudeBinaryError(
        `Claude binary was not found: ${normalized.claudeCommand.command}`
      );
    }

    if (result.exitCode !== 0) {
      throw new ClaudeRunError(
        `Headless Claude prompt failed with exit status ${String(
          result.exitCode
        )}. Artifacts: ${artifacts.dir}`
      );
    }

    const promptResult = createPromptResult({
      prompt,
      command,
      cwd: normalized.cwd,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      events: parsed.events,
      parseErrors: parsed.parseErrors,
      hookTraces,
      mcpTraces,
      artifacts,
      redactionMode: normalized.redactionMode
    });

    success = true;
    return promptResult;
  } finally {
    await artifactManager.cleanupRun(artifacts, success);
    await cleanupInstrumentedPlugin(instrumentedPlugin, success);
  }
}

function buildHeadlessOptionArgs(options: HeadlessPromptOptions): string[] {
  return [
    ...buildClaudeLaunchOptionArgs(options),
    '--max-turns',
    String(options.maxTurns ?? DEFAULT_HEADLESS_MAX_TURNS)
  ];
}

async function assertBinaryExists(options: NormalizedOptions): Promise<void> {
  const result = await runClaude(options, ['--version']);
  if (result.errorCode === 'ENOENT') {
    throw new ClaudeBinaryError(
      `Claude binary was not found: ${options.claudeCommand.command}`
    );
  }
  if (result.exitCode !== 0) {
    throw new ClaudeBinaryError(
      `Claude binary check failed: ${result.stderr || result.stdout}`
    );
  }
}

async function assertAuthenticated(
  options: NormalizedOptions
): Promise<BootResult['auth']> {
  const result = await runClaude(options, ['auth', 'status', '--json']);
  if (result.exitCode !== 0) {
    throw new ClaudeAuthError(
      `Claude auth status failed: ${result.stderr || result.stdout}`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    throw new ClaudeAuthError(
      `Claude auth status did not return JSON: ${formatUnknownError(error)}`
    );
  }

  if (!isAuthenticatedStatus(parsed)) {
    throw new ClaudeAuthError('Claude is not authenticated.');
  }

  return {
    authenticated: true,
    raw: parsed
  };
}

async function readHelp(options: NormalizedOptions): Promise<string> {
  const result = await runClaude(options, ['--help']);
  if (result.exitCode !== 0) {
    throw new ClaudeFeatureError(
      `Claude help check failed: ${result.stderr || result.stdout}`
    );
  }
  return `${result.stdout}\n${result.stderr}`;
}

function assertRequiredFeatures(helpOutput: string): void {
  const missing = REQUIRED_CLAUDE_HELP_FEATURES.filter(
    (feature) => !helpOutput.includes(feature)
  );
  if (missing.length > 0) {
    throw new ClaudeFeatureError(
      `Claude help output is missing required flags: ${missing.join(', ')}`
    );
  }
}

async function readVersion(options: NormalizedOptions): Promise<string | null> {
  const result = await runClaude(options, ['--version']);
  if (result.exitCode !== 0) {
    throw new ClaudeVersionError(
      `Claude version check failed: ${result.stderr || result.stdout}`
    );
  }
  return parseVersion(`${result.stdout}\n${result.stderr}`);
}

function assertMinimumVersion(
  actualVersion: string | null,
  minimumVersion: string | false
): void {
  if (minimumVersion === false) {
    return;
  }

  if (!actualVersion) {
    throw new ClaudeVersionError(
      `Unable to parse Claude version for minimum guard ${minimumVersion}.`
    );
  }

  if (compareVersions(actualVersion, minimumVersion) < 0) {
    throw new ClaudeVersionError(
      `Claude ${actualVersion} is below required minimum ${minimumVersion}.`
    );
  }
}

async function runClaude(
  options: NormalizedOptions,
  args: string[]
): ReturnType<ProcessRunner> {
  const command = withClaudeArgs(options.claudeCommand, args);
  return options.processRunner({
    command: command.command,
    args: command.args,
    cwd: options.cwd,
    env: options.env,
    timeoutMs: options.bootTimeoutMs
  });
}

function isAuthenticatedStatus(value: unknown): boolean {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.authenticated === true ||
    record.loggedIn === true ||
    record.status === 'authenticated'
  );
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseStreamEvents(stdout: string): {
  events: unknown[];
  parseErrors: { line: number; text: string; message: string }[];
} {
  const events: unknown[] = [];
  const parseErrors: { line: number; text: string; message: string }[] = [];

  stdout.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) {
      return;
    }

    try {
      events.push(JSON.parse(line));
    } catch (error) {
      parseErrors.push({
        line: index + 1,
        text: line,
        message: formatUnknownError(error)
      });
    }
  });

  return { events, parseErrors };
}

function createPromptResult(input: {
  prompt: string;
  command: NormalizedClaudeCommand;
  cwd?: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  events: unknown[];
  parseErrors: { line: number; text: string; message: string }[];
  hookTraces: Awaited<ReturnType<typeof readHookTraces>>;
  mcpTraces: Awaited<ReturnType<typeof readMcpTraces>>;
  artifacts: RunArtifacts;
  redactionMode: RedactionMode;
}): PromptResult {
  const result = {
    kind: 'headless' as const,
    prompt: input.prompt,
    command: input.command,
    cwd: input.cwd,
    exitCode: input.exitCode,
    stdout: input.stdout,
    stderr: input.stderr,
    events: input.events,
    parseErrors: input.parseErrors,
    hookTraces: input.hookTraces,
    mcpTraces: input.mcpTraces,
    artifacts: input.artifacts,
    assistantText(): string {
      return extractAssistantText(input.events);
    },
    eventsByType(type: string): unknown[] {
      return input.events.filter((event) => eventHasType(event, type));
    },
    expectText(expected: string | RegExp): PromptResult {
      const text = result.assistantText();
      const found =
        typeof expected === 'string'
          ? text.includes(expected)
          : expected.test(text);

      if (!found) {
        throw new TraceAssertionError(
          `Expected headless Claude output to contain ${formatExpectedForAssertion(
            expected,
            input.redactionMode
          )}.`,
          input.artifacts.dir,
          [
            input.artifacts.summaryPath,
            input.artifacts.rawStdoutPath,
            input.artifacts.rawStderrPath,
            input.artifacts.streamEventsPath,
            input.artifacts.streamParseErrorsPath
          ]
        );
      }

      return result;
    },
    findHook(matcher: HookTraceMatcher): ReturnType<PromptResult['findHook']> {
      return findHook(result, matcher);
    },
    expectHook(
      matcher: HookTraceMatcher
    ): ReturnType<PromptResult['expectHook']> {
      return expectHook(result, matcher);
    },
    findMcpMessages(
      matcher?: McpMessageMatcher
    ): ReturnType<PromptResult['findMcpMessages']> {
      return findMcpMessages(result, matcher);
    },
    expectMcpMethod(
      method: string | RegExp
    ): ReturnType<PromptResult['expectMcpMethod']> {
      return expectMcpMethod(result, method);
    }
  };

  return result;
}

function eventHasType(event: unknown, type: string): boolean {
  return (
    !!event &&
    typeof event === 'object' &&
    (event as Record<string, unknown>).type === type
  );
}

function extractAssistantText(events: unknown[]): string {
  return events
    .filter(isAssistantLikeEvent)
    .flatMap((event) => collectTextFields(event))
    .join('\n')
    .trim();
}

function isAssistantLikeEvent(event: unknown): boolean {
  if (!event || typeof event !== 'object') {
    return false;
  }

  const record = event as Record<string, unknown>;
  if (record.type === 'assistant' || record.role === 'assistant') {
    return true;
  }

  const message = record.message;
  return (
    !!message &&
    typeof message === 'object' &&
    (message as Record<string, unknown>).role === 'assistant'
  );
}

function collectTextFields(value: unknown): string[] {
  if (!value || typeof value !== 'object') {
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => collectTextFields(item));
  }

  const record = value as Record<string, unknown>;
  const ownText = ['text', 'content'].flatMap((key) => {
    const field = record[key];
    return typeof field === 'string' ? [field] : collectTextFields(field);
  });
  const nestedText = Object.entries(record)
    .filter(([key]) => key !== 'text' && key !== 'content')
    .flatMap(([, field]) => collectTextFields(field));

  return [...ownText, ...nestedText];
}

function createRunSummary(input: {
  artifacts: RunArtifacts;
  command: NormalizedClaudeCommand;
  cwd?: string;
  promptArgIndex: number;
  exitCode: number | null;
  errorCode?: string;
  startedAt: Date;
  endedAt: Date;
  durationMs: number;
  eventCount: number;
  parseErrorCount: number;
  hookTraceCount: number;
  mcpTraceCount: number;
  stdoutBytes: number;
  stderrBytes: number;
  assistantText: string;
}): unknown {
  return {
    runId: input.artifacts.runId,
    kind: 'headless-prompt',
    command: {
      command: input.command.command,
      args: input.command.args.map((arg, index) =>
        index === input.promptArgIndex ? '[PROMPT_REDACTED]' : arg
      ),
      promptArgIndex: input.promptArgIndex
    },
    cwd: input.cwd,
    exitStatus: {
      exitCode: input.exitCode,
      errorCode: input.errorCode
    },
    timing: {
      startedAt: input.startedAt.toISOString(),
      endedAt: input.endedAt.toISOString(),
      durationMs: Math.round(input.durationMs)
    },
    artifacts: {
      dir: input.artifacts.dir,
      rawDir: input.artifacts.rawDir,
      summaryPath: input.artifacts.summaryPath,
      environmentPath: input.artifacts.environmentPath,
      rawStdoutPath: input.artifacts.rawStdoutPath,
      rawStderrPath: input.artifacts.rawStderrPath,
      debugLogPath: input.artifacts.debugLogPath,
      hookTraceDir: input.artifacts.hookTraceDir,
      mcpTraceDir: input.artifacts.mcpTraceDir,
      streamEventsPath: input.artifacts.streamEventsPath,
      streamParseErrorsPath: input.artifacts.streamParseErrorsPath
    },
    result: {
      eventCount: input.eventCount,
      parseErrorCount: input.parseErrorCount,
      hookTraceCount: input.hookTraceCount,
      mcpTraceCount: input.mcpTraceCount,
      stdoutBytes: input.stdoutBytes,
      stderrBytes: input.stderrBytes,
      assistantTextPreview: redactPreview(input.assistantText)
    }
  };
}

function createValidationSummary(input: {
  artifacts: RunArtifacts;
  command: NormalizedClaudeCommand;
  cwd?: string;
  target: { kind: 'source' | 'instrumented' };
  pluginDir: string;
  exitCode: number | null;
  errorCode?: string;
  startedAt: Date;
  endedAt: Date;
  durationMs: number;
  stdoutBytes: number;
  stderrBytes: number;
}): unknown {
  return {
    runId: input.artifacts.runId,
    kind: 'plugin-validation',
    target: input.target,
    pluginDir: input.pluginDir,
    command: {
      command: input.command.command,
      args: input.command.args
    },
    cwd: input.cwd,
    exitStatus: {
      exitCode: input.exitCode,
      errorCode: input.errorCode
    },
    timing: {
      startedAt: input.startedAt.toISOString(),
      endedAt: input.endedAt.toISOString(),
      durationMs: Math.round(input.durationMs)
    },
    artifacts: {
      dir: input.artifacts.dir,
      rawDir: input.artifacts.rawDir,
      summaryPath: input.artifacts.summaryPath,
      environmentPath: input.artifacts.environmentPath,
      rawStdoutPath: input.artifacts.rawStdoutPath,
      rawStderrPath: input.artifacts.rawStderrPath,
      debugLogPath: input.artifacts.debugLogPath
    },
    result: {
      stdoutBytes: input.stdoutBytes,
      stderrBytes: input.stderrBytes
    }
  };
}

function claudeOutputRequiresAuth(stdout: string, stderr: string): boolean {
  const output = `${stdout}\n${stderr}`.toLowerCase();
  return (
    output.includes('auth') &&
    (output.includes('login') ||
      output.includes('not authenticated') ||
      output.includes('unauthenticated'))
  );
}

function redactPreview(value: string): string {
  return value ? '[REDACTED]' : '';
}

function formatExpectedForAssertion(
  expected: string | RegExp,
  mode: RedactionMode
): string {
  if (mode === 'off') {
    return String(expected);
  }
  return '[REDACTED_EXPECTATION]';
}

async function writeDebugLogArtifact(
  artifactManager: ArtifactManager,
  artifacts: RunArtifacts,
  stderr: string,
  redactionMode: RedactionMode
): Promise<void> {
  if (stderr.length === 0) {
    return;
  }
  await artifactManager.writeTextArtifact(
    artifacts.debugLogPath,
    redactArtifactText(stderr, redactionMode)
  );
}

function redactStreamArtifact(value: unknown, mode: RedactionMode): unknown {
  if (mode === 'off') {
    return value;
  }
  return redactSensitiveArtifactFields(value);
}

function redactParseErrors(
  parseErrors: { line: number; text: string; message: string }[],
  mode: RedactionMode
): { line: number; text: string; message: string }[] {
  if (mode === 'off') {
    return parseErrors;
  }
  return parseErrors.map((error) => ({
    ...error,
    text: error.text ? '[REDACTED]' : error.text
  }));
}

function redactSensitiveArtifactFields(
  value: unknown,
  parentKey?: string
): unknown {
  if (typeof value === 'string') {
    return parentKey && isSensitiveArtifactKey(parentKey)
      ? '[REDACTED]'
      : value;
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveArtifactFields(item, parentKey));
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, field]) => [
      key,
      redactSensitiveArtifactFields(field, key)
    ])
  );
}

function isSensitiveArtifactKey(key: string): boolean {
  return /^(text|content|prompt|input|output|stdout|stderr|data)$/i.test(key);
}

export function notImplementedPromptExecution(): never {
  throw new ClaudeRunError(
    'Real headless Claude execution is deferred to a later plugin-e2e-module issue.'
  );
}

export function notImplementedInteractiveExecution(): never {
  throw new InteractiveProcessError(
    'Real interactive Claude execution is deferred to a later plugin-e2e-module issue.'
  );
}
