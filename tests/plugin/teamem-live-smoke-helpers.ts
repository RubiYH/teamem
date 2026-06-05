import { expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AmbiguousSpaceLabelError,
  SessionExpiredError,
  UnknownSpaceError,
  checkJwtExp,
  defaultCredentialsPath,
  loadCredentials,
  pickEntry,
  type CredentialEntry
} from '../../src/bridge/credentials.js';
import type {
  BootResult,
  HookTrace,
  McpInstrumentationOptions,
  McpTrace,
  PromptResult,
  RunArtifacts
} from '../../plugin-e2e-module/src/index.js';

export type RuntimePrerequisite =
  | {
      ok: true;
      selectedEntry: CredentialEntry;
      preflightWhoami: RuntimeWhoamiEvidence;
    }
  | {
      ok: false;
      reason: string;
    };

export type RuntimeWhoamiEvidence = {
  principal: string;
  space_id: string;
  label: string;
};

export type LiveRuntimeToolResponse<TData = unknown> = {
  ok: true;
  data: TData;
};

export const TEAMEM_MCP_ENV_PASSTHROUGH_KEYS = [
  'CLAUDE_PLUGIN_OPTION_DEFAULT_SPACE',
  'TEAMEM_CREDENTIALS',
  'TEAMEM_SPACE',
  'TEAMEM_SPACE_ID',
  'TEAMEM_DEFAULT_SPACE',
  'TEAMEM_CLAUDE_LAUNCH_INTENT',
  'TEAMEM_CLAUDE_LAUNCH_SPACE'
] as const;

export const TEAMEM_MCP_INSTRUMENTATION_OPTIONS = {
  include: ['teamem'],
  mode: 'disable-non-included',
  envPassthroughKeys: [...TEAMEM_MCP_ENV_PASSTHROUGH_KEYS]
} satisfies McpInstrumentationOptions;

const LIVE_INTERACTIVE_SMOKE_LOCK_DIR = join(
  tmpdir(),
  'teamem-live-interactive-smoke.lock'
);
const LIVE_INTERACTIVE_SMOKE_LOCK_TIMEOUT_MS = 15 * 60_000;
const LIVE_INTERACTIVE_SMOKE_LOCK_STALE_MS = 30 * 60_000;

export function initGitRepo(cwd: string): void {
  const init = spawnSync('git', ['init'], {
    cwd,
    encoding: 'utf8'
  });
  expect(init.status).toBe(0);
}

export function createLiveRuntimeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };

  delete env.CLAUDE_PLUGIN_DATA;
  delete env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;

  return env;
}

