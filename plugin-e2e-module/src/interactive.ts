import { spawn as spawnPty, type IPty } from '@lydell/node-pty';
import { spawn as spawnChild } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { InteractiveProcessError, InteractiveTimeoutError } from './errors.js';
import { withClaudeArgs } from './command.js';
import { readHookTraces } from './hook-traces.js';
import { materializeRunMcpConfig } from './instrumentation.js';
import { buildClaudeLaunchOptionArgs } from './launch-options.js';
import { readMcpTraces } from './mcp-traces.js';
import { redactArtifactText, type ArtifactManager } from './artifacts.js';
import type {
  HookTrace,
  InstrumentedPlugin,
  InteractiveKey,
  InteractiveLaunchOptions,
  InteractivePtyAdapter,
  InteractivePtyExitEvent,
  InteractivePtyProcess,
  InteractivePtyProcessInfo,
  InteractiveReadinessMatcher,
  InteractiveSession,
  InteractiveSyntheticEvent,
  McpInstrumentationOptions,
  McpTrace,
  NormalizedClaudeCommand,
  RedactionMode,
  RunArtifacts
} from './types.js';

export const DEFAULT_INTERACTIVE_READINESS_TIMEOUT_MS = 60_000;
export const DEFAULT_INTERACTIVE_WAIT_TIMEOUT_MS = 30_000;
export const DEFAULT_INTERACTIVE_CLOSE_TIMEOUT_MS = 10_000;

const DEFAULT_READINESS_MATCHER: InteractiveReadinessMatcher = (transcript) =>
  /\bready\b/i.test(normalizeTranscript(transcript));
const CONTROL_C = '\x03';
const ENTER = '\r';
const PROXY_REDACTION_MODE_ENV = 'CLAUDE_PLUGIN_E2E_REDACTION_MODE';

export const nodePtyAdapter: InteractivePtyAdapter = {
  spawn(request) {
    if (isBunRuntime()) {
      return spawnViaNodePtyBridge(request);
    }

    const pty = spawnPty(request.command, request.args, {
      cwd: request.cwd,
      env: request.env,
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      encoding: 'utf8'
    });
    return adaptNodePty(pty);
  }
};

const NODE_PTY_BRIDGE_PATH = fileURLToPath(
  new URL('./node-pty-bridge.cjs', import.meta.url)
);

