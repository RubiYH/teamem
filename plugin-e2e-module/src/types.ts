import type { Stats } from 'node:fs';

export type ClaudeCommand = {
  command: string;
  args?: string[];
};

export type HookShellCommand = {
  command: string;
  args?: string[];
};

export type CleanupMode = 'always' | 'on-success' | 'never';
export type RedactionMode = 'safe' | 'off';
export type ClaudePermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'plan'
  | 'auto'
  | 'dontAsk'
  | 'bypassPermissions';

export type ClaudeLaunchOptions = {
  permissionMode?: ClaudePermissionMode;
  allowedTools?: string[];
  disallowedTools?: string[];
  settingSources?: string | string[];
  systemPrompt?: string;
  appendSystemPrompt?: string;
  model?: string;
  maxBudgetUsd?: number | string;
};

export type HeadlessPromptOptions = ClaudeLaunchOptions & {
  maxTurns?: number;
};

export type ClaudePluginTesterOptions = {
  pluginDir: string;
  hookShell?: string | HookShellCommand;
  mcp?: McpInstrumentationOptions;
  cwd?: string;
  claudeBin?: string;
  claudeCommand?: ClaudeCommand;
  minClaudeVersion?: string | false;
  artifactsDir?: string;
  cleanup?: CleanupMode;
  redaction?: {
    mode?: RedactionMode;
  };
  env?: NodeJS.ProcessEnv;
  timeouts?: {
    bootMs?: number;
    headlessRunMs?: number;
    validationMs?: number;
    interactiveReadinessMs?: number;
    interactiveWaitMs?: number;
    interactiveCloseMs?: number;
  };
  processRunner?: ProcessRunner;
  ptyAdapter?: InteractivePtyAdapter;
};

export type NormalizedClaudeCommand = {
  command: string;
  args: string[];
};

export type ProcessRunRequest = {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
};

export type ProcessRunResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  errorCode?: string;
};

export type ProcessRunner = (
  request: ProcessRunRequest
) => Promise<ProcessRunResult>;

export type BootResult = {
  claudeCommand: NormalizedClaudeCommand;
  claudeVersion: string | null;
  helpOutput: string;
  auth: {
    authenticated: true;
    raw: unknown;
  };
  plugin: ValidatedPluginSource;
  instrumentedPlugin: InstrumentedPlugin;
  artifactsRoot: string;
};

export type ValidatedPluginSource = {
  pluginDir: string;
  manifestPath: string;
  manifest: {
    name: string;
    [key: string]: unknown;
  };
  hooksPath?: string;
  mcpPath?: string;
};

export type RunArtifacts = {
  runId: string;
  dir: string;
  rawDir: string;
  hookTraceDir: string;
  mcpTraceDir: string;
  summaryPath: string;
  environmentPath: string;
  rawStdoutPath: string;
  rawStderrPath: string;
  debugLogPath: string;
  streamEventsPath: string;
  streamParseErrorsPath: string;
  rawTranscriptPath: string;
  normalizedTranscriptPath: string;
  interactiveEventsPath: string;
};

export type PromptResult = {
  kind: 'headless';
  prompt: string;
  command: NormalizedClaudeCommand;
  cwd?: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  events: unknown[];
  parseErrors: StreamParseError[];
  hookTraces: HookTrace[];
  mcpTraces: McpTrace[];
  artifacts: RunArtifacts;
  assistantText(): string;
  eventsByType(type: string): unknown[];
  expectText(expected: string | RegExp): PromptResult;
  findHook(matcher: HookTraceMatcher): HookTrace | undefined;
  expectHook(matcher: HookTraceMatcher): HookTrace;
  findMcpMessages(matcher?: McpMessageMatcher): McpTraceMessage[];
  expectMcpMethod(method: string | RegExp): McpTraceMessage;
};

export type PluginValidationTarget = {
  kind: 'source' | 'instrumented';
};

export type ValidatePluginOptions = {
  target?: PluginValidationTarget;
};

export type PluginValidationResult = {
  kind: 'plugin-validation';
  target: PluginValidationTarget;
  pluginDir: string;
  command: NormalizedClaudeCommand;
  cwd?: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  artifacts: RunArtifacts;
};

export type InteractiveLaunchOptions = ClaudeLaunchOptions & {
  readiness?: InteractiveReadinessMatcher;
  readinessTimeoutMs?: number;
  waitTimeoutMs?: number;
  closeTimeoutMs?: number;
};

export type InteractiveReadinessMatcher =
  | string
  | RegExp
  | ((transcript: string) => boolean);

export type InteractiveTypeOptions = {
  delayMs?: number;
};

export type InteractiveWaitOptions = {
  timeoutMs?: number;
};

export type InteractiveKey =
  | 'enter'
  | 'escape'
  | 'tab'
  | 'backspace'
  | 'ctrl+c'
  | 'up'
  | 'down'
  | 'left'
  | 'right';

