import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
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
import {
  createClaudePluginTester,
  type BootResult,
  type HookTrace,
  type McpTrace,
  type PromptResult
} from '../../plugin-e2e-module/src/index.js';

const liveGateEnabled = process.env.TEAMEM_CLAUDE_PLUGIN_E2E === '1';
const runtimePrerequisite = await inspectRuntimePrerequisite();
const describeLiveRuntime =
  liveGateEnabled && runtimePrerequisite.ok ? describe : describe.skip;

const repoRoot = process.cwd();
const teamemPluginDir = join(repoRoot, 'plugin');

describeLiveRuntime(
  `Teamem runtime whoami live smoke${runtimePrerequisite.ok ? '' : ` (${runtimePrerequisite.reason})`}`,
  () => {
    it('invokes /teamem-whoami through the core Teamem MCP proxy', async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'teamem-whoami-cwd-'));
      const artifactsDir = await mkdtemp(
        join(tmpdir(), 'teamem-whoami-artifacts-')
      );
      let success = false;

      try {
        initGitRepo(cwd);

        const tester = createClaudePluginTester({
          pluginDir: teamemPluginDir,
          cwd,
          artifactsDir,
          cleanup: 'never',
          mcp: { include: ['teamem'], mode: 'disable-non-included' },
          env: createLiveRuntimeEnv(),
          timeouts: {
            headlessRunMs: 120_000
          }
        });
        const boot = await tester.boot();

        await expectOnlyTeamemMcpIsProxied(boot);

        const commandPrompt = await tester.slashCommandPrompt('teamem-whoami');
        expect(commandPrompt).toContain('teamem-whoami');
        expect(commandPrompt).not.toContain('teamem-status');

        const result = await tester.prompt(commandPrompt, {
          allowedTools: ['mcp__teamem__whoami'],
          disallowedTools: [
            'mcp__teamem__get_current_sprint',
            'mcp__teamem__list_claims',
            'mcp__teamem__get_briefing'
          ],
          maxTurns: 3
        });

        expect(result.exitCode).toBe(0);
        expect(result.expectText(/^principal:\s+\S+/m)).toBe(result);
        expect(result.expectText(/^space_id:\s+\S+/m)).toBe(result);
        expect(result.expectText(/^label:\s+.*$/m)).toBe(result);
        expect(result.prompt).not.toContain('teamem-status');
        assertNoTeamemChannelMcpTrace(result);
        assertWhoamiMcpEvidence(result);
        await assertLaunchDidNotForcePluginData(result);
        await assertProxyTraceEvidence(result);
        success = true;
      } finally {
        if (success) {
          await rm(artifactsDir, { recursive: true, force: true });
          await rm(cwd, { recursive: true, force: true });
        } else {
          console.error(
            `Preserving failed live smoke artifacts at ${artifactsDir} and cwd ${cwd}`
          );
        }
      }
    });
  }
);

type RuntimePrerequisite =
  | { ok: true }
  | {
      ok: false;
      reason: string;
    };

async function inspectRuntimePrerequisite(): Promise<RuntimePrerequisite> {
  if (!liveGateEnabled) {
    return {
      ok: false,
      reason: 'set TEAMEM_CLAUDE_PLUGIN_E2E=1 to run live Claude plugin tests'
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

  return preflightRuntimeWhoami(selectedEntry);
}

function initGitRepo(cwd: string): void {
  const init = spawnSync('git', ['init'], {
    cwd,
    encoding: 'utf8'
  });
  expect(init.status).toBe(0);
}

function createLiveRuntimeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };

  delete env.CLAUDE_PLUGIN_DATA;

  return env;
}

async function expectOnlyTeamemMcpIsProxied(boot: BootResult): Promise<void> {
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

function assertWhoamiMcpEvidence(result: PromptResult): void {
  const teamemTrace = result.mcpTraces.find(
    (trace) => trace.serverName === 'teamem'
  );
  expect(teamemTrace).toBeDefined();

  const toolCall = teamemTrace?.messages.find(
    (message) =>
      message.direction === 'client-to-server' &&
      message.method === 'tools/call'
  );
  expect(toolCall).toBeDefined();
}

async function assertLaunchDidNotForcePluginData(
  result: PromptResult
): Promise<void> {
  const environment = JSON.parse(
    await readFile(result.artifacts.environmentPath, 'utf8')
  ) as { env?: Record<string, string> };

  expect(environment.env ?? {}).not.toHaveProperty('CLAUDE_PLUGIN_DATA');
}

async function assertProxyTraceEvidence(result: PromptResult): Promise<void> {
  const sessionStart = result.expectHook('SessionStart');
  expect(sessionStart.exitCode).toBe(0);
  await assertTraceArtifactsExist(sessionStart);
  assertObservedPluginDataIsRedacted(sessionStart);

  const teamemTrace = result.mcpTraces.find(
    (trace) => trace.serverName === 'teamem'
  );
  expect(teamemTrace).toBeDefined();
  if (teamemTrace) {
    await assertMcpTraceArtifactsExist(teamemTrace);
    assertObservedPluginDataIsRedacted(teamemTrace);
  }
}

async function assertTraceArtifactsExist(trace: HookTrace): Promise<void> {
  await expect(stat(trace.artifacts.tracePath)).resolves.toBeTruthy();
  await expect(stat(trace.artifacts.stdinPath)).resolves.toBeTruthy();
  await expect(stat(trace.artifacts.stdoutPath)).resolves.toBeTruthy();
  await expect(stat(trace.artifacts.stderrPath)).resolves.toBeTruthy();
}

async function assertMcpTraceArtifactsExist(trace: McpTrace): Promise<void> {
  await expect(stat(trace.artifacts.tracePath)).resolves.toBeTruthy();
  await expect(stat(trace.artifacts.stdinPath)).resolves.toBeTruthy();
  await expect(stat(trace.artifacts.stdoutPath)).resolves.toBeTruthy();
  await expect(stat(trace.artifacts.stderrPath)).resolves.toBeTruthy();
}

function assertObservedPluginDataIsRedacted(trace: HookTrace | McpTrace): void {
  const observedPluginData = trace.environment?.env.CLAUDE_PLUGIN_DATA;
  if (observedPluginData !== undefined) {
    expect(observedPluginData).toBe('[REDACTED]');
  }
}

function assertNoTeamemChannelMcpTrace(result: PromptResult): void {
  expect(
    result.mcpTraces.some((trace) => trace.serverName === 'teamem-channel')
  ).toBe(false);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
  for (const key of [
    'space_id',
    'label',
    'server_url',
    'jwt',
    'member_name'
  ]) {
    if (typeof record[key] !== 'string' || record[key] === '') {
      return `selected Teamem Space is missing ${key}`;
    }
  }
  if (typeof record.jwt_exp !== 'number') {
    return 'selected Teamem Space is missing jwt_exp';
  }
  return undefined;
}

async function preflightRuntimeWhoami(
  entry: CredentialEntry
): Promise<RuntimePrerequisite> {
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

  return { ok: true };
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

function isWhoamiResponse(value: unknown): boolean {
  if (!isRecord(value) || value.ok !== true || !isRecord(value.data)) {
    return false;
  }
  return (
    typeof value.data.principal === 'string' &&
    typeof value.data.space_id === 'string' &&
    typeof value.data.label === 'string'
  );
}