export async function launchInteractiveRun(input: {
  artifactManager: ArtifactManager;
  normalized: {
    cwd?: string;
    env: NodeJS.ProcessEnv;
    claudeCommand: NormalizedClaudeCommand;
    interactiveReadinessTimeoutMs: number;
    interactiveWaitTimeoutMs: number;
    interactiveCloseTimeoutMs: number;
    redactionMode: RedactionMode;
    ptyAdapter: InteractivePtyAdapter;
    mcp: McpInstrumentationOptions;
  };
  instrumentedPlugin: InstrumentedPlugin;
  cleanupInstrumentedPlugin: (
    plugin: InstrumentedPlugin,
    success: boolean
  ) => Promise<void>;
  options?: InteractiveLaunchOptions;
}): Promise<InteractiveSession> {
  const artifacts =
    await input.artifactManager.createRunArtifacts('interactive');
  const env = {
    ...input.normalized.env,
    CLAUDE_PLUGIN_E2E_HOOK_TRACE_DIR: artifacts.hookTraceDir,
    CLAUDE_PLUGIN_E2E_FALLBACK_HOOK_TRACE_DIR:
      input.instrumentedPlugin.hookTraceDir,
    CLAUDE_PLUGIN_E2E_MCP_TRACE_DIR: artifacts.mcpTraceDir,
    CLAUDE_PLUGIN_E2E_FALLBACK_MCP_TRACE_DIR:
      input.instrumentedPlugin.mcpTraceDir,
    [PROXY_REDACTION_MODE_ENV]: input.normalized.redactionMode,
    ...(input.normalized.redactionMode === 'off' &&
    process.env.CLAUDE_PLUGIN_E2E_ALLOW_UNREDACTED === '1'
      ? { CLAUDE_PLUGIN_E2E_ALLOW_UNREDACTED: '1' }
      : {})
  };
  const launchPlugin = await materializeRunMcpConfig({
    instrumentedPlugin: input.instrumentedPlugin,
    artifacts,
    env,
    redactionMode: input.normalized.redactionMode,
    envPassthroughKeys: input.normalized.mcp.envPassthroughKeys
  });
  const command = withClaudeArgs(input.normalized.claudeCommand, [
    '--plugin-dir',
    input.instrumentedPlugin.pluginDir,
    ...buildClaudeLaunchOptionArgs(input.options, launchPlugin)
  ]);
  const readinessTimeoutMs =
    input.options?.readinessTimeoutMs ??
    input.normalized.interactiveReadinessTimeoutMs;
  const waitTimeoutMs =
    input.options?.waitTimeoutMs ?? input.normalized.interactiveWaitTimeoutMs;
  const closeTimeoutMs =
    input.options?.closeTimeoutMs ?? input.normalized.interactiveCloseTimeoutMs;
  const readiness = input.options?.readiness ?? DEFAULT_READINESS_MATCHER;
  const startedAt = new Date();
  const startNs = process.hrtime.bigint();
  let pty: InteractivePtyProcess | undefined;

  try {
    await input.artifactManager.writeRunBaseline(
      artifacts,
      input.normalized.env
    );
    pty = input.normalized.ptyAdapter.spawn({
      command: command.command,
      args: command.args,
      cwd: input.normalized.cwd,
      env
    });
  } catch (error) {
    await writeInteractiveArtifacts({
      artifactManager: input.artifactManager,
      artifacts,
      command,
      cwd: input.normalized.cwd,
      startedAt,
      endedAt: new Date(),
      durationMs: Number(process.hrtime.bigint() - startNs) / 1_000_000,
      rawTranscript: '',
      events: [],
      hookTraces: [],
      mcpTraces: [],
      exitStatus: {
        exitCode: null,
        errorCode: 'SPAWN_FAILED'
      },
      redactionMode: input.normalized.redactionMode,
      redactionValues: []
    });
    await input.artifactManager.cleanupRun(artifacts, false);
    await input.cleanupInstrumentedPlugin(input.instrumentedPlugin, false);
    throw new InteractiveProcessError(
      `Interactive Claude launch failed: ${formatUnknownError(error)}. Artifacts: ${artifacts.dir}`
    );
  }

  const state = createInteractiveState(pty);

  try {
    await waitForMatcher({
      state,
      matcher: readiness,
      timeoutMs: readinessTimeoutMs,
      timeoutMessage: `Interactive Claude readiness timed out after ${readinessTimeoutMs}ms. Artifacts: ${artifacts.dir}`
    });
    state.events.push({
      type: 'ready',
      timestamp: new Date().toISOString(),
      timeoutMs: readinessTimeoutMs
    });
  } catch (error) {
    if (!state.exit) {
      try {
        state.pty.kill();
      } catch {
        // Preserve the readiness failure as the reported error.
      }
    }
    await finalizeInteractiveSession({
      artifactManager: input.artifactManager,
      artifacts,
      command,
      cwd: input.normalized.cwd,
      startedAt,
      startNs,
      state,
      exitStatus: {
        exitCode: state.exit?.exitCode ?? null,
        signal: state.exit?.signal,
        errorCode: 'READINESS_TIMEOUT'
      },
      redactionMode: input.normalized.redactionMode
    });
    await input.artifactManager.cleanupRun(artifacts, false);
    await input.cleanupInstrumentedPlugin(input.instrumentedPlugin, false);
    if (error instanceof InteractiveTimeoutError) {
      throw error;
    }
    throw new InteractiveProcessError(
      `Interactive Claude readiness failed: ${formatUnknownError(error)}. Artifacts: ${artifacts.dir}`
    );
  }

  const session: InteractiveSession = {
    kind: 'interactive',
    command,
    cwd: input.normalized.cwd,
    artifacts,
    rawTranscript() {
      return state.rawTranscript;
    },
    normalizedTranscript() {
      return normalizeTranscript(state.rawTranscript);
    },
    events() {
      return [...state.events];
    },
    async waitFor(matcher, options = {}) {
      await waitForMatcher({
        state,
        matcher,
        timeoutMs: options.timeoutMs ?? waitTimeoutMs,
        timeoutMessage: `Interactive wait timed out after ${
          options.timeoutMs ?? waitTimeoutMs
        }ms. Artifacts: ${artifacts.dir}`
      });
    },
    async type(text, options = {}) {
      await writeToPty(state, text, 'type', options.delayMs);
    },
    async press(key) {
      await writeToPty(state, keyToBytes(key), 'press');
    },
    async submit(text, options = {}) {
      await writeToPty(state, text, 'submit', options.delayMs);
      await writeToPty(state, ENTER, 'submit');
    },
    async close() {
      if (state.closed) {
        return;
      }

      const closedSuccessfully = await closeInteractivePty(
        state,
        closeTimeoutMs
      );
      await finalizeInteractiveSession({
        artifactManager: input.artifactManager,
        artifacts,
        command,
        cwd: input.normalized.cwd,
        startedAt,
        startNs,
        state,
        exitStatus: {
          exitCode: state.exit?.exitCode ?? null,
          signal: state.exit?.signal,
          ...(closedSuccessfully
            ? {}
            : {
                errorCode: 'CLOSE_TIMEOUT',
                errorReason: `Interactive process did not exit after kill within ${closeTimeoutMs}ms.`
              })
        },
        redactionMode: input.normalized.redactionMode
      });
      state.closed = true;
      await input.artifactManager.cleanupRun(artifacts, closedSuccessfully);
      await input.cleanupInstrumentedPlugin(
        input.instrumentedPlugin,
        closedSuccessfully
      );

      if (!closedSuccessfully) {
        throw new InteractiveProcessError(
          `Interactive Claude did not exit after kill within ${closeTimeoutMs}ms. Artifacts: ${artifacts.dir}`
        );
      }
    }
  };

  return session;
}

