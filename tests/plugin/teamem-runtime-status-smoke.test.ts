import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createClaudePluginTester,
  type McpTrace,
  type McpTraceMessage,
  type PromptResult
} from '../../plugin-e2e-module/src/index.js';
import {
  assertLaunchDidNotForcePluginData,
  assertNoTeamemChannelMcpTrace,
  assertObservedPluginDataIsRedacted,
  assertTraceArtifactsExist,
  createLiveRuntimeEnv,
  expectOnlyTeamemMcpIsProxied,
  initGitRepo,
  inspectRuntimePrerequisite,
  TEAMEM_MCP_INSTRUMENTATION_OPTIONS
} from './teamem-live-smoke-helpers.js';

const liveGateEnabled = process.env.TEAMEM_CLAUDE_PLUGIN_E2E === '1';
const runtimePrerequisite = await inspectRuntimePrerequisite({
  liveGateEnabled,
  gateReason:
    'set TEAMEM_CLAUDE_PLUGIN_E2E=1 to run live Claude plugin status smoke'
});
const describeLiveRuntime =
  liveGateEnabled && runtimePrerequisite.ok ? describe : describe.skip;

const repoRoot = process.cwd();
const teamemPluginDir = join(repoRoot, 'plugin');
const LIVE_SMOKE_TEST_TIMEOUT_MS = 180_000;
const statusSlashCommand = '/teamem:teamem-status';
const pluginScopedToolPrefix = 'mcp__plugin_teamem_teamem__teamem_';
const requiredStatusTools = [
  'whoami',
  'get_current_sprint',
  'list_claims',
  'get_briefing'
] as const;
const briefingSectionKeys = [
  'active_claims',
  'recent_decisions',
  'recent_notifications',
  'recent_findings',
  'meta'
] as const;

