import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TraceAssertionError } from './errors.js';
import type { HookTrace, HookTraceMatcher, PromptResult } from './types.js';

export async function readHookTraces(traceDir: string): Promise<HookTrace[]> {
  const entries = await readdir(traceDir, { withFileTypes: true }).catch(
    () => []
  );
  const traces = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => readHookTrace(join(traceDir, entry.name)))
  );

  return traces
    .filter((trace): trace is HookTrace => trace !== undefined)
    .sort((left, right) =>
      left.artifacts.tracePath.localeCompare(right.artifacts.tracePath)
    );
}

export function findHook(
  source: PromptResult | HookTrace[],
  matcher: HookTraceMatcher
): HookTrace | undefined {
  const traces = Array.isArray(source) ? source : source.hookTraces;
  return traces.find((trace) => matchesHook(trace, matcher));
}

export function expectHook(
  source: PromptResult | HookTrace[],
  matcher: HookTraceMatcher
): HookTrace {
  const trace = findHook(source, matcher);
  if (trace) {
    return trace;
  }

  const traces = Array.isArray(source) ? source : source.hookTraces;
  const artifactsDir = Array.isArray(source) ? undefined : source.artifacts.dir;
  throw new TraceAssertionError(
    `Expected hook trace was not found: ${formatMatcher(matcher)}`,
    artifactsDir,
    traces.flatMap((item) => [
      item.artifacts.tracePath,
      item.artifacts.stdinPath,
      item.artifacts.stdoutPath,
      item.artifacts.stderrPath
    ])
  );
}

function matchesHook(trace: HookTrace, matcher: HookTraceMatcher): boolean {
  if (typeof matcher === 'string') {
    return trace.event === matcher;
  }
  if (matcher instanceof RegExp) {
    return matcher.test(trace.event);
  }
  return matcher(trace);
}

async function readHookTrace(dir: string): Promise<HookTrace | undefined> {
  const tracePath = join(dir, 'trace.json');
  const raw = await readFile(tracePath, 'utf8').catch(() => undefined);
  if (!raw) {
    return undefined;
  }

  const parsed = JSON.parse(raw) as {
    event: string;
    stdin: string;
    stdinJson?: unknown;
    stdout: string;
    stderr: string;
    exitCode: number | null;
    durationMs: number;
    environment?: HookTrace['environment'];
    artifacts?: {
      tracePath?: string;
      stdinPath?: string;
      stdoutPath?: string;
      stderrPath?: string;
    };
  };

  return {
    event: parsed.event,
    stdin: parsed.stdin,
    stdinJson: parsed.stdinJson,
    stdout: parsed.stdout,
    stderr: parsed.stderr,
    exitCode: parsed.exitCode,
    durationMs: parsed.durationMs,
    environment: parsed.environment,
    artifacts: {
      tracePath: parsed.artifacts?.tracePath ?? tracePath,
      stdinPath: parsed.artifacts?.stdinPath ?? join(dir, 'stdin.raw'),
      stdoutPath: parsed.artifacts?.stdoutPath ?? join(dir, 'stdout.raw'),
      stderrPath: parsed.artifacts?.stderrPath ?? join(dir, 'stderr.raw')
    }
  };
}

function formatMatcher(matcher: HookTraceMatcher): string {
  if (typeof matcher === 'string') {
    return matcher;
  }
  if (matcher instanceof RegExp) {
    return matcher.toString();
  }
  return '[predicate]';
}