function adaptNodePty(pty: IPty): InteractivePtyProcess {
  return {
    pid: pty.pid,
    processInfo() {
      return {
        pid: pty.pid,
        pidKind: 'pty',
        ptyPid: pty.pid
      };
    },
    write(data) {
      pty.write(data);
    },
    kill(signal) {
      pty.kill(signal);
    },
    onData(listener) {
      return pty.onData((data) => listener(data));
    },
    onExit(listener) {
      return pty.onExit((event) =>
        listener({
          ...event,
          source: 'pty',
          pid: pty.pid,
          pidKind: 'pty',
          ptyPid: pty.pid
        })
      );
    }
  };
}

function isBunRuntime(): boolean {
  return typeof Bun !== 'undefined';
}

function spawnViaNodePtyBridge(
  request: Parameters<InteractivePtyAdapter['spawn']>[0]
): InteractivePtyProcess {
  const child = spawnChild('node', [NODE_PTY_BRIDGE_PATH], {
    cwd: request.cwd,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const dataListeners = new Set<(data: string) => void>();
  const exitListeners = new Set<(event: InteractivePtyExitEvent) => void>();
  const bridgePid = child.pid ?? -1;
  let ptyPid: number | undefined;
  let stdoutBuffer = '';
  let exited = false;

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdoutBuffer += chunk;
    let newlineIndex = stdoutBuffer.indexOf('\n');

    while (newlineIndex >= 0) {
      const line = stdoutBuffer.slice(0, newlineIndex);
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      handleBridgeLine(line);
      newlineIndex = stdoutBuffer.indexOf('\n');
    }
  });

  child.on('exit', (exitCode, signal) => {
    if (!exited) {
      emitExit({
        exitCode: exitCode ?? 1,
        source: 'bridge',
        pid: bridgePid,
        pidKind: 'bridge',
        bridgePid,
        ptyPid,
        bridgeSignal: signal
      });
    }
  });

  sendBridgeMessage({
    type: 'spawn',
    request: {
      command: request.command,
      args: request.args,
      cwd: request.cwd,
      env: request.env
    }
  });

  return {
    pid: bridgePid,
    processInfo() {
      return bridgeProcessInfo();
    },
    write(data) {
      sendBridgeMessage({
        type: 'write',
        data: Buffer.isBuffer(data) ? data.toString('utf8') : data
      });
    },
    kill(signal) {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }

      sendBridgeMessage({ type: 'kill', signal });
      if (signal) {
        child.kill(signal as NodeJS.Signals);
      }
    },
    forceKill(signal = 'SIGKILL') {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }

      sendBridgeMessage({ type: 'force-kill', signal });
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
        }
      }, 100).unref();
    },
    onData(listener) {
      dataListeners.add(listener);
      return {
        dispose: () => dataListeners.delete(listener)
      };
    },
    onExit(listener) {
      exitListeners.add(listener);
      return {
        dispose: () => exitListeners.delete(listener)
      };
    }
  };

  function handleBridgeLine(line: string): void {
    if (!line) {
      return;
    }

    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }

    if (!isRecord(message)) {
      return;
    }

    if (message.type === 'data' && typeof message.data === 'string') {
      for (const listener of dataListeners) {
        listener(message.data);
      }
      return;
    }

    if (message.type === 'spawned' && typeof message.pid === 'number') {
      ptyPid = message.pid;
      return;
    }

    if (message.type === 'exit') {
      const messagePid = typeof message.pid === 'number' ? message.pid : ptyPid;
      if (typeof messagePid === 'number') {
        ptyPid = messagePid;
      }
      emitExit({
        exitCode: typeof message.exitCode === 'number' ? message.exitCode : 0,
        signal: typeof message.signal === 'number' ? message.signal : undefined,
        source: message.source === 'bridge' ? 'bridge' : 'pty',
        pid:
          message.source === 'bridge' ? bridgePid : (messagePid ?? bridgePid),
        pidKind: message.source === 'bridge' ? 'bridge' : 'pty',
        bridgePid,
        ptyPid
      });
    }
  }

  function emitExit(event: InteractivePtyExitEvent): void {
    if (exited) {
      return;
    }

    exited = true;
    for (const listener of exitListeners) {
      listener(event);
    }
  }

  function bridgeProcessInfo(): InteractivePtyProcessInfo {
    if (typeof ptyPid === 'number') {
      return {
        pid: ptyPid,
        pidKind: 'pty',
        bridgePid,
        ptyPid
      };
    }

    return {
      pid: bridgePid,
      pidKind: 'bridge',
      bridgePid
    };
  }

  function sendBridgeMessage(message: unknown): void {
    if (child.stdin.destroyed) {
      return;
    }

    child.stdin.write(`${JSON.stringify(message)}\n`);
  }
}

