import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TraceAssertionError } from './errors.js';
import type {
  McpMessageMatcher,
  McpTrace,
  McpTraceArtifacts,
  McpTraceMessage,
  PromptResult
} from './types.js';

export type ReadMcpTracesOptions = {
  ignoreTransientErrors?: boolean;
};

export async function readMcpTraces(
  traceDir: string,
  options: ReadMcpTracesOptions = {}
): Promise<McpTrace[]> {
  const entries = await readdir(traceDir, { withFileTypes: true }).catch(
    () => []
  );
  const traces = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) =>
        readMcpTrace(join(traceDir, entry.name), options)
      )
  );

  return traces
    .filter((trace): trace is McpTrace => trace !== undefined)
    .sort((left, right) =>
      left.artifacts.tracePath.localeCompare(right.artifacts.tracePath)
    );
}

export function findMcpMessages(
  source: PromptResult | McpTrace[],
  matcher?: McpMessageMatcher
): McpTraceMessage[] {
  const traces = Array.isArray(source) ? source : source.mcpTraces;
  const messages = traces.flatMap((trace) => trace.messages);
  return matcher
    ? messages.filter((message) => matchesMcpMessage(message, matcher))
    : messages;
}

export function expectMcpMethod(
  source: PromptResult | McpTrace[],
  method: string | RegExp
): McpTraceMessage {
  const message = findMcpMessages(source, method).find(
    (candidate) => candidate.method !== undefined
  );
  if (message) {
    return message;
  }

  const traces = Array.isArray(source) ? source : source.mcpTraces;
  const artifactsDir = Array.isArray(source) ? undefined : source.artifacts.dir;
  throw new TraceAssertionError(
    `Expected MCP method was not found: ${formatMatcher(method)}`,
    artifactsDir,
    traces.flatMap((trace) => [
      trace.artifacts.tracePath,
      trace.artifacts.stdinPath,
      trace.artifacts.stdoutPath,
      trace.artifacts.stderrPath
    ])
  );
}

function matchesMcpMessage(
  message: McpTraceMessage,
  matcher: McpMessageMatcher
): boolean {
  if (typeof matcher === 'string') {
    return message.method === matcher;
  }
  if (matcher instanceof RegExp) {
    return matcher.test(message.method ?? '');
  }
  return matcher(message);
}

async function readMcpTrace(
  dir: string,
  options: ReadMcpTracesOptions
): Promise<McpTrace | undefined> {
  const tracePath = join(dir, 'trace.json');
  let raw: string;
  try {
    raw = await readFile(tracePath, 'utf8');
  } catch (error) {
    if (options.ignoreTransientErrors) {
      return undefined;
    }
    throw new Error(
      `Failed to read MCP trace artifact ${tracePath}: ${formatError(error)}`
    );
  }

  if (raw.length === 0) {
    if (options.ignoreTransientErrors) {
      return undefined;
    }
    throw new Error(
      `Failed to parse MCP trace artifact ${tracePath}: empty file`
    );
  }

  let parsed: {
    serverName: string;
    command: string;
    args: string[];
    startedAt: string;
    endedAt: string;
    durationMs: number;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    partial?: boolean;
    terminationReason?: string;
    error?: string;
    stdin?: string;
    stdout: string;
    stderr: string;
    messages: Array<
      Omit<McpTraceMessage, 'artifacts'> & {
        artifacts?: Partial<McpTraceArtifacts>;
      }
    >;
    environment?: McpTrace['environment'];
    artifacts?: Partial<McpTraceArtifacts>;
    placeholderExpansion?: {
      supportedPattern?: '${VAR}';
      unsupportedShellExpansion?: boolean;
    };
  };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch (error) {
    if (options.ignoreTransientErrors) {
      return undefined;
    }
    throw new Error(
      `Failed to parse MCP trace artifact ${tracePath}: ${formatError(error)}`
    );
  }
  const artifacts = {
    tracePath: parsed.artifacts?.tracePath ?? tracePath,
    stdinPath: parsed.artifacts?.stdinPath ?? join(dir, 'stdin.raw'),
    stdoutPath: parsed.artifacts?.stdoutPath ?? join(dir, 'stdout.raw'),
    stderrPath: parsed.artifacts?.stderrPath ?? join(dir, 'stderr.raw')
  };

  return {
    serverName: parsed.serverName,
    command: parsed.command,
    args: parsed.args,
    startedAt: parsed.startedAt,
    endedAt: parsed.endedAt,
    durationMs: parsed.durationMs,
    exitCode: parsed.exitCode,
    signal: parsed.signal,
    partial: parsed.partial ?? false,
    terminationReason: parsed.terminationReason ?? 'child-close',
    error: parsed.error,
    stdin: parsed.stdin ?? '',
    stdout: parsed.stdout,
    stderr: parsed.stderr,
    messages: parsed.messages.map((message) => ({
      ...message,
      artifacts: {
        tracePath: message.artifacts?.tracePath ?? artifacts.tracePath,
        stdinPath: message.artifacts?.stdinPath ?? artifacts.stdinPath,
        stdoutPath: message.artifacts?.stdoutPath ?? artifacts.stdoutPath,
        stderrPath: message.artifacts?.stderrPath ?? artifacts.stderrPath
      }
    })),
    environment: parsed.environment,
    artifacts,
    placeholderExpansion: {
      supportedPattern:
        parsed.placeholderExpansion?.supportedPattern ?? '${VAR}',
      unsupportedShellExpansion: true
    }
  };
}

function formatMatcher(matcher: string | RegExp): string {
  return typeof matcher === 'string' ? matcher : matcher.toString();
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