export type InteractiveSyntheticEvent =
  | {
      type: 'output';
      timestamp: string;
      data: string;
    }
  | {
      type: 'input';
      timestamp: string;
      data: string;
      source: 'type' | 'press' | 'submit' | 'close';
    }
  | {
      type: 'ready';
      timestamp: string;
      timeoutMs: number;
    }
  | {
      type: 'exit';
      timestamp: string;
      exitCode: number | null;
      signal?: number;
    }
  | {
      type: 'close-step';
      timestamp: string;
      step: 'exit-command' | 'ctrl-c' | 'kill';
    };

export type InteractiveSession = {
  kind: 'interactive';
  command: NormalizedClaudeCommand;
  cwd?: string;
  artifacts: RunArtifacts;
  rawTranscript(): string;
  normalizedTranscript(): string;
  events(): InteractiveSyntheticEvent[];
  waitFor(
    matcher: InteractiveReadinessMatcher,
    options?: InteractiveWaitOptions
  ): Promise<void>;
  type(text: string, options?: InteractiveTypeOptions): Promise<void>;
  press(key: InteractiveKey | string): Promise<void>;
  submit(text: string, options?: InteractiveTypeOptions): Promise<void>;
  close(): Promise<void>;
};

export type ClaudePluginTester = {
  boot(): Promise<BootResult>;
  slashCommands(): Promise<SlashCommandInventory>;
  slashCommandPrompt(commandName: string, args?: string): Promise<string>;
  validatePlugin(
    options?: ValidatePluginOptions
  ): Promise<PluginValidationResult>;
  prompt(
    prompt: string,
    options?: HeadlessPromptOptions
  ): Promise<PromptResult>;
  launchInteractive(
    options?: InteractiveLaunchOptions
  ): Promise<InteractiveSession>;
};

export type InteractivePtySpawnRequest = {
  command: string;
  args: string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
};

export type InteractivePtyProcess = {
  pid: number;
  write(data: string | Buffer): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): {
    dispose(): void;
  };
};

export type InteractivePtyAdapter = {
  spawn(request: InteractivePtySpawnRequest): InteractivePtyProcess;
};

export type FileStatReader = (path: string) => Promise<Stats>;

export type SlashCommandMetadata = {
  description?: string;
  allowedTools?: string[];
  argumentHint?: string;
};

export type SlashCommand = {
  name: string;
  filePath: string;
  content: string;
  metadata: SlashCommandMetadata;
};

export type SlashCommandInventory = {
  kind: 'slash-command-inventory';
  pluginDir: string;
  commandsDir: string;
  commands: SlashCommand[];
  scope: {
    slashCommands: 'supported';
    skills: 'deferred';
    agents: 'deferred';
  };
};

export type StreamParseError = {
  line: number;
  text: string;
  message: string;
};

export type InstrumentedPlugin = {
  sourcePluginDir: string;
  pluginDir: string;
  workspaceDir: string;
  hookTraceDir: string;
  mcpTraceDir: string;
  hooksPath?: string;
  mcpPath?: string;
};

export type HookTraceArtifacts = {
  tracePath: string;
  stdinPath: string;
  stdoutPath: string;
  stderrPath: string;
};

export type ProxyTraceEnvironment = {
  redactionMode: RedactionMode;
  env: Partial<
    Record<
      | 'CLAUDE_PLUGIN_ROOT'
      | 'CLAUDE_PLUGIN_DATA'
      | 'CLAUDE_SESSION_ID'
      | 'CLAUDE_PROJECT_DIR',
      string
    >
  >;
};

export type HookTrace = {
  event: string;
  stdin: string;
  stdinJson?: unknown;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  environment?: ProxyTraceEnvironment;
  artifacts: HookTraceArtifacts;
};

export type HookTraceMatcher =
  | string
  | RegExp
  | ((trace: HookTrace) => boolean);

export type McpInstrumentationOptions = {
  include?: string[];
  exclude?: string[];
  mode?: 'proxy-only' | 'disable-non-included';
};

export type McpTraceArtifacts = {
  tracePath: string;
  stdinPath: string;
  stdoutPath: string;
  stderrPath: string;
};

export type McpTraceMessageDirection = 'client-to-server' | 'server-to-client';

export type McpTraceMessage = {
  serverName: string;
  direction: McpTraceMessageDirection;
  raw: string;
  json?: unknown;
  method?: string;
  timestamp: string;
  offsetMs: number;
  artifacts: McpTraceArtifacts;
};

export type McpTrace = {
  serverName: string;
  command: string;
  args: string[];
  startedAt: string;
  endedAt: string;
  durationMs: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  partial: boolean;
  terminationReason: string;
  error?: string;
  stdin: string;
  stdout: string;
  stderr: string;
  messages: McpTraceMessage[];
  environment?: ProxyTraceEnvironment;
  artifacts: McpTraceArtifacts;
  placeholderExpansion: {
    supportedPattern: '${VAR}';
    unsupportedShellExpansion: true;
  };
};

export type McpMessageMatcher =
  | string
  | RegExp
  | ((message: McpTraceMessage) => boolean);