function createInteractiveState(pty: InteractivePtyProcess): {
  pty: InteractivePtyProcess;
  rawTranscript: string;
  events: InteractiveSyntheticEvent[];
  redactionValues: string[];
  exit?: InteractivePtyExitEvent;
  closed: boolean;
  dataDisposer: { dispose(): void };
  exitDisposer: { dispose(): void };
} {
  const state = {
    pty,
    rawTranscript: '',
    events: [] as InteractiveSyntheticEvent[],
    redactionValues: [] as string[],
    exit: undefined as InteractivePtyExitEvent | undefined,
    closed: false,
    dataDisposer: { dispose() {} },
    exitDisposer: { dispose() {} }
  };

  state.dataDisposer = pty.onData((data) => {
    state.rawTranscript += data;
    state.events.push({
      type: 'output',
      timestamp: new Date().toISOString(),
      data
    });
  });
  state.exitDisposer = pty.onExit((event) => {
    const processInfo = pty.processInfo?.();
    const normalizedExit = {
      ...event,
      source: event.source ?? 'pty',
      pid: event.pid ?? processInfo?.pid,
      pidKind: event.pidKind ?? processInfo?.pidKind,
      bridgePid: event.bridgePid ?? processInfo?.bridgePid,
      ptyPid: event.ptyPid ?? processInfo?.ptyPid
    };

    state.exit = normalizedExit;
    state.events.push({
      type: 'exit',
      timestamp: new Date().toISOString(),
      exitCode: normalizedExit.exitCode,
      signal: normalizedExit.signal,
      source: normalizedExit.source,
      pid: normalizedExit.pid,
      pidKind: normalizedExit.pidKind,
      bridgePid: normalizedExit.bridgePid,
      ptyPid: normalizedExit.ptyPid
    });
  });

  return state;
}

