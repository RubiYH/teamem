#!/usr/bin/env node
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { mkdirSync, renameSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const args = parseArgs(process.argv.slice(2));
const traceRoot =
  process.env.CLAUDE_PLUGIN_E2E_MCP_TRACE_DIR ||
  process.env.CLAUDE_PLUGIN_E2E_FALLBACK_MCP_TRACE_DIR;

if (!traceRoot) {
  process.stderr.write(
    'CLAUDE_PLUGIN_E2E_MCP_TRACE_DIR is required for MCP tracing.\n'
  );
  process.exit(2);
}

if (!args.serverName || !args.commandBase64) {
  process.stderr.write(
    '--server-name and --command-base64 are required for MCP tracing.\n'
  );
  process.exit(2);
}

const originalCommand = Buffer.from(args.commandBase64, 'base64').toString(
  'utf8'
);
const originalArgs = args.argBase64.map((arg) =>
  Buffer.from(arg, 'base64').toString('utf8')
);
const spawnCommand = expandPlaceholders(originalCommand);
const spawnArgs = originalArgs.map((arg) => expandPlaceholders(arg));

const invocationDir = join(
  traceRoot,
  `${Date.now()}-${safeName(args.serverName)}-${randomUUID()}`
);
const stdinPath = join(invocationDir, 'stdin.raw');
const stdoutPath = join(invocationDir, 'stdout.raw');
const stderrPath = join(invocationDir, 'stderr.raw');
const tracePath = join(invocationDir, 'trace.json');
const redactionMode = resolveRedactionMode();
mkdirSync(invocationDir, { recursive: true });

const startedAtMs = Date.now();
const startedAt = new Date(startedAtMs);
const messages = [];
const pendingToolCalls = new Map();
let stdin = '';
let stdout = '';
let stderr = '';
let clientBuffer = '';
let serverBuffer = '';
let spawnError;
let finalized = false;

const child = spawn(spawnCommand, spawnArgs, {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: process.env,
  shell: false
});

process.stdin.on('data', (chunk) => {
  if (finalized) {
    return;
  }
  const text = chunk.toString();
  stdin += text;
  clientBuffer = captureMessages({
    buffer: clientBuffer + text,
    direction: 'client-to-server'
  });
  try {
    child.stdin.write(chunk, (error) => {
      if (error) {
        handleChildStdinError(error);
      }
    });
  } catch (error) {
    handleChildStdinError(error);
  }
});

process.stdin.on('end', () => {
  if (finalized) {
    return;
  }
  try {
    child.stdin.end();
  } catch (error) {
    handleChildStdinError(error);
  }
});

process.stdin.on('error', (error) => {
  stderr += formatError(error);
  finalizeAndExit({
    reason: 'proxy-stdin-error',
    exitCode: 1,
    partial: true,
    killChild: true
  });
});

child.stdout.on('data', (chunk) => {
  const text = chunk.toString();
  stdout += text;
  serverBuffer = captureMessages({
    buffer: serverBuffer + text,
    direction: 'server-to-client'
  });
  process.stdout.write(chunk);
});

child.stderr.on('data', (chunk) => {
  const text = chunk.toString();
  stderr += text;
  process.stderr.write(chunk);
});

child.stdin.on('error', handleChildStdinError);

child.on('error', (error) => {
  spawnError = error;
  stderr += formatError(error);
  finalizeAndExit({
    reason: 'child-error',
    exitCode: 1,
    partial: true,
    killChild: false
  });
});

child.on('close', (exitCode, signal) => {
  const didFinalize = finalizeTrace({
    reason: 'child-close',
    exitCode,
    signal,
    partial: false
  });
  if (didFinalize) {
    process.exit(exitCode ?? (signal ? 1 : 0));
  }
});

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    finalizeAndExit({
      reason: `process-signal:${signal}`,
      exitCode: 128 + signalExitCode(signal),
      signal,
      partial: true,
      killChild: true
    });
  });
}

process.on('exit', (exitCode) => {
  finalizeTrace({
    reason: 'process-exit',
    exitCode,
    signal: null,
    partial: true
  });
});

process.on('uncaughtException', (error) => {
  stderr += formatError(error);
  finalizeAndExit({
    reason: 'uncaught-exception',
    exitCode: 1,
    partial: true,
    killChild: true
  });
});