export async function withLiveInteractiveSmokeLock<T>(
  label: string,
  action: () => Promise<T>
): Promise<T> {
  const lockDir = await acquireLiveInteractiveSmokeLock(label);
  try {
    return await action();
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}

export async function callLiveRuntimeTool<TData = unknown>(
  entry: CredentialEntry,
  toolName: string,
  input: Record<string, unknown> = {},
  timeoutMs = 5_000
): Promise<LiveRuntimeToolResponse<TData>> {
  const baseUrl = entry.server_url.replace(/\/$/, '');
  const url = `${baseUrl}/tools/${toolName}`;
  const response = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${entry.jwt}`
      },
      body: JSON.stringify(input)
    },
    timeoutMs
  );

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok) {
    throw new Error(
      `Teamem runtime ${toolName} returned HTTP ${response.status}: ${formatRuntimeResponseBody(body)}`
    );
  }
  if (!isRuntimeToolResponse<TData>(body)) {
    throw new Error(
      `Teamem runtime ${toolName} returned an unexpected response`
    );
  }

  return body;
}

export async function inspectRuntimePrerequisite(input: {
  liveGateEnabled: boolean;
  gateReason: string;
}): Promise<RuntimePrerequisite> {
  if (!input.liveGateEnabled) {
    return {
      ok: false,
      reason: input.gateReason
    };
  }

  const credentialsPath = defaultCredentialsPath();
  if (!existsSync(credentialsPath)) {
    return {
      ok: false,
      reason: `missing Teamem credentials at ${credentialsPath}; run teamem init or set TEAMEM_CREDENTIALS`
    };
  }

  const credentials = await loadCredentials(credentialsPath);
  if (!credentials) {
    return {
      ok: false,
      reason: `invalid or unsupported Teamem credentials JSON at ${credentialsPath}; run teamem init or set TEAMEM_CREDENTIALS`
    };
  }

  let selectedEntry: CredentialEntry;
  try {
    selectedEntry = pickEntry({
      env: process.env.TEAMEM_SPACE,
      creds: credentials
    });
  } catch (err) {
    return {
      ok: false,
      reason: `${formatCredentialSelectionError(err)} Check ${credentialsPath}, set TEAMEM_SPACE to a valid Space id, or run teamem init.`
    };
  }

  const shapeReason = inspectSelectedEntryShape(selectedEntry);
  if (shapeReason) {
    return {
      ok: false,
      reason: `${shapeReason} in ${credentialsPath}; run teamem init to refresh credentials`
    };
  }

  try {
    checkJwtExp(selectedEntry);
  } catch (err) {
    if (err instanceof SessionExpiredError) {
      return {
        ok: false,
        reason: `${err.message} Refresh credentials with teamem init.`
      };
    }
    throw err;
  }

  const preflightWhoami = await preflightRuntimeWhoami(selectedEntry);
  if (!preflightWhoami.ok) {
    return preflightWhoami;
  }

  return {
    ok: true,
    selectedEntry,
    preflightWhoami: preflightWhoami.data
  };
}

export async function expectOnlyTeamemMcpIsProxied(
  boot: BootResult
): Promise<void> {
  const mcpPath = boot.instrumentedPlugin.mcpPath;
  expect(mcpPath).toBeDefined();

  const config = JSON.parse(await readFile(mcpPath ?? '', 'utf8')) as {
    mcpServers: Record<string, { command: string; args?: string[] }>;
  };
  const proxiedServerNames = Object.entries(config.mcpServers)
    .filter(([, server]) => server.args?.[0]?.includes('mcp-proxy-runner.cjs'))
    .map(([serverName]) => serverName)
    .sort();

  expect(Object.keys(config.mcpServers).sort()).toEqual(['teamem']);
  expect(proxiedServerNames).toEqual(['teamem']);
  expect(config.mcpServers.teamem?.command).toBe(process.execPath);
  expect(config.mcpServers).not.toHaveProperty('teamem-channel');
}

export function assertNoTeamemChannelMcpTrace(
  source: PromptResult | McpTrace[]
): void {
  const traces = Array.isArray(source) ? source : source.mcpTraces;
  expect(traces.some((trace) => trace.serverName === 'teamem-channel')).toBe(
    false
  );
}

export function assertWhoamiMcpEvidence(traces: McpTrace[]): void {
  const teamemTrace = traces.find((trace) => trace.serverName === 'teamem');
  expect(teamemTrace).toBeDefined();

  const toolCall = teamemTrace?.messages.find(
    (message) =>
      message.direction === 'client-to-server' &&
      message.method === 'tools/call'
  );
  expect(toolCall).toBeDefined();
}

export async function assertLaunchDidNotForcePluginData(
  source: PromptResult | RunArtifacts
): Promise<void> {
  const environmentPath =
    'artifacts' in source
      ? source.artifacts.environmentPath
      : source.environmentPath;
  const environment = JSON.parse(await readFile(environmentPath, 'utf8')) as {
    env?: Record<string, string>;
  };

  expect(environment.env ?? {}).not.toHaveProperty('CLAUDE_PLUGIN_DATA');
}

export async function assertTraceArtifactsExist(
  trace: HookTrace | McpTrace
): Promise<void> {
  await expect(stat(trace.artifacts.tracePath)).resolves.toBeTruthy();
  await expect(stat(trace.artifacts.stdinPath)).resolves.toBeTruthy();
  await expect(stat(trace.artifacts.stdoutPath)).resolves.toBeTruthy();
  await expect(stat(trace.artifacts.stderrPath)).resolves.toBeTruthy();
}

export function assertObservedPluginDataIsRedacted(
  trace: HookTrace | McpTrace
): void {
  const observedPluginData = trace.environment?.env.CLAUDE_PLUGIN_DATA;
  if (observedPluginData !== undefined) {
    expect(observedPluginData).toBe('[REDACTED]');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRuntimeToolResponse<TData>(
  value: unknown
): value is LiveRuntimeToolResponse<TData> {
  return isRecord(value) && value.ok === true && 'data' in value;
}

function formatRuntimeResponseBody(body: unknown): string {
  if (typeof body === 'string') return body;
  if (body === null || body === undefined) return String(body);
  try {
    return JSON.stringify(body);
  } catch {
    return String(body);
  }
}

async function acquireLiveInteractiveSmokeLock(label: string): Promise<string> {
  const startedAt = Date.now();
  let lastOwner = '';

  while (Date.now() - startedAt < LIVE_INTERACTIVE_SMOKE_LOCK_TIMEOUT_MS) {
    try {
      await mkdir(LIVE_INTERACTIVE_SMOKE_LOCK_DIR);
      await writeFile(
        join(LIVE_INTERACTIVE_SMOKE_LOCK_DIR, 'owner.json'),
        JSON.stringify(
          {
            label,
            pid: process.pid,
            acquired_at: new Date().toISOString()
          },
          null,
          2
        )
      );
      return LIVE_INTERACTIVE_SMOKE_LOCK_DIR;
    } catch (err) {
      if (!isNodeErrorCode(err, 'EEXIST')) {
        throw err;
      }
    }

    lastOwner = await readFile(
      join(LIVE_INTERACTIVE_SMOKE_LOCK_DIR, 'owner.json'),
      'utf8'
    ).catch(() => '');

    const lockStats = await stat(LIVE_INTERACTIVE_SMOKE_LOCK_DIR).catch(
      () => undefined
    );
    if (
      lockStats &&
      Date.now() - lockStats.mtimeMs > LIVE_INTERACTIVE_SMOKE_LOCK_STALE_MS
    ) {
      await rm(LIVE_INTERACTIVE_SMOKE_LOCK_DIR, {
        recursive: true,
        force: true
      });
      continue;
    }

    await delay(500);
  }

  throw new Error(
    `Timed out waiting for live interactive smoke lock for ${label}. Last owner: ${
      lastOwner.trim() || 'unknown'
    }`
  );
}

function isNodeErrorCode(err: unknown, code: string): boolean {
  return (
    err instanceof Error &&
    'code' in err &&
    (err as NodeJS.ErrnoException).code === code
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatCredentialSelectionError(err: unknown): string {
  if (err instanceof AmbiguousSpaceLabelError) {
    return err.message;
  }
  if (err instanceof UnknownSpaceError) {
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

function inspectSelectedEntryShape(entry: CredentialEntry): string | undefined {
  const record = entry as unknown as Record<string, unknown>;
  for (const key of ['space_id', 'label', 'server_url', 'jwt', 'member_name']) {
    if (typeof record[key] !== 'string' || record[key] === '') {
      return `selected Teamem Space is missing ${key}`;
    }
  }
  if (typeof record.jwt_exp !== 'number') {
    return 'selected Teamem Space is missing jwt_exp';
  }
  return undefined;
}

async function preflightRuntimeWhoami(entry: CredentialEntry): Promise<
  | { ok: true; data: RuntimeWhoamiEvidence }
  | {
      ok: false;
      reason: string;
    }
> {
  const baseUrl = entry.server_url.replace(/\/$/, '');
  const url = `${baseUrl}/tools/teamem.whoami`;
  let response: Response;
  try {
    response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${entry.jwt}`
      },
      body: JSON.stringify({})
    });
  } catch (err) {
    return {
      ok: false,
      reason: `Teamem runtime at ${baseUrl} is unreachable (${formatPreflightError(err)}); start the runtime, check server_url, or refresh credentials`
    };
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok) {
    return {
      ok: false,
      reason: `Teamem runtime preflight ${url} returned HTTP ${response.status}; refresh stale credentials or check TEAMEM_SPACE/server_url`
    };
  }

  if (!isWhoamiResponse(body)) {
    return {
      ok: false,
      reason: `Teamem runtime preflight ${url} returned an unexpected whoami response; check runtime version and credentials`
    };
  }

  return { ok: true, data: body.data };
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = 5_000
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function formatPreflightError(err: unknown): string {
  if (err instanceof Error && err.name === 'AbortError') {
    return 'timed out after 5000ms';
  }
  return err instanceof Error ? err.message : String(err);
}

function isWhoamiResponse(
  value: unknown
): value is { ok: true; data: RuntimeWhoamiEvidence } {
  if (!isRecord(value) || value.ok !== true || !isRecord(value.data)) {
    return false;
  }
  return (
    typeof value.data.principal === 'string' &&
    typeof value.data.space_id === 'string' &&
    typeof value.data.label === 'string'
  );
}
