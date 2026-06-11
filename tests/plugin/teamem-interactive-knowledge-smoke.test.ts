import { describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createClaudePluginTester,
  normalizeTranscript,
  readHookTraces,
  readMcpTraces,
  type BootResult,
  type HookTrace,
  type InteractiveSession,
  type McpTrace,
  type McpTraceMessage
} from '../../plugin-e2e-module/src/index.js';
import {
  assertLaunchDidNotForcePluginData,
  assertNoTeamemChannelMcpTrace,
  assertObservedPluginDataIsRedacted,
  assertTraceArtifactsExist,
  callLiveRuntimeTool,
  createLiveRuntimeEnv,
  expectOnlyTeamemMcpIsProxied,
  inspectRuntimePrerequisite,
  withLiveInteractiveSmokeLock,
  TEAMEM_MCP_INSTRUMENTATION_OPTIONS
} from './teamem-live-smoke-helpers.js';
import {
  createDemoRepositoryWorkspace,
  finishDemoRepositoryWorkspace,
  type DemoRepositoryWorkspace
} from './teamem-demo-repository-workspace.js';
import {
  DEFAULT_TEAMEM_INTERACTIVE_PERMISSION_MODE,
  DEFAULT_TEAMEM_INTERACTIVE_SCRIPT_PERMISSION_MODE,
  TEAMEM_INTERACTIVE_PERMISSION_MODE_ENV,
  resolveTeamemInteractivePermissionMode
} from './teamem-interactive-permission-mode.js';

type RuntimeBriefing = {
  recent_decisions?: Array<Record<string, unknown>>;
  recent_findings?: Array<Record<string, unknown>>;
};

const liveGateEnabled = process.env.TEAMEM_CLAUDE_PLUGIN_E2E === '1';
const interactiveGateEnabled =
  process.env.TEAMEM_CLAUDE_PLUGIN_INTERACTIVE_E2E === '1';
const statefulGateEnabled =
  process.env.TEAMEM_CLAUDE_PLUGIN_STATEFUL_E2E === '1';
const liveInteractiveStatefulGateEnabled =
  liveGateEnabled && interactiveGateEnabled && statefulGateEnabled;
const interactivePermissionMode = liveInteractiveStatefulGateEnabled
  ? resolveTeamemInteractivePermissionMode(
      process.env,
      DEFAULT_TEAMEM_INTERACTIVE_SCRIPT_PERMISSION_MODE
    )
  : DEFAULT_TEAMEM_INTERACTIVE_PERMISSION_MODE;
const runtimePrerequisite = await inspectRuntimePrerequisite({
  liveGateEnabled: liveInteractiveStatefulGateEnabled,
  gateReason: formatInteractiveStatefulGateReason()
});
const describeLiveInteractiveStateful =
  liveInteractiveStatefulGateEnabled && runtimePrerequisite.ok
    ? describe
    : describe.skip;

const repoRoot = process.cwd();
const teamemPluginDir = join(repoRoot, 'plugin');
const LIVE_INTERACTIVE_SMOKE_TEST_TIMEOUT_MS = 240_000;
const INTERACTIVE_READINESS_TIMEOUT_MS = 30_000;
const INTERACTIVE_WAIT_TIMEOUT_MS = 75_000;
const INTERACTIVE_CLOSE_TIMEOUT_MS = 10_000;
const INTERACTIVE_STARTUP_SETTLE_MS = 2_000;
const INTERACTIVE_TYPE_DELAY_MS = 20;
const LIVE_RUNTIME_POLL_TIMEOUT_MS = 45_000;
const decisionSlashCommand = '/teamem:decide';
const gotchaSlashCommand = '/teamem:gotcha';
const briefingSlashCommand = '/teamem:briefing';
const pluginScopedToolPrefix = 'mcp__plugin_teamem_teamem__teamem_';
const briefingSectionKeys = [
  'current_plan',
  'active_claims',
  'recent_decisions',
  'active_risks',
  'recent_progress',
  'recent_findings'
] as const;