describeLiveRuntime(
  `Teamem runtime status live smoke${runtimePrerequisite.ok ? '' : ` (${runtimePrerequisite.reason})`}`,
  () => {
    it(
      'invokes /teamem:teamem-status through the core Teamem MCP proxy',
      async () => {
        if (!runtimePrerequisite.ok) {
          throw new Error(runtimePrerequisite.reason);
        }

        const cwd = await mkdtemp(join(tmpdir(), 'teamem-status-cwd-'));
        const artifactsDir = await mkdtemp(
          join(tmpdir(), 'teamem-status-artifacts-')
        );
        let success = false;

        try {
          initGitRepo(cwd);

          const tester = createClaudePluginTester({
            pluginDir: teamemPluginDir,
            cwd,
            artifactsDir,
            cleanup: 'never',
            mcp: TEAMEM_MCP_INSTRUMENTATION_OPTIONS,
            env: createLiveRuntimeEnv(),
            timeouts: {
              headlessRunMs: 120_000
            }
          });
          const boot = await tester.boot();

          expect(boot.plugin.pluginDir).toBe(teamemPluginDir);
          await expectOnlyTeamemMcpIsProxied(boot);

          const commandPrompt =
            await tester.slashCommandPrompt('teamem-status');
          expect(commandPrompt).toBe(statusSlashCommand);

          const result = await tester.prompt(commandPrompt, {
            allowedTools: [
              'Bash(${CLAUDE_PLUGIN_ROOT}/bin/teamem-flag:*)',
              `${pluginScopedToolPrefix}whoami`,
              `${pluginScopedToolPrefix}get_current_sprint`,
              `${pluginScopedToolPrefix}list_claims`,
              `${pluginScopedToolPrefix}get_briefing`
            ],
            disallowedTools: [
              'mcp__plugin_teamem_channel__*',
              'mcp__teamem-channel__*',
              `${pluginScopedToolPrefix}claim_scope`,
              `${pluginScopedToolPrefix}release_scope`,
              `${pluginScopedToolPrefix}force_release`,
              `${pluginScopedToolPrefix}post_message`,
              `${pluginScopedToolPrefix}record_decision`,
              `${pluginScopedToolPrefix}list_sprints`
            ],
            maxTurns: 8
          });

          withArtifactContext(result, () => {
            expect(result.exitCode).toBe(0);
            expect(result.stdout).toMatch(/teamem:\s+(ACTIVE|idle)/);
            expect(result.stdout).toMatch(/monitor:\s+/);
            expect(result.stdout).toContain(
              runtimePrerequisite.preflightWhoami.label
            );
            expect(result.stdout).toContain(
              runtimePrerequisite.preflightWhoami.space_id
            );
            expect(result.stdout).toMatch(/\bmode\b/i);
            expect(result.expectText(/teamem:\s+(ACTIVE|idle)/)).toBe(result);
            expect(
              result.expectText(
                /(active claims|active\/paused claims|recent notifications|recent routed notifications|recent_notifications)/i
              )
            ).toBe(result);
            assertNoTeamemChannelMcpTrace(result);
            assertStatusMcpEvidence(result.mcpTraces, result.artifacts.dir);
          });

          await assertLaunchDidNotForcePluginData(result);
          await assertProxyTraceEvidence(result);
          success = true;
        } catch (err) {
          throw withArtifactError(err, artifactsDir);
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
      },
      LIVE_SMOKE_TEST_TIMEOUT_MS
    );
  }
);

function assertStatusMcpEvidence(
  traces: McpTrace[],
  artifactsDir: string
): void {
  const teamemTrace = traces.find((trace) => trace.serverName === 'teamem');
  if (!teamemTrace) {
    throw new Error(
      `Expected core teamem MCP trace. Artifacts: ${artifactsDir}`
    );
  }

  const toolCalls = teamemTrace.messages.filter(
    (message) =>
      message.direction === 'client-to-server' &&
      message.method === 'tools/call'
  );

  const observedTools: string[] = [];
  for (const [index, message] of toolCalls.entries()) {
    const toolName = message.metadata?.toolName;
    if (!toolName) {
      throw new Error(
        `Expected safe status MCP tools/call name metadata at index ${index}. Artifacts: ${artifactsDir}`
      );
    }
    observedTools.push(toolName);
  }

  const observedStatusTools = observedTools.map((toolName) =>
    normalizeStatusToolName(toolName)
  );
  const unexpectedTools = observedStatusTools.filter(
    (toolName) => !isRequiredStatusTool(toolName)
  );
  if (unexpectedTools.length > 0) {
    throw new Error(
      `Expected only status MCP tools ${requiredStatusTools.join(', ')}, observed unexpected ${unexpectedTools.join(', ')}. Artifacts: ${artifactsDir}`
    );
  }

  const missingRequiredTools = requiredStatusTools.filter(
    (toolName) => !observedStatusTools.includes(toolName)
  );
  if (missingRequiredTools.length > 0) {
    throw new Error(
      `Expected status MCP tool calls for ${missingRequiredTools.join(', ')}. Observed ${observedStatusTools.join(', ') || 'none'}. Artifacts: ${artifactsDir}`
    );
  }

  const listClaimsCount = observedStatusTools.filter(
    (toolName) => toolName === 'list_claims'
  ).length;
  if (listClaimsCount < 1) {
    throw new Error(
      `Expected at least one status MCP list_claims call. Observed ${observedStatusTools.join(', ') || 'none'}. Artifacts: ${artifactsDir}`
    );
  }

  const successfulResponses = observedSuccessfulToolResponses(traces);
  const missingSuccessfulResponses = requiredStatusTools.filter(
    (toolName) => !successfulResponses.includes(toolName)
  );
  if (missingSuccessfulResponses.length > 0) {
    throw new Error(
      `Expected successful status MCP responses for ${missingSuccessfulResponses.join(', ')}. Observed successful responses ${successfulResponses.join(', ') || 'none'}. ${summarizeTeamemResponseMetadata(traces)}. Artifacts: ${artifactsDir}`
    );
  }

  assertStatusResponseShapes(traces, artifactsDir);
}

function normalizeStatusToolName(toolName: string): string {
  if (toolName.startsWith(pluginScopedToolPrefix)) {
    return toolName.slice(pluginScopedToolPrefix.length);
  }
  if (toolName.startsWith('mcp__teamem__teamem_')) {
    return toolName.slice('mcp__teamem__teamem_'.length);
  }
  if (toolName.startsWith('mcp__teamem__')) {
    return toolName.slice('mcp__teamem__'.length);
  }
  if (toolName.startsWith('teamem.')) {
    return toolName.slice('teamem.'.length);
  }
  if (toolName.startsWith('teamem_')) {
    return toolName.slice('teamem_'.length);
  }
  return toolName;
}

function isRequiredStatusTool(
  toolName: string
): toolName is (typeof requiredStatusTools)[number] {
  return requiredStatusTools.includes(
    toolName as (typeof requiredStatusTools)[number]
  );
}

function observedSuccessfulToolResponses(traces: McpTrace[]): string[] {
  return successfulToolResponseMessages(traces).map((message) =>
    normalizeStatusToolName(message.metadata?.toolName ?? '')
  );
}

function successfulToolResponseMessages(
  traces: McpTrace[],
  expectedToolName?: string
): McpTraceMessage[] {
  return traces
    .filter((trace) => trace.serverName === 'teamem')
    .flatMap((trace) => trace.messages)
    .filter((message) => {
      if (
        message.direction !== 'server-to-client' ||
        typeof message.metadata?.toolName !== 'string' ||
        message.metadata.response?.ok !== true
      ) {
        return false;
      }

      return expectedToolName
        ? normalizeStatusToolName(message.metadata.toolName) ===
            expectedToolName
        : true;
    });
}

function assertStatusResponseShapes(
  traces: McpTrace[],
  artifactsDir: string
): void {
  const requiredDataKeysByTool: Record<
    (typeof requiredStatusTools)[number],
    readonly string[]
  > = {
    whoami: ['principal', 'space_id', 'label'],
    get_current_sprint: ['context', 'sprint', 'current_members'],
    list_claims: ['claims'],
    get_briefing: briefingSectionKeys
  };

  for (const toolName of requiredStatusTools) {
    const [message] = successfulToolResponseMessages(traces, toolName);
    if (!message) {
      throw new Error(
        `Expected successful ${toolName} MCP response metadata. Artifacts: ${artifactsDir}`
      );
    }
    const response = message.metadata?.response;
    const responseDataKeys = new Set([
      ...(response?.contentTextJsonDataKeys ?? []),
      ...(response?.structuredContentKeys ?? [])
    ]);
    const missingKeys = requiredDataKeysByTool[toolName].filter(
      (key) => !responseDataKeys.has(key)
    );
    if (missingKeys.length > 0) {
      throw new Error(
        `Expected ${toolName} response metadata data keys to include ${requiredDataKeysByTool[toolName].join(', ')}; missing ${missingKeys.join(', ')}. Observed ${JSON.stringify(response)}. Artifacts: ${artifactsDir}`
      );
    }
  }
}

function summarizeTeamemResponseMetadata(traces: McpTrace[]): string {
  const summaries = traces
    .filter((trace) => trace.serverName === 'teamem')
    .flatMap((trace) => trace.messages)
    .filter((message) => message.direction === 'server-to-client')
    .map((message) => {
      const toolName = message.metadata?.toolName
        ? normalizeStatusToolName(message.metadata.toolName)
        : 'unknown';
      const response = message.metadata?.response;
      return `${toolName}:${response?.ok === true ? 'ok' : 'not-ok'}:${[
        ...(response?.contentTextJsonDataKeys ?? []),
        ...(response?.structuredContentKeys ?? [])
      ].join('|')}`;
    });

  return `Teamem response metadata: ${summaries.join(', ') || 'none'}`;
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
    await assertTraceArtifactsExist(teamemTrace);
    assertObservedPluginDataIsRedacted(teamemTrace);
  }
}

function withArtifactContext(
  result: PromptResult,
  assertion: () => void
): void {
  try {
    assertion();
  } catch (err) {
    throw withArtifactError(err, result.artifacts.dir);
  }
}

function withArtifactError(err: unknown, artifactsDir: string): Error {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes('Artifacts:')) {
    return err instanceof Error ? err : new Error(message);
  }
  const error = new Error(`${message}\nArtifacts: ${artifactsDir}`);
  if (err instanceof Error) {
    error.stack = err.stack;
  }
  return error;
}
