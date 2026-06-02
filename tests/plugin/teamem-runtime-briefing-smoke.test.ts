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
    'set TEAMEM_CLAUDE_PLUGIN_E2E=1 to run live Claude plugin briefing smoke'
});
const describeLiveRuntime =
  liveGateEnabled && runtimePrerequisite.ok ? describe : describe.skip;

const repoRoot = process.cwd();
const teamemPluginDir = join(repoRoot, 'plugin');
const LIVE_SMOKE_TEST_TIMEOUT_MS = 180_000;
const briefingSlashCommand = '/teamem:teamem-briefing';
const pluginScopedToolPrefix = 'mcp__plugin_teamem_teamem__teamem_';
const briefingSectionHeadings = [
  'Current plan',
  'Active claims',
  'Recent decisions',
  'Active risks',
  'Recent progress'
] as const;
const briefingSectionKeys = [
  'current_plan',
  'active_claims',
  'recent_decisions',
  'recent_notifications',
  'recent_findings',
  'recent_artifacts',
  'meta'
] as const;

describeLiveRuntime(
  `Teamem runtime briefing live smoke${runtimePrerequisite.ok ? '' : ` (${runtimePrerequisite.reason})`}`,
  () => {
    it(
      'invokes /teamem:teamem-briefing through the core Teamem MCP proxy',
      async () => {
        if (!runtimePrerequisite.ok) {
          throw new Error(runtimePrerequisite.reason);
        }

        const cwd = await mkdtemp(join(tmpdir(), 'teamem-briefing-cwd-'));
        const artifactsDir = await mkdtemp(
          join(tmpdir(), 'teamem-briefing-artifacts-')
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
            await tester.slashCommandPrompt('teamem-briefing');
          expect(commandPrompt).toBe(briefingSlashCommand);

          const result = await tester.prompt(commandPrompt, {
            allowedTools: [`${pluginScopedToolPrefix}get_briefing`],
            disallowedTools: [
              'mcp__plugin_teamem_channel__*',
              'mcp__teamem-channel__*',
              `${pluginScopedToolPrefix}whoami`,
              `${pluginScopedToolPrefix}get_current_sprint`,
              `${pluginScopedToolPrefix}list_claims`,
              `${pluginScopedToolPrefix}claim_scope`,
              `${pluginScopedToolPrefix}release_scope`,
              `${pluginScopedToolPrefix}force_release`,
              `${pluginScopedToolPrefix}post_message`,
              `${pluginScopedToolPrefix}record_decision`,
              `${pluginScopedToolPrefix}list_sprints`
            ],
            maxTurns: 5
          });

          withArtifactContext(result, () => {
            expect(result.exitCode).toBe(0);
            for (const heading of briefingSectionHeadings) {
              expect(result.expectText(new RegExp(heading, 'i'))).toBe(result);
            }
            assertSelectedRuntimeContext();
            assertNoTeamemChannelMcpTrace(result);
            assertBriefingMcpEvidence(result.mcpTraces, result.artifacts.dir);
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

function assertSelectedRuntimeContext(): void {
  if (!runtimePrerequisite.ok) {
    throw new Error(runtimePrerequisite.reason);
  }

  expect(runtimePrerequisite.preflightWhoami.principal).toBeTruthy();
  expect(runtimePrerequisite.selectedEntry.member_name).toBeTruthy();
  expect(runtimePrerequisite.preflightWhoami.principal).toBe(
    runtimePrerequisite.selectedEntry.member_name
  );
  expect(runtimePrerequisite.preflightWhoami.label).toBe(
    runtimePrerequisite.selectedEntry.label
  );
  expect(runtimePrerequisite.preflightWhoami.space_id).toBe(
    runtimePrerequisite.selectedEntry.space_id
  );
}

function assertBriefingMcpEvidence(
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
        `Expected safe briefing MCP tools/call name metadata at index ${index}. Artifacts: ${artifactsDir}`
      );
    }
    observedTools.push(normalizeBriefingToolName(toolName));
  }

  if (!observedTools.includes('get_briefing')) {
    throw new Error(
      `Expected briefing MCP get_briefing call. Observed ${observedTools.join(', ') || 'none'}. Artifacts: ${artifactsDir}`
    );
  }

  const unexpectedTools = observedTools.filter(
    (toolName) => toolName !== 'get_briefing'
  );
  if (unexpectedTools.length > 0) {
    throw new Error(
      `Expected only briefing MCP get_briefing calls, observed unexpected ${unexpectedTools.join(', ')}. Artifacts: ${artifactsDir}`
    );
  }

  const successfulBriefingResponses = successfulTeamemToolResponseMessages(
    traces,
    'get_briefing'
  );
  if (successfulBriefingResponses.length === 0) {
    throw new Error(
      `Expected successful briefing MCP get_briefing response. ${summarizeTeamemResponseMetadata(traces)}. Artifacts: ${artifactsDir}`
    );
  }
  assertBriefingResponseShape(successfulBriefingResponses[0], artifactsDir);
}

function normalizeBriefingToolName(toolName: string): string {
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

function successfulTeamemToolResponseMessages(
  traces: McpTrace[],
  expectedToolName: string
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

      return (
        normalizeBriefingToolName(message.metadata.toolName) ===
        expectedToolName
      );
    });
}

function assertBriefingResponseShape(
  message: McpTraceMessage,
  artifactsDir: string
): void {
  const response = message.metadata?.response;
  if (!response?.ok) {
    throw new Error(
      `Expected successful get_briefing MCP response metadata. Observed ${JSON.stringify(response)}. Artifacts: ${artifactsDir}`
    );
  }

  const responseSectionKeys = new Set([
    ...response.contentTextJsonDataKeys,
    ...response.structuredContentKeys
  ]);
  const missingSectionKeys = briefingSectionKeys.filter(
    (key) => !responseSectionKeys.has(key)
  );
  if (missingSectionKeys.length > 0) {
    throw new Error(
      `Expected get_briefing response metadata to include briefing section keys ${briefingSectionKeys.join(', ')}; missing ${missingSectionKeys.join(', ')}. Observed ${JSON.stringify(response)}. Artifacts: ${artifactsDir}`
    );
  }
}

function summarizeTeamemResponseMetadata(traces: McpTrace[]): string {
  const summaries = traces
    .filter((trace) => trace.serverName === 'teamem')
    .flatMap((trace) => trace.messages)
    .filter((message) => message.direction === 'server-to-client')
    .map((message) => {
      const toolName = message.metadata?.toolName
        ? normalizeBriefingToolName(message.metadata.toolName)
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