async function waitForMatcher(input: {
  state: ReturnType<typeof createInteractiveState>;
  matcher: InteractiveReadinessMatcher;
  timeoutMs: number;
  timeoutMessage: string;
}): Promise<void> {
  if (matches(input.matcher, input.state.rawTranscript)) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new InteractiveTimeoutError(input.timeoutMessage));
    }, input.timeoutMs);
    const dataDisposer = input.state.pty.onData(() => {
      if (matches(input.matcher, input.state.rawTranscript)) {
        cleanup();
        resolve();
      }
    });
    const exitDisposer = input.state.pty.onExit((event) => {
      cleanup();
      reject(
        new InteractiveProcessError(
          `Interactive Claude exited before readiness with status ${event.exitCode}.`
        )
      );
    });

    function cleanup(): void {
      clearTimeout(timeout);
      dataDisposer.dispose();
      exitDisposer.dispose();
    }
  });
}

function matches(
  matcher: InteractiveReadinessMatcher,
  transcript: string
): boolean {
  if (typeof matcher === 'string') {
    return transcript.includes(matcher);
  }
  if (matcher instanceof RegExp) {
    return matcher.test(transcript);
  }
  return matcher(transcript);
}

async function writeToPty(
  state: ReturnType<typeof createInteractiveState>,
  text: string,
  source: 'type' | 'press' | 'submit' | 'close',
  delayMs = 0
): Promise<void> {
  if (state.exit) {
    throw new InteractiveProcessError(
      `Cannot write to exited interactive process ${state.pty.pid}.`
    );
  }

  if (source !== 'close') {
    recordRedactionValue(state, text);
  }

  if (delayMs > 0) {
    for (const char of text) {
      writeImmediate(state, char, source);
      await delay(delayMs);
    }
    return;
  }

  writeImmediate(state, text, source);
}

function recordRedactionValue(
  state: ReturnType<typeof createInteractiveState>,
  value: string
): void {
  if (!/\S/.test(value) || !/[^\x00-\x1f\x7f]/.test(value)) {
    return;
  }

  if (!state.redactionValues.includes(value)) {
    state.redactionValues.push(value);
  }
}

function writeImmediate(
  state: ReturnType<typeof createInteractiveState>,
  data: string,
  source: 'type' | 'press' | 'submit' | 'close'
): void {
  state.pty.write(data);
  state.events.push({
    type: 'input',
    timestamp: new Date().toISOString(),
    data,
    source
  });
}

async function closeInteractivePty(
  state: ReturnType<typeof createInteractiveState>,
  closeTimeoutMs: number
): Promise<boolean> {
  if (state.exit) {
    return isCleanPtyExit(state.exit);
  }

  state.events.push({
    type: 'close-step',
    timestamp: new Date().toISOString(),
    step: 'exit-command'
  });
  if (
    (await tryCloseWrite(state, `/exit${ENTER}`, 'exit-command')) &&
    (await waitForExit(state, closeTimeoutMs))
  ) {
    return true;
  }

  state.events.push({
    type: 'close-step',
    timestamp: new Date().toISOString(),
    step: 'ctrl-c'
  });
  if (
    (await tryCloseWrite(state, CONTROL_C, 'ctrl-c')) &&
    (await waitForExit(state, closeTimeoutMs))
  ) {
    return true;
  }

  state.events.push({
    type: 'close-step',
    timestamp: new Date().toISOString(),
    step: 'kill'
  });
  tryKillPty(state, 'kill');
  if (await waitForExit(state, closeTimeoutMs)) {
    return true;
  }

  if (typeof state.pty.forceKill !== 'function') {
    return false;
  }

  state.events.push({
    type: 'close-step',
    timestamp: new Date().toISOString(),
    step: 'force-kill'
  });
  tryKillPty(state, 'force-kill', 'SIGKILL');
  return waitForExit(state, closeTimeoutMs);
}