describeLiveInteractiveStateful(
  `Teamem interactive knowledge live smoke${runtimePrerequisite.ok ? '' : ` (${runtimePrerequisite.reason})`}`,
  () => {
    it(
      'records a decision and gotcha through the Claude Code TTY from a copied demo workspace',
      async () => {
        if (!runtimePrerequisite.ok) {
          throw new Error(runtimePrerequisite.reason);
        }

        await withLiveInteractiveSmokeLock(
          'teamem-interactive-knowledge-smoke',
          async () => {
            const runId = createRunId();
            const runTag = `run-${runId}`;
            const decisionTitle = `Smoke interactive decision ${runId}`;
            const decisionSummary = `Interactive durable knowledge decision ${runId}`;
            const gotchaSummary = `Interactive durable gotcha ${runId}`;
            const decisionArgs = `${decisionTitle} -- ${decisionSummary} --kind=process`;
            const gotchaArgs = `${gotchaSummary} #teamem-smoke #${runTag} --severity=info`;
            let workspace: DemoRepositoryWorkspace | undefined;
            const artifactsDir = await mkdtemp(
              join(tmpdir(), 'teamem-interactive-knowledge-artifacts-')
            );
            let session: InteractiveSession | undefined;
            let success = false;

            try {
              workspace = await createDemoRepositoryWorkspace({
                teamemSourceRoot: repoRoot
              });

              const tester = createClaudePluginTester({
                pluginDir: teamemPluginDir,
                cwd: workspace.demoWorkspaceLaunchCwd,
                artifactsDir,
                cleanup: 'never',
                mcp: TEAMEM_MCP_INSTRUMENTATION_OPTIONS,
                env: createLiveRuntimeEnv(),
                timeouts: {
                  interactiveReadinessMs: INTERACTIVE_READINESS_TIMEOUT_MS,
                  interactiveWaitMs: INTERACTIVE_WAIT_TIMEOUT_MS,
                  interactiveCloseMs: INTERACTIVE_CLOSE_TIMEOUT_MS
                }
              });
              const boot = await tester.boot();

              expect(boot.plugin.pluginDir).toBe(teamemPluginDir);
              expect(boot.instrumentedPlugin.sourcePluginDir).toBe(
                teamemPluginDir
              );
              expect(workspace.demoWorkspaceLaunchCwd).not.toBe(
                teamemPluginDir
              );
              await expectOnlyTeamemMcpIsProxied(boot);

              const decisionPrompt = await tester.slashCommandPrompt(
                'decide',
                decisionArgs
              );
              const gotchaPrompt = await tester.slashCommandPrompt(
                'gotcha',
                gotchaArgs
              );
              const briefingPrompt = await tester.slashCommandPrompt(
                'briefing',
                '1600'
              );
              expect(decisionPrompt).toBe(
                `${decisionSlashCommand} ${decisionArgs}`
              );
              expect(gotchaPrompt).toBe(`${gotchaSlashCommand} ${gotchaArgs}`);
              expect(briefingPrompt).toBe(`${briefingSlashCommand} 1600`);

              session = await tester.launchInteractive({
                permissionMode: interactivePermissionMode,
                allowedTools: [
                  'Bash(bash:*)',
                  `${pluginScopedToolPrefix}record_decision`,
                  `${pluginScopedToolPrefix}get_briefing`
                ],
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
                  `${pluginScopedToolPrefix}share_finding`,
                  `${pluginScopedToolPrefix}get_finding`,
                  `${pluginScopedToolPrefix}acknowledge_finding`,
                  `${pluginScopedToolPrefix}list_sprints`
                ],
                readiness: isClaudeInteractiveReady,
                readinessTimeoutMs: INTERACTIVE_READINESS_TIMEOUT_MS,
                waitTimeoutMs: INTERACTIVE_WAIT_TIMEOUT_MS,
                closeTimeoutMs: INTERACTIVE_CLOSE_TIMEOUT_MS
              });
              expectInteractiveLaunchArgs({
                args: session.command.args,
                permissionMode: interactivePermissionMode,
                boot
              });
              expect(session.cwd).toBe(workspace.demoWorkspaceLaunchCwd);

              await delay(INTERACTIVE_STARTUP_SETTLE_MS);

              await session.submit(decisionPrompt, {
                delayMs: INTERACTIVE_TYPE_DELAY_MS
              });
              const decisionTraces = await waitForMcpEvidence(
                session,
                (traces) => hasSuccessfulToolResponse(traces, 'record_decision')
              );
              assertNoTeamemChannelMcpTrace(decisionTraces);
              assertDecisionMcpEvidence(
                decisionTraces,
                session.artifacts.dir,
                runId
              );

              await session.submit(gotchaPrompt, {
                delayMs: INTERACTIVE_TYPE_DELAY_MS
              });
              const gotchaBriefing = await waitForRuntimeBriefing(
                (briefing) =>
                  hasRuntimeFinding(briefing, {
                    summary: gotchaSummary,
                    tag: runTag,
                    severity: 'info'
                  }),
                runId
              );
              const findingId = findRuntimeFindingId(gotchaBriefing, {
                summary: gotchaSummary,
                tag: runTag,
                severity: 'info'
              });
              if (!findingId) {
                throw new Error(
                  `Expected runtime gotcha finding id for run id ${runId}. Artifacts: ${session.artifacts.dir}`
                );
              }

              const briefingResponsesBefore = countSuccessfulToolResponse(
                decisionTraces,
                'get_briefing'
              );
              await session.submit(briefingPrompt, {
                delayMs: INTERACTIVE_TYPE_DELAY_MS
              });
              const briefingTraces = await waitForMcpEvidence(
                session,
                (traces) =>
                  countSuccessfulToolResponse(traces, 'get_briefing') >
                  briefingResponsesBefore
              );
              assertNoTeamemChannelMcpTrace(briefingTraces);
              assertBriefingMcpEvidence({
                traces: briefingTraces,
                artifactsDir: session.artifacts.dir,
                previousBriefingResponseCount: briefingResponsesBefore
              });

              const finalBriefing = await waitForRuntimeBriefing(
                (briefing) =>
                  hasRuntimeDecision(briefing, {
                    title: decisionTitle,
                    summary: decisionSummary
                  }) &&
                  hasRuntimeFinding(briefing, {
                    findingId,
                    summary: gotchaSummary,
                    tag: runTag,
                    severity: 'info'
                  }),
                runId
              );
              expect(
                finalBriefing.recent_decisions?.length ?? 0
              ).toBeGreaterThan(0);
              expect(
                finalBriefing.recent_findings?.length ?? 0
              ).toBeGreaterThan(0);

              assertLiveInteractiveInputEvidence(session, {
                decisionPrompt,
                gotchaPrompt,
                briefingPrompt
              });
              await session.close();

              await assertInteractiveArtifactsExist(session);
              const [hookTraces, mcpTraces] = await Promise.all([
                readHookTraces(session.artifacts.hookTraceDir),
                readMcpTraces(session.artifacts.mcpTraceDir)
              ]);
              await assertSessionStartEvidence(hookTraces);
              assertNoTeamemChannelMcpTrace(mcpTraces);
              assertDecisionMcpEvidence(
                mcpTraces,
                session.artifacts.dir,
                runId
              );
              assertBriefingMcpEvidence({
                traces: mcpTraces,
                artifactsDir: session.artifacts.dir,
                previousBriefingResponseCount: briefingResponsesBefore
              });
              await assertTeamemMcpTraceEvidence(mcpTraces);
              await assertLaunchDidNotForcePluginData(session.artifacts);
              success = true;
            } catch (err) {
              throw withArtifactError(err, artifactsDir, runId);
            } finally {
              if (!success && session) {
                try {
                  await session.close();
                } catch (err) {
                  console.error(
                    `Failed to close failed interactive knowledge smoke session for run id ${runId}: ${formatError(err)}`
                  );
                }
              }

              if (workspace) {
                const cleanup = await finishDemoRepositoryWorkspace(workspace, {
                  success,
                  artifactsDir
                });
                if (cleanup.preserved) {
                  console.error(
                    `Preserving failed demo workspace at ${cleanup.demoWorkspaceLaunchCwd}${cleanup.artifactPath ? ` (report ${cleanup.artifactPath})` : ''} for run id ${runId}`
                  );
                }
              }

              if (success) {
                await rm(artifactsDir, { recursive: true, force: true });
              } else {
                console.error(
                  `Preserving failed live interactive knowledge smoke artifacts at ${artifactsDir} for run id ${runId}`
                );
              }
            }
          }
        );
      },
      LIVE_INTERACTIVE_SMOKE_TEST_TIMEOUT_MS
    );
  }
);

