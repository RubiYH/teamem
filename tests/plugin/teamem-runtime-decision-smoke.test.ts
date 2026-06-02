import { describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
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
  callLiveRuntimeTool,
  createLiveRuntimeEnv,
  expectOnlyTeamemMcpIsProxied,
  initGitRepo,
  inspectRuntimePrerequisite,
  TEAMEM_MCP_INSTRUMENTATION_OPTIONS
} from './teamem-live-smoke-helpers.js';

type RuntimeBriefing = {
  recent_decisions?: RuntimeDecision[];
  recent_notifications?: RuntimeNotification[];
};

type RuntimeDecision = {
  id?: unknown;
  decision_id?: unknown;
  title?: unknown;
  summary?: unknown;
  kind?: unknown;
  status?: unknown;
};

type RuntimeNotification = {
  event_type?: unknown;
  summary?: unknown;
};

const liveGateEnabled = process.env.TEAMEM_CLAUDE_PLUGIN_E2E === '1';
const statefulGateEnabled =
  process.env.TEAMEM_CLAUDE_PLUGIN_STATEFUL_E2E === '1';
const runtimePrerequisite = await inspectRuntimePrerequisite({
  liveGateEnabled: liveGateEnabled && statefulGateEnabled,
  gateReason: formatStatefulGateReason()
});
const describeLiveRuntime =
  liveGateEnabled && statefulGateEnabled && runtimePrerequisite.ok
    ? describe
    : describe.skip;

const repoRoot = process.cwd();
const teamemPluginDir = join(repoRoot, 'plugin');
const LIVE_SMOKE_TEST_TIMEOUT_MS = 240_000;
const decisionSlashCommand = '/teamem:teamem-decide';
const briefingSlashCommand = '/teamem:teamem-briefing';
const pluginScopedToolPrefix = 'mcp__plugin_teamem_teamem__teamem_';