async function tryCloseWrite(
  state: ReturnType<typeof createInteractiveState>,
  data: string,
  step: 'exit-command' | 'ctrl-c'
): Promise<boolean> {
  try {
    await writeToPty(state, data, 'close');
    recordCloseDiagnostic(state, {
      step,
      ok: true
    });
    return true;
  } catch (error) {
    recordCloseDiagnostic(state, {
      step,
      ok: false,
      error: formatUnknownError(error)
    });
    return false;
  }
}

function tryKillPty(
  state: ReturnType<typeof createInteractiveState>,
  step: 'kill' | 'force-kill',
  signal?: string
): void {
  try {
    if (step === 'force-kill') {
      state.pty.forceKill?.(signal);
    } else {
      state.pty.kill(signal);
    }
    recordCloseDiagnostic(state, {
      step,
      ok: true,
      signal
    });
  } catch (error) {
    recordCloseDiagnostic(state, {
      step,
      ok: false,
      signal,
      error: formatUnknownError(error)
    });
  }
}

function recordCloseDiagnostic(
  state: ReturnType<typeof createInteractiveState>,
  diagnostic: {
    step: 'exit-command' | 'ctrl-c' | 'kill' | 'force-kill';
    ok: boolean;
    signal?: string;
    error?: string;
  }
): void {
  const processInfo = state.pty.processInfo?.() ?? {
    pid: state.pty.pid,
    pidKind: 'pty' as const,
    ptyPid: state.pty.pid
  };

  state.events.push({
    type: 'close-diagnostic',
    timestamp: new Date().toISOString(),
    pid: processInfo.pid,
    pidKind: processInfo.pidKind,
    bridgePid: processInfo.bridgePid,
    ptyPid: processInfo.ptyPid,
    ...diagnostic
  });
}

async function waitForExit(
  state: ReturnType<typeof createInteractiveState>,
  timeoutMs: number
): Promise<boolean> {
  if (state.exit) {
    return isCleanPtyExit(state.exit);
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      disposer.dispose();
      resolve(false);
    }, timeoutMs);
    const disposer = state.pty.onExit(() => {
      clearTimeout(timeout);
      disposer.dispose();
      resolve(state.exit ? isCleanPtyExit(state.exit) : false);
    });
  });
}

function isCleanPtyExit(event: InteractivePtyExitEvent): boolean {
  return event.source !== 'bridge';
}

async function finalizeInteractiveSession(input: {
  artifactManager: ArtifactManager;
  artifacts: RunArtifacts;
  command: NormalizedClaudeCommand;
  cwd?: string;
  startedAt: Date;
  startNs: bigint;
  state: ReturnType<typeof createInteractiveState>;
  exitStatus: {
    exitCode: number | null;
    signal?: number;
    errorCode?: string;
    errorReason?: string;
  };
  redactionMode: RedactionMode;
}): Promise<void> {
  input.state.dataDisposer.dispose();
  input.state.exitDisposer.dispose();
  const endedAt = new Date();
  const durationMs =
    Number(process.hrtime.bigint() - input.startNs) / 1_000_000;
  const [hookTraces, mcpTraces] = await Promise.all([
    readHookTraces(input.artifacts.hookTraceDir),
    readMcpTraces(input.artifacts.mcpTraceDir)
  ]);

  await writeInteractiveArtifacts({
    artifactManager: input.artifactManager,
    artifacts: input.artifacts,
    command: input.command,
    cwd: input.cwd,
    startedAt: input.startedAt,
    endedAt,
    durationMs,
    rawTranscript: input.state.rawTranscript,
    events: input.state.events,
    hookTraces,
    mcpTraces,
    exitStatus: input.exitStatus,
    redactionMode: input.redactionMode,
    redactionValues: input.state.redactionValues
  });
}