function handleChildStdinError(error) {
  if (finalized) {
    return;
  }
  stderr += formatError(error);
  finalizeAndExit({
    reason: 'child-stdin-error',
    exitCode: 1,
    partial: true,
    killChild: true
  });
}

function finalizeAndExit({
  reason,
  exitCode,
  signal = null,
  partial,
  killChild
}) {
  const didFinalize = finalizeTrace({ reason, exitCode, signal, partial });
  if (!didFinalize) {
    return;
  }
  if (killChild && child.exitCode === null && child.signalCode === null) {
    child.kill(signal ?? 'SIGTERM');
  }
  process.exit(exitCode);
}

function finalizeTrace({ reason, exitCode = null, signal = null, partial }) {
  if (finalized) {
    return false;
  }
  finalized = true;
  clientBuffer = flushMessageBuffer(clientBuffer, 'client-to-server');
  serverBuffer = flushMessageBuffer(serverBuffer, 'server-to-client');
  writeTrace({ reason, exitCode, signal, partial });

  return true;
}

function writeLiveTrace() {
  if (finalized) {
    return;
  }

  writeTrace({
    reason: 'live-update',
    exitCode: null,
    signal: null,
    partial: true
  });
}

function writeTrace({ reason, exitCode = null, signal = null, partial }) {
  const endedAt = new Date();
  const durationMs = endedAt.getTime() - startedAtMs;
  const artifactStdin = redactText(stdin);
  const artifactStdout = redactText(stdout);
  const artifactStderr = redactText(stderr);

  writeFileAtomicSync(stdinPath, artifactStdin);
  writeFileAtomicSync(stdoutPath, artifactStdout);
  writeFileAtomicSync(stderrPath, artifactStderr);
  writeFileAtomicSync(
    tracePath,
    `${JSON.stringify(
      {
        serverName: args.serverName,
        command: redactText(originalCommand),
        args: originalArgs.map((arg) => redactText(arg)),
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        durationMs,
        exitCode,
        signal,
        partial,
        terminationReason: reason,
        error: spawnError
          ? redactText(formatError(spawnError).trim())
          : undefined,
        stdin: artifactStdin,
        stdout: artifactStdout,
        stderr: artifactStderr,
        messages: redactMessages(messages),
        environment: captureEnvironment(),
        artifacts: {
          tracePath,
          stdinPath,
          stdoutPath,
          stderrPath
        },
        placeholderExpansion: {
          supportedPattern: '${VAR}',
          unsupportedShellExpansion: true
        }
      },
      null,
      2
    )}\n`
  );
}

function writeFileAtomicSync(path, value) {
  const tmpPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tmpPath, value);
  renameSync(tmpPath, path);
}

function parseArgs(argv) {
  const parsed = { argBase64: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === '--server-name') {
      parsed.serverName = value;
      index += 1;
    } else if (key === '--command-base64') {
      parsed.commandBase64 = value;
      index += 1;
    } else if (key === '--arg-base64') {
      parsed.argBase64.push(value);
      index += 1;
    }
  }
  return parsed;
}

function captureMessages({ buffer, direction }) {
  const lines = buffer.split(/\r?\n/);
  const remainder = lines.pop() ?? '';
  for (const line of lines) {
    recordMessage(line, direction);
  }
  return remainder;
}

function flushMessageBuffer(buffer, direction) {
  if (buffer.length > 0) {
    recordMessage(buffer, direction);
  }
  return '';
}

function recordMessage(raw, direction) {
  if (raw.length === 0) {
    return;
  }
  const json = parseJson(raw);
  const method =
    json && typeof json === 'object' && typeof json.method === 'string'
      ? json.method
      : undefined;
  const metadata = extractMessageMetadata(json, direction);
  messages.push({
    serverName: args.serverName,
    direction,
    raw,
    json,
    method,
    metadata,
    timestamp: new Date().toISOString(),
    offsetMs: Date.now() - startedAtMs,
    artifacts: {
      tracePath,
      stdinPath,
      stdoutPath,
      stderrPath
    }
  });
  writeLiveTrace();
}