describeLiveRuntime(
  `Teamem runtime decision live smoke${runtimePrerequisite.ok ? '' : ` (${runtimePrerequisite.reason})`}`,
  () => {
    it(
      'records a decision through the core Teamem MCP proxy and sees it in a follow-up briefing',
      async () => {
        if (!runtimePrerequisite.ok) {
          throw new Error(runtimePrerequisite.reason);
        }

        const runId = createRunId();
        const decisionTitle = `Smoke dec ${runId}`;
        const decisionSummary = `Stateful Claude plugin smoke run ${runId}`;
        const expectedDecisionId = `dec-smoke-dec-${runId}`;
        const decisionArgs = `${decisionTitle} -- ${decisionSummary} --kind=process`;
        const cwd = await mkdtemp(join(tmpdir(), 'teamem-decision-cwd-'));
        const artifactsDir = await mkdtemp(
          join(tmpdir(), 'teamem-decision-artifacts-')
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

          const commandPrompt = await tester.slashCommandPrompt(
            'teamem-decide',
            decisionArgs
          );
          expect(commandPrompt.startsWith(`${decisionSlashCommand} `)).toBe(
            true
          );

          const decisionResult = await tester.prompt(commandPrompt, {
            allowedTools: [`${pluginScopedToolPrefix}record_decision`],
            disallowedTools: [
              'mcp__plugin_teamem_channel__*',
              'mcp__teamem-channel__*',
              `${pluginScopedToolPrefix}whoami`,
              `${pluginScopedToolPrefix}get_current_sprint`,
              `${pluginScopedToolPrefix}list_claims`,
              `${pluginScopedToolPrefix}get_briefing`,
              `${pluginScopedToolPrefix}claim_scope`,
              `${pluginScopedToolPrefix}release_scope`,
              `${pluginScopedToolPrefix}force_release`,
              `${pluginScopedToolPrefix}post_message`,
              `${pluginScopedToolPrefix}list_sprints`
            ],
            maxTurns: 6
          });

          withArtifactContext(decisionResult, runId, () => {
            expect(decisionResult.exitCode).toBe(0);
            expect(decisionResult.prompt).toContain(decisionSlashCommand);
            expect(decisionResult.stdout).toContain(decisionTitle);
            expect(decisionResult.stdout).toContain(runId);
            expect(decisionResult.stdout).toContain(expectedDecisionId);
            assertNoTeamemChannelMcpTrace(decisionResult);
            assertDecisionMcpEvidence(
              decisionResult.mcpTraces,
              decisionResult.artifacts.dir,
              runId
            );
          });

          const briefingPrompt = await tester.slashCommandPrompt(
            'teamem-briefing',
            '1200'
          );
          expect(briefingPrompt).toBe(`${briefingSlashCommand} 1200`);

          const briefingResult = await tester.prompt(briefingPrompt, {
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

          withArtifactContext(briefingResult, runId, () => {
            expect(briefingResult.exitCode).toBe(0);
            expect(briefingResult.prompt).toContain(briefingSlashCommand);
            expect(briefingResult.stdout).toContain(decisionSummary);
            expect(briefingResult.stdout).toContain(runId);
            assertNoTeamemChannelMcpTrace(briefingResult);
            assertBriefingMcpEvidence(
              briefingResult.mcpTraces,
              briefingResult.artifacts.dir,
              runId
            );
          });

          await assertRuntimeDecisionVisibility({
            artifactsDir,
            runId,
            decisionTitle,
            decisionSummary,
            expectedDecisionId
          });
          await assertLaunchDidNotForcePluginData(decisionResult);
          await assertLaunchDidNotForcePluginData(briefingResult);
          await assertProxyTraceEvidence(decisionResult, runId);
          await assertProxyTraceEvidence(briefingResult, runId);
          success = true;
        } catch (err) {
          throw withArtifactError(err, artifactsDir, runId);
        } finally {
          if (success) {
            await rm(artifactsDir, { recursive: true, force: true });
            await rm(cwd, { recursive: true, force: true });
          } else {
            console.error(
              `Preserving failed live smoke artifacts at ${artifactsDir} and cwd ${cwd} for run id ${runId}`
            );
          }
        }
      },
      LIVE_SMOKE_TEST_TIMEOUT_MS
    );
  }
);

function formatStatefulGateReason(): string {
  const missingGates: string[] = [];
  if (!liveGateEnabled) {
    missingGates.push('TEAMEM_CLAUDE_PLUGIN_E2E=1');
  }
  if (!statefulGateEnabled) {
    missingGates.push('TEAMEM_CLAUDE_PLUGIN_STATEFUL_E2E=1');
  }

  return `set TEAMEM_CLAUDE_PLUGIN_E2E=1 and TEAMEM_CLAUDE_PLUGIN_STATEFUL_E2E=1 to run stateful live Claude plugin decision smoke${
    missingGates.length > 0 ? `; missing ${missingGates.join(' and ')}` : ''
  }`;
}

function createRunId(): string {
  return `${Date.now().toString(36)}${randomUUID().replaceAll('-', '').slice(0, 6)}`;
}

async function assertRuntimeDecisionVisibility(input: {
  artifactsDir: string;
  runId: string;
  decisionTitle: string;
  decisionSummary: string;
  expectedDecisionId: string;
}): Promise<void> {
  if (!runtimePrerequisite.ok) {
    throw new Error(runtimePrerequisite.reason);
  }

  const response = await callLiveRuntimeTool<RuntimeBriefing>(
    runtimePrerequisite.selectedEntry,
    'teamem.get_briefing',
    { token_budget: 4000 }
  );
  const recentDecisions = Array.isArray(response.data.recent_decisions)
    ? response.data.recent_decisions
    : [];
  const matchingDecision = recentDecisions.find(
    (decision) =>
      decision.title === input.decisionTitle &&
      decision.summary === input.decisionSummary
  );
  const recentNotifications = Array.isArray(response.data.recent_notifications)
    ? response.data.recent_notifications
    : [];
  const matchingNotification = recentNotifications.find(
    (notification) =>
      notification.event_type === 'decision_published' &&
      notification.summary === input.decisionSummary
  );

  if (!matchingDecision && !matchingNotification) {
    throw new Error(
      `Expected live runtime briefing to include decision title "${input.decisionTitle}" and summary "${input.decisionSummary}" for run id ${input.runId} in recent_decisions or recent_notifications. Observed decisions ${summarizeRuntimeDecisions(recentDecisions)}; notifications ${summarizeRuntimeNotifications(recentNotifications)}. Artifacts: ${input.artifactsDir}`
    );
  }

  if (!matchingDecision) {
    if (!String(matchingNotification?.summary ?? '').includes(input.runId)) {
      throw new Error(
        `Expected live runtime decision notification summary to carry run id ${input.runId}. Observed ${JSON.stringify(matchingNotification)}. Artifacts: ${input.artifactsDir}`
      );
    }
    return;
  }

  if (
    !String(matchingDecision.title ?? '').includes(input.runId) ||
    !String(matchingDecision.summary ?? '').includes(input.runId)
  ) {
    throw new Error(
      `Expected live runtime decision title and summary to carry run id ${input.runId}. Observed ${JSON.stringify(matchingDecision)}. Artifacts: ${input.artifactsDir}`
    );
  }

  assertRuntimeDecisionField({
    decision: matchingDecision,
    fieldNames: ['id', 'decision_id'],
    expected: input.expectedDecisionId,
    artifactsDir: input.artifactsDir,
    runId: input.runId
  });
  assertRuntimeDecisionField({
    decision: matchingDecision,
    fieldNames: ['kind'],
    expected: 'process',
    artifactsDir: input.artifactsDir,
    runId: input.runId
  });
  assertRuntimeDecisionField({
    decision: matchingDecision,
    fieldNames: ['status'],
    expected: 'open',
    artifactsDir: input.artifactsDir,
    runId: input.runId
  });
}

function assertRuntimeDecisionField(input: {
  decision: RuntimeDecision;
  fieldNames: Array<keyof RuntimeDecision>;
  expected: string;
  artifactsDir: string;
  runId: string;
}): void {
  const observed = input.fieldNames
    .map((fieldName) => input.decision[fieldName])
    .find((value): value is string => typeof value === 'string');

  if (observed === undefined) {
    return;
  }

  if (observed !== input.expected) {
    throw new Error(
      `Expected live runtime decision ${input.fieldNames.join('/')} to be "${input.expected}" for run id ${input.runId}. Observed ${JSON.stringify(input.decision)}. Artifacts: ${input.artifactsDir}`
    );
  }
}

function summarizeRuntimeDecisions(decisions: RuntimeDecision[]): string {
  const summary = decisions
    .map((decision) =>
      [
        typeof decision.id === 'string' ? decision.id : decision.decision_id,
        decision.title,
        decision.summary,
        decision.kind,
        decision.status
      ]
        .filter((value) => typeof value === 'string' && value.length > 0)
        .join(':')
    )
    .filter(Boolean)
    .slice(0, 5)
    .join(', ');

  return summary || 'none';
}

function summarizeRuntimeNotifications(
  notifications: RuntimeNotification[]
): string {
  const summary = notifications
    .map((notification) =>
      [notification.event_type, notification.summary]
        .filter((value) => typeof value === 'string' && value.length > 0)
        .join(':')
    )
    .filter(Boolean)
    .slice(0, 5)
    .join(', ');

  return summary || 'none';
}

function assertDecisionMcpEvidence(
  traces: McpTrace[],
  artifactsDir: string,
  runId: string
): void {
  const successfulDecisionResponses = successfulTeamemToolResponseMessages(
    traces,
    'record_decision'
  );
  if (successfulDecisionResponses.length === 0) {
    throw new Error(
      `Expected successful record_decision MCP response metadata for run id ${runId}. ${summarizeTeamemResponseMetadata(traces)}. Artifacts: ${artifactsDir}`
    );
  }

  for (const response of successfulDecisionResponses) {
    assertDecisionResponseShape(response, artifactsDir, runId);
  }

  const observedTools = collectTeamemToolCalls(traces, artifactsDir, runId);

  if (!observedTools.includes('record_decision')) {
    throw new Error(
      `Expected decision MCP record_decision call for run id ${runId}. Observed ${observedTools.join(', ') || 'none'}. Artifacts: ${artifactsDir}`
    );
  }

  const unexpectedTools = observedTools.filter(
    (toolName) => toolName !== 'record_decision'
  );
  if (unexpectedTools.length > 0) {
    throw new Error(
      `Expected only decision MCP record_decision calls for run id ${runId}, observed unexpected ${unexpectedTools.join(', ')}. Artifacts: ${artifactsDir}`
    );
  }
}

function assertBriefingMcpEvidence(
  traces: McpTrace[],
  artifactsDir: string,
  runId: string
): void {
  const successfulBriefingResponses = successfulTeamemToolResponseMessages(
    traces,
    'get_briefing'
  );
  if (successfulBriefingResponses.length === 0) {
    throw new Error(
      `Expected successful get_briefing MCP response metadata for run id ${runId}. ${summarizeTeamemResponseMetadata(traces)}. Artifacts: ${artifactsDir}`
    );
  }

  for (const response of successfulBriefingResponses) {
    assertBriefingResponseShape(response, artifactsDir, runId);
  }

  const observedTools = collectTeamemToolCalls(traces, artifactsDir, runId);

  if (!observedTools.includes('get_briefing')) {
    throw new Error(
      `Expected briefing MCP get_briefing call for run id ${runId}. Observed ${observedTools.join(', ') || 'none'}. Artifacts: ${artifactsDir}`
    );
  }

  const unexpectedTools = observedTools.filter(
    (toolName) => toolName !== 'get_briefing'
  );
  if (unexpectedTools.length > 0) {
    throw new Error(
      `Expected only briefing MCP get_briefing calls for run id ${runId}, observed unexpected ${unexpectedTools.join(', ')}. Artifacts: ${artifactsDir}`
    );
  }
}

function collectTeamemToolCalls(
  traces: McpTrace[],
  artifactsDir: string,
  runId: string
): string[] {
  const teamemTrace = traces.find((trace) => trace.serverName === 'teamem');
  if (!teamemTrace) {
    throw new Error(
      `Expected core teamem MCP trace for run id ${runId}. Artifacts: ${artifactsDir}`
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
        `Expected safe MCP tools/call name metadata at index ${index} for run id ${runId}. Artifacts: ${artifactsDir}`
      );
    }
    observedTools.push(normalizeToolName(toolName));
  }

  return observedTools;
}

function successfulTeamemToolResponseMessages(
  traces: McpTrace[],
  expectedToolName: string
): McpTraceMessage[] {
  const teamemTrace = traces.find((trace) => trace.serverName === 'teamem');
  if (!teamemTrace) {
    return [];
  }

  return teamemTrace.messages.filter((message) => {
    if (
      message.direction !== 'server-to-client' ||
      typeof message.metadata?.toolName !== 'string' ||
      message.metadata.response?.ok !== true
    ) {
      return false;
    }

    return normalizeToolName(message.metadata.toolName) === expectedToolName;
  });
}

function assertDecisionResponseShape(
  message: McpTraceMessage,
  artifactsDir: string,
  runId: string
): void {
  const response = message.metadata?.response;
  if (!response?.ok) {
    throw new Error(
      `Expected successful record_decision MCP response metadata for run id ${runId}. Observed ${JSON.stringify(response)}. Artifacts: ${artifactsDir}`
    );
  }

  const responseDataKeys = new Set(response.contentTextJsonDataKeys);
  const missingKeys = [
    'event_id',
    'decision_id',
    'lifecycle_event',
    'version',
    'kind',
    'status'
  ].filter((key) => !responseDataKeys.has(key));
  if (missingKeys.length > 0) {
    throw new Error(
      `Expected record_decision response metadata data keys to include durable write fields; missing ${missingKeys.join(', ')} for run id ${runId}. Observed ${JSON.stringify(response)}. Artifacts: ${artifactsDir}`
    );
  }
}

function assertBriefingResponseShape(
  message: McpTraceMessage,
  artifactsDir: string,
  runId: string
): void {
  const response = message.metadata?.response;
  if (!response?.ok) {
    throw new Error(
      `Expected successful get_briefing MCP response metadata for run id ${runId}. Observed ${JSON.stringify(response)}. Artifacts: ${artifactsDir}`
    );
  }

  const responseSectionKeys = new Set([
    ...response.contentTextJsonDataKeys,
    ...response.structuredContentKeys
  ]);
  const missingSectionKeys = [
    'active_claims',
    'recent_decisions',
    'recent_notifications',
    'recent_findings',
    'meta'
  ].filter((key) => !responseSectionKeys.has(key));
  if (missingSectionKeys.length > 0) {
    throw new Error(
      `Expected get_briefing response metadata to include durable visibility sections; missing ${missingSectionKeys.join(', ')} for run id ${runId}. Observed ${JSON.stringify(response)}. Artifacts: ${artifactsDir}`
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
        ? normalizeToolName(message.metadata.toolName)
        : 'unknown';
      const response = message.metadata?.response;
      return `${toolName}:${response?.ok === true ? 'ok' : 'not-ok'}:${[
        ...(response?.contentTextJsonDataKeys ?? []),
        ...(response?.structuredContentKeys ?? [])
      ].join('|')}`;
    });

  return `Teamem response metadata: ${summaries.join(', ') || 'none'}`;
}

function normalizeToolName(toolName: string): string {
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

async function assertProxyTraceEvidence(
  result: PromptResult,
  runId: string
): Promise<void> {
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
  } else {
    throw withArtifactError(
      new Error('Expected core teamem MCP trace'),
      result.artifacts.dir,
      runId
    );
  }
}

function withArtifactContext(
  result: PromptResult,
  runId: string,
  assertion: () => void
): void {
  try {
    assertion();
  } catch (err) {
    throw withArtifactError(err, result.artifacts.dir, runId);
  }
}

function withArtifactError(
  err: unknown,
  artifactsDir: string,
  runId: string
): Error {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes('Artifacts:') && message.includes('run id')) {
    return err instanceof Error ? err : new Error(message);
  }
  const error = new Error(
    `${message}\nArtifacts: ${artifactsDir}\nStateful decision smoke run id: ${runId}`
  );
  if (err instanceof Error) {
    error.stack = err.stack;
  }
  return error;
}