function formatInteractiveStatefulGateReason(): string {
  const missingGates: string[] = [];
  if (!liveGateEnabled) {
    missingGates.push('TEAMEM_CLAUDE_PLUGIN_E2E=1');
  }
  if (!interactiveGateEnabled) {
    missingGates.push('TEAMEM_CLAUDE_PLUGIN_INTERACTIVE_E2E=1');
  }
  if (!statefulGateEnabled) {
    missingGates.push('TEAMEM_CLAUDE_PLUGIN_STATEFUL_E2E=1');
  }

  return `set TEAMEM_CLAUDE_PLUGIN_E2E=1, TEAMEM_CLAUDE_PLUGIN_INTERACTIVE_E2E=1, and TEAMEM_CLAUDE_PLUGIN_STATEFUL_E2E=1 to run stateful interactive Claude plugin knowledge smoke${
    missingGates.length > 0 ? `; missing ${missingGates.join(', ')}` : ''
  }`;
}

function createRunId(): string {
  return `${Date.now().toString(36)}${randomUUID().replaceAll('-', '').slice(0, 6)}`;
}

function expectInteractiveLaunchArgs(input: {
  args: string[];
  permissionMode: string;
  boot: BootResult;
}): void {
  const permissionFlagIndex = input.args.indexOf('--permission-mode');
  expect(permissionFlagIndex).toBeGreaterThanOrEqual(0);
  expect(input.args[permissionFlagIndex + 1]).toBe(input.permissionMode);

  const pluginDirFlagIndex = input.args.indexOf('--plugin-dir');
  expect(pluginDirFlagIndex).toBeGreaterThanOrEqual(0);
  expect(input.args[pluginDirFlagIndex + 1]).toBe(
    input.boot.instrumentedPlugin.pluginDir
  );
  expect(input.boot.instrumentedPlugin.sourcePluginDir).toBe(teamemPluginDir);
}