function extractMessageMetadata(json, direction) {
  if (!json || typeof json !== 'object') {
    return undefined;
  }

  if (
    typeof json.method === 'string' &&
    json.method.startsWith('notifications/')
  ) {
    return {
      notification: {
        method: json.method
      }
    };
  }

  if (
    direction === 'client-to-server' &&
    json.method === 'tools/call' &&
    json.params &&
    typeof json.params === 'object' &&
    typeof json.params.name === 'string'
  ) {
    const metadata = { toolName: json.params.name };
    const requestId = jsonRpcIdKey(json.id);
    if (requestId) {
      pendingToolCalls.set(requestId, metadata);
    }
    return metadata;
  }

  if (direction !== 'server-to-client') {
    return undefined;
  }

  const requestId = jsonRpcIdKey(json.id);
  if (!requestId || !pendingToolCalls.has(requestId)) {
    return undefined;
  }

  const requestMetadata = pendingToolCalls.get(requestId);
  pendingToolCalls.delete(requestId);

  return {
    toolName: requestMetadata.toolName,
    response: summarizeToolResponse(json)
  };
}

function jsonRpcIdKey(value) {
  if (typeof value === 'string' || typeof value === 'number') {
    return `${typeof value}:${String(value)}`;
  }
  return undefined;
}

function summarizeToolResponse(json) {
  const result = isRecord(json.result) ? json.result : undefined;
  const parsedContentText = parseFirstTextContentJson(result);
  const contentTextJsonKeys = objectKeys(parsedContentText);
  const contentTextJsonDataKeys = objectKeys(
    isRecord(parsedContentText?.data) ? parsedContentText.data : undefined
  );
  const hasError = Object.prototype.hasOwnProperty.call(json, 'error');
  const resultIsError = result?.isError === true;
  const contentIsError = parsedContentText?.ok === false;

  return {
    ok: !hasError && !resultIsError && !contentIsError,
    hasResult: Object.prototype.hasOwnProperty.call(json, 'result'),
    hasError,
    isError: resultIsError || contentIsError,
    resultKeys: objectKeys(result),
    structuredContentKeys: objectKeys(
      isRecord(result?.structuredContent) ? result.structuredContent : undefined
    ),
    contentTextJsonKeys,
    contentTextJsonDataKeys,
    errorKeys: objectKeys(isRecord(json.error) ? json.error : undefined)
  };
}

function parseFirstTextContentJson(result) {
  if (!result || !Array.isArray(result.content)) {
    return undefined;
  }

  const textBlock = result.content.find(
    (item) =>
      isRecord(item) && item.type === 'text' && typeof item.text === 'string'
  );
  if (!textBlock) {
    return undefined;
  }

  const parsed = parseJson(textBlock.text);
  return isRecord(parsed) ? parsed : undefined;
}

function objectKeys(value) {
  if (!isRecord(value)) {
    return [];
  }
  return Object.keys(value).sort();
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resolveRedactionMode() {
  if (
    process.env.CLAUDE_PLUGIN_E2E_REDACTION_MODE === 'off' &&
    process.env.CLAUDE_PLUGIN_E2E_ALLOW_UNREDACTED === '1'
  ) {
    return 'off';
  }
  return 'safe';
}

function redactMessages(value) {
  if (redactionMode === 'off') {
    return value;
  }
  return value.map((message) => ({
    ...message,
    raw: redactText(message.raw),
    json: redactJson(message.json)
  }));
}

function redactText(value) {
  if (redactionMode === 'off') {
    return value;
  }
  return value.length === 0 ? value : '[REDACTED]';
}

function redactJson(value) {
  if (redactionMode === 'off') {
    return value;
  }
  if (typeof value === 'string') {
    return value.length === 0 ? value : '[REDACTED]';
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactJson(item));
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, field]) => [key, redactJson(field)])
  );
}

function captureEnvironment() {
  const keys = [
    'CLAUDE_PLUGIN_ROOT',
    'CLAUDE_PLUGIN_DATA',
    'CLAUDE_SESSION_ID',
    'CLAUDE_PROJECT_DIR'
  ];
  return {
    redactionMode,
    env: Object.fromEntries(
      keys.flatMap((key) => {
        const value = process.env[key];
        if (!value) {
          return [];
        }
        return [[key, redactText(value)]];
      })
    )
  };
}

function expandPlaceholders(value) {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, key) => {
    return process.env[key] ?? '';
  });
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function safeName(value) {
  return value.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '');
}

function formatError(error) {
  return error instanceof Error ? `${error.message}\n` : `${String(error)}\n`;
}

function signalExitCode(signal) {
  return {
    SIGHUP: 1,
    SIGINT: 2,
    SIGTERM: 15
  }[signal];
}