async function writeInteractiveArtifacts(input: {
  artifactManager: ArtifactManager;
  artifacts: RunArtifacts;
  command: NormalizedClaudeCommand;
  cwd?: string;
  startedAt: Date;
  endedAt: Date;
  durationMs: number;
  rawTranscript: string;
  events: InteractiveSyntheticEvent[];
  hookTraces: HookTrace[];
  mcpTraces: McpTrace[];
  exitStatus: {
    exitCode: number | null;
    signal?: number;
    errorCode?: string;
    errorReason?: string;
  };
  redactionMode: RedactionMode;
  redactionValues: string[];
}): Promise<void> {
  const rawTranscript = redactInteractiveText(
    input.rawTranscript,
    input.redactionMode,
    input.redactionValues
  );
  const normalizedTranscript = normalizeTranscript(rawTranscript);
  const events = redactInteractiveEvents(
    input.events,
    input.redactionMode,
    input.redactionValues
  );
  await Promise.all([
    input.artifactManager.writeTextArtifact(
      input.artifacts.rawTranscriptPath,
      rawTranscript
    ),
    input.artifactManager.writeTextArtifact(
      input.artifacts.normalizedTranscriptPath,
      normalizedTranscript
    ),
    input.artifactManager.writeJsonArtifact(
      input.artifacts.interactiveEventsPath,
      events
    ),
    input.artifactManager.writeJsonArtifact(
      input.artifacts.summaryPath,
      createInteractiveSummary({
        ...input,
        rawTranscript,
        events,
        normalizedTranscript
      })
    )
  ]);
}

function createInteractiveSummary(input: {
  artifacts: RunArtifacts;
  command: NormalizedClaudeCommand;
  cwd?: string;
  startedAt: Date;
  endedAt: Date;
  durationMs: number;
  rawTranscript: string;
  normalizedTranscript: string;
  events: InteractiveSyntheticEvent[];
  hookTraces: HookTrace[];
  mcpTraces: McpTrace[];
  exitStatus: {
    exitCode: number | null;
    signal?: number;
    errorCode?: string;
    errorReason?: string;
  };
}): unknown {
  return {
    runId: input.artifacts.runId,
    kind: 'interactive',
    command: {
      command: input.command.command,
      args: input.command.args
    },
    cwd: input.cwd,
    exitStatus: input.exitStatus,
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
      rawTranscriptPath: input.artifacts.rawTranscriptPath,
      normalizedTranscriptPath: input.artifacts.normalizedTranscriptPath,
      interactiveEventsPath: input.artifacts.interactiveEventsPath,
      debugLogPath: input.artifacts.debugLogPath,
      hookTraceDir: input.artifacts.hookTraceDir,
      mcpTraceDir: input.artifacts.mcpTraceDir
    },
    result: {
      rawTranscriptBytes: Buffer.byteLength(input.rawTranscript),
      normalizedTranscriptBytes: Buffer.byteLength(input.normalizedTranscript),
      eventCount: input.events.length,
      hookTraceCount: input.hookTraces.length,
      mcpTraceCount: input.mcpTraces.length,
      closeDiagnostics: input.events.filter(
        (event) =>
          event.type === 'close-step' || event.type === 'close-diagnostic'
      )
    }
  };
}

export function normalizeTranscript(value: string): string {
  return value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
}

function redactInteractiveText(
  value: string,
  mode: RedactionMode,
  redactionValues: string[]
): string {
  if (mode === 'off') {
    return value;
  }

  void redactionValues;
  return redactArtifactText(value, mode);
}

function redactInteractiveEvents(
  events: InteractiveSyntheticEvent[],
  mode: RedactionMode,
  redactionValues: string[]
): InteractiveSyntheticEvent[] {
  if (mode === 'off') {
    return events;
  }

  return events.map((event) => {
    if (event.type === 'input') {
      return event.source === 'close'
        ? event
        : {
            ...event,
            data: '[REDACTED]'
          };
    }

    if (event.type === 'output') {
      return {
        ...event,
        data: redactInteractiveText(event.data, mode, redactionValues)
      };
    }

    return event;
  });
}

function keyToBytes(key: InteractiveKey | string): string {
  switch (key) {
    case 'enter':
      return ENTER;
    case 'escape':
      return '\x1b';
    case 'tab':
      return '\t';
    case 'backspace':
      return '\x7f';
    case 'ctrl+c':
      return CONTROL_C;
    case 'up':
      return '\x1b[A';
    case 'down':
      return '\x1b[B';
    case 'right':
      return '\x1b[C';
    case 'left':
      return '\x1b[D';
    default:
      return key;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