function isClaudeInteractiveReady(transcript: string): boolean {
  const normalized = normalizeTranscript(transcript);

  return (
    /(^|\n)[^\S\n]*[>›❯][^\S\n]*(?=\n|$)/.test(normalized) ||
    /\btry ["'].*["']/i.test(normalized)
  );
}

async function waitForMcpEvidence(
  session: InteractiveSession,
  isComplete: (traces: McpTrace[]) => boolean
): Promise<McpTrace[]> {
  const deadline = Date.now() + INTERACTIVE_WAIT_TIMEOUT_MS;
  let lastTraceSummary = 'no MCP traces observed';

  while (Date.now() < deadline) {
    const traces = await readMcpTraces(session.artifacts.mcpTraceDir, {
      ignoreTransientErrors: true
    });

    if (isComplete(traces)) {
      return traces;
    }

    lastTraceSummary = summarizeMcpTraces(traces);
    await delay(250);
  }

  throw new Error(
    `Timed out waiting for interactive knowledge MCP evidence after ${INTERACTIVE_WAIT_TIMEOUT_MS}ms. Last trace summary: ${lastTraceSummary}. Artifacts: ${session.artifacts.dir}. Permission mode env: ${TEAMEM_INTERACTIVE_PERMISSION_MODE_ENV}`
  );
}

async function waitForRuntimeBriefing(
  isComplete: (briefing: RuntimeBriefing) => boolean,
  runId: string
): Promise<RuntimeBriefing> {
  if (!runtimePrerequisite.ok) {
    throw new Error(runtimePrerequisite.reason);
  }

  const deadline = Date.now() + LIVE_RUNTIME_POLL_TIMEOUT_MS;
  let lastSummary = 'no runtime briefing observed';

  while (Date.now() < deadline) {
    const response = await callLiveRuntimeTool<RuntimeBriefing>(
      runtimePrerequisite.selectedEntry,
      'teamem.get_briefing',
      { token_budget: 4000 }
    );

    if (isComplete(response.data)) {
      return response.data;
    }

    lastSummary = summarizeRuntimeBriefing(response.data);
    await delay(500);
  }

  throw new Error(
    `Timed out waiting for live runtime briefing evidence for run id ${runId}. Last briefing summary: ${lastSummary}`
  );
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

  const observedTools = observedTeamemToolsOrThrow(traces, artifactsDir);
  const unexpectedTools = observedTools.filter(
    (toolName) => !['record_decision', 'get_briefing'].includes(toolName)
  );
  if (unexpectedTools.length > 0) {
    throw new Error(
      `Expected only decision/briefing MCP tools for run id ${runId}, observed unexpected ${unexpectedTools.join(', ')}. Artifacts: ${artifactsDir}`
    );
  }
}

function assertBriefingMcpEvidence(input: {
  traces: McpTrace[];
  artifactsDir: string;
  previousBriefingResponseCount: number;
}): void {
  const successfulBriefingResponses = successfulTeamemToolResponseMessages(
    input.traces,
    'get_briefing'
  );
  const briefingResponseCount = successfulBriefingResponses.length;

  if (briefingResponseCount <= input.previousBriefingResponseCount) {
    throw new Error(
      `Expected briefing command to add a successful get_briefing MCP response. Previous ${input.previousBriefingResponseCount}, observed ${briefingResponseCount}. ${summarizeTeamemResponseMetadata(input.traces)}. Artifacts: ${input.artifactsDir}`
    );
  }

  const additionalResponses = successfulBriefingResponses.slice(
    input.previousBriefingResponseCount
  );
  for (const response of additionalResponses) {
    assertBriefingResponseShape(response, input.artifactsDir);
  }
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

function hasSuccessfulToolResponse(
  traces: McpTrace[],
  expectedToolName: string
): boolean {
  return (
    successfulTeamemToolResponseMessages(traces, expectedToolName).length > 0
  );
}

function countSuccessfulToolResponse(
  traces: McpTrace[],
  expectedToolName: string
): number {
  return successfulTeamemToolResponseMessages(traces, expectedToolName).length;
}

function successfulTeamemToolResponseMessages(
  traces: McpTrace[],
  expectedToolName?: string
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

    return expectedToolName
      ? normalizeTeamemToolName(message.metadata.toolName) === expectedToolName
      : true;
  });
}

function observedTeamemToolsOrThrow(
  traces: McpTrace[],
  artifactsDir: string
): string[] {
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
        `Expected safe interactive MCP tools/call name metadata at index ${index}. Artifacts: ${artifactsDir}`
      );
    }
    observedTools.push(normalizeTeamemToolName(toolName));
  }

  return observedTools;
}

function normalizeTeamemToolName(toolName: string): string {
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

function hasRuntimeDecision(
  briefing: RuntimeBriefing,
  expected: { title: string; summary: string }
): boolean {
  return (briefing.recent_decisions ?? []).some(
    (decision) =>
      decision.title === expected.title && decision.summary === expected.summary
  );
}

function hasRuntimeFinding(
  briefing: RuntimeBriefing,
  expected: {
    findingId?: string;
    summary: string;
    tag: string;
    severity: string;
  }
): boolean {
  return (briefing.recent_findings ?? []).some(
    (finding) =>
      (expected.findingId === undefined ||
        finding.finding_id === expected.findingId) &&
      finding.summary === expected.summary &&
      finding.severity === expected.severity &&
      Array.isArray(finding.tags) &&
      finding.tags.includes('teamem-smoke') &&
      finding.tags.includes(expected.tag)
  );
}

function findRuntimeFindingId(
  briefing: RuntimeBriefing,
  expected: {
    summary: string;
    tag: string;
    severity: string;
  }
): string | undefined {
  const finding = (briefing.recent_findings ?? []).find(
    (item) =>
      item.summary === expected.summary &&
      item.severity === expected.severity &&
      Array.isArray(item.tags) &&
      item.tags.includes('teamem-smoke') &&
      item.tags.includes(expected.tag)
  );

  return typeof finding?.finding_id === 'string'
    ? finding.finding_id
    : undefined;
}

async function assertInteractiveArtifactsExist(
  session: InteractiveSession
): Promise<void> {
  await expect(stat(session.artifacts.summaryPath)).resolves.toBeTruthy();
  await expect(stat(session.artifacts.environmentPath)).resolves.toBeTruthy();
  await expect(stat(session.artifacts.rawTranscriptPath)).resolves.toBeTruthy();
  await expect(
    stat(session.artifacts.normalizedTranscriptPath)
  ).resolves.toBeTruthy();
  await expect(
    stat(session.artifacts.interactiveEventsPath)
  ).resolves.toBeTruthy();

  const summary = JSON.parse(
    await readFile(session.artifacts.summaryPath, 'utf8')
  ) as {
    kind?: string;
    cwd?: string;
    command?: {
      args?: string[];
    };
    exitStatus?: {
      errorCode?: string;
    };
    result?: {
      eventCount?: number;
      hookTraceCount?: number;
      mcpTraceCount?: number;
    };
  };
  const interactiveEvents = JSON.parse(
    await readFile(session.artifacts.interactiveEventsPath, 'utf8')
  ) as Array<{ type?: string; source?: string }>;

  expect(summary.kind).toBe('interactive');
  expect(summary.command?.args).toEqual(session.command.args);
  expect(summary.exitStatus?.errorCode).toBeUndefined();
  expect(summary.cwd).toBe(session.cwd);
  expect(summary.result?.eventCount ?? 0).toBeGreaterThan(0);
  expect(summary.result?.hookTraceCount ?? 0).toBeGreaterThan(0);
  expect(summary.result?.mcpTraceCount ?? 0).toBeGreaterThan(0);
  expect(interactiveEvents.some((event) => event.type === 'close-step')).toBe(
    true
  );
}

function assertLiveInteractiveInputEvidence(
  session: InteractiveSession,
  prompts: {
    decisionPrompt: string;
    gotchaPrompt: string;
    briefingPrompt: string;
  }
): void {
  const submittedText = session
    .events()
    .filter((event) => event.type === 'input' && event.source === 'submit')
    .map((event) => ('data' in event ? event.data : ''))
    .join('');

  expect(submittedText).toContain(prompts.decisionPrompt);
  expect(submittedText).toContain(prompts.gotchaPrompt);
  expect(submittedText).toContain(prompts.briefingPrompt);
}

async function assertSessionStartEvidence(traces: HookTrace[]): Promise<void> {
  const sessionStart = traces.find((trace) => trace.event === 'SessionStart');
  expect(sessionStart).toBeDefined();

  if (sessionStart) {
    expect(sessionStart.exitCode).toBe(0);
    await assertTraceArtifactsExist(sessionStart);
    assertObservedPluginDataIsRedacted(sessionStart);
  }
}

async function assertTeamemMcpTraceEvidence(traces: McpTrace[]): Promise<void> {
  const teamemTrace = traces.find((trace) => trace.serverName === 'teamem');
  expect(teamemTrace).toBeDefined();

  if (teamemTrace) {
    await assertTraceArtifactsExist(teamemTrace);
    assertObservedPluginDataIsRedacted(teamemTrace);
  }
}

function summarizeTeamemResponseMetadata(traces: McpTrace[]): string {
  const teamemTrace = traces.find((trace) => trace.serverName === 'teamem');
  if (!teamemTrace) {
    return 'No teamem trace response metadata observed';
  }

  const summaries = teamemTrace.messages
    .filter((message) => message.direction === 'server-to-client')
    .map((message) => {
      const toolName = message.metadata?.toolName
        ? normalizeTeamemToolName(message.metadata.toolName)
        : 'unknown';
      const response = message.metadata?.response;
      return `${toolName}:${response?.ok === true ? 'ok' : 'not-ok'}:${[
        ...(response?.contentTextJsonDataKeys ?? []),
        ...(response?.structuredContentKeys ?? [])
      ].join('|')}`;
    });

  return `Teamem response metadata: ${summaries.join(', ') || 'none'}`;
}

function summarizeMcpTraces(traces: McpTrace[]): string {
  if (traces.length === 0) {
    return 'no MCP traces observed';
  }

  return traces
    .map(
      (trace) =>
        `${trace.serverName}:${
          trace.messages
            .map(
              (message) =>
                message.metadata?.toolName ?? message.method ?? 'unknown'
            )
            .join(',') || 'no messages'
        }`
    )
    .join('; ');
}

function summarizeRuntimeBriefing(briefing: RuntimeBriefing): string {
  const decisions = (briefing.recent_decisions ?? [])
    .map((decision) => String(decision.title ?? decision.decision_id ?? ''))
    .filter(Boolean)
    .slice(0, 3)
    .join(',');
  const findings = (briefing.recent_findings ?? [])
    .map((finding) => String(finding.summary ?? finding.finding_id ?? ''))
    .filter(Boolean)
    .slice(0, 3)
    .join(',');

  return `decisions=${decisions || 'none'} findings=${findings || 'none'}`;
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
    `${message}\nArtifacts: ${artifactsDir}\nInteractive knowledge smoke run id: ${runId}`
  );
  if (err instanceof Error) {
    error.stack = err.stack;
  }
  return error;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
