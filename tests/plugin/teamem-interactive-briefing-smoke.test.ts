import { describe, expect, it } from 'bun:test';
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
  type InteractiveSyntheticEvent,
  type McpTrace,
  type McpTraceMessage
} from '../../plugin-e2e-module/src/index.js';
import {
  assertLaunchDidNotForcePluginData,
  assertNoTeamemChannelMcpTrace,
  assertObservedPluginDataIsRedacted,
  assertTraceArtifactsExist,
  createLiveRuntimeEnv,
  expectOnlyTeamemMcpIsProxied,
  inspectRuntimePrerequisite,
  TEAMEM_MCP_INSTRUMENTATION_OPTIONS
} from './teamem-live-smoke-helpers.js';
import {
  createDemoRepositoryWorkspace,
  finishDemoRepositoryWorkspace,
  type DemoRepositoryWorkspace
} from './teamem-demo-repository-workspace.js';
import {
  DEFAULT_TEAMEM_INTERACTIVE_PERMISSION_MODE,
  TEAMEM_INTERACTIVE_PERMISSION_MODE_ENV,
  resolveTeamemInteractivePermissionMode
} from './teamem-interactive-permission-mode.js';

const liveGateEnabled = process.env.TEAMEM_CLAUDE_PLUGIN_E2E === '1';
const interactiveGateEnabled =
  process.env.TEAMEM_CLAUDE_PLUGIN_INTERACTIVE_E2E === '1';
const liveInteractiveGateEnabled = liveGateEnabled && interactiveGateEnabled;
const interactivePermissionMode = liveInteractiveGateEnabled
  ? resolveTeamemInteractivePermissionMode()
  : DEFAULT_TEAMEM_INTERACTIVE_PERMISSION_MODE;
const runtimePrerequisite = await inspectRuntimePrerequisite({
  liveGateEnabled: liveInteractiveGateEnabled,
  gateReason: formatInteractiveGateReason()
});
const describeLiveInteractive =
  liveInteractiveGateEnabled && runtimePrerequisite.ok
    ? describe
    : describe.skip;

const repoRoot = process.cwd();
const teamemPluginDir = join(repoRoot, 'plugin');
const LIVE_INTERACTIVE_SMOKE_TEST_TIMEOUT_MS = 180_000;
const INTERACTIVE_READINESS_TIMEOUT_MS = 30_000;
const INTERACTIVE_WAIT_TIMEOUT_MS = 60_000;
const INTERACTIVE_CLOSE_TIMEOUT_MS = 10_000;
const INTERACTIVE_STARTUP_SETTLE_MS = 2_000;
const INTERACTIVE_TYPE_DELAY_MS = 20;
const statusSlashCommand = '/teamem:status';
const briefingSlashCommand = '/teamem:briefing';
const pluginScopedToolPrefix = 'mcp__plugin_teamem_teamem__teamem_';
const requiredStatusTools = [
  'whoami',
  'get_current_sprint',
  'list_claims',
  'get_briefing'
] as const;
const briefingSectionKeys = [
  'current_plan',
  'active_claims',
  'recent_decisions',
  'active_risks',
  'recent_progress'
] as const;
type InteractiveCloseEvent = Extract<
  InteractiveSyntheticEvent,
  { type: 'close-step' | 'close-diagnostic' }
>;
type InteractiveArtifactSummary = {
  kind?: string;
  cwd?: string;
  command?: {
    args?: string[];
  };
  exitStatus?: {
    errorCode?: string;
    errorReason?: string;
  };
  result?: {
    eventCount?: number;
    hookTraceCount?: number;
    mcpTraceCount?: number;
    closeDiagnostics?: InteractiveCloseEvent[];
  };
};

describeLiveInteractive(
  `Teamem interactive briefing live smoke${runtimePrerequisite.ok ? '' : ` (${runtimePrerequisite.reason})`}`,
  () => {
    it(
      'types status and briefing through the Claude Code TTY from a copied demo workspace',
      async () => {
        let workspace: DemoRepositoryWorkspace | undefined;
        const artifactsDir = await mkdtemp(
          join(tmpdir(), 'teamem-interactive-briefing-artifacts-')
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
          expect(boot.instrumentedPlugin.sourcePluginDir).toBe(teamemPluginDir);
          expect(workspace.demoWorkspaceLaunchCwd).not.toBe(teamemPluginDir);
          await expectOnlyTeamemMcpIsProxied(boot);

          const statusPrompt = await tester.slashCommandPrompt('status');
          const briefingPrompt = await tester.slashCommandPrompt('briefing');
          expect(statusPrompt).toBe(statusSlashCommand);
          expect(briefingPrompt).toBe(briefingSlashCommand);

          session = await tester.launchInteractive({
            permissionMode: interactivePermissionMode,
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

          await delay(INTERACTIVE_STARTUP_SETTLE_MS);
          await session.submit(briefingPrompt, {
            delayMs: INTERACTIVE_TYPE_DELAY_MS
          });
          const briefingTraces = await waitForBriefingMcpEvidence(session);
          assertNoTeamemChannelMcpTrace(briefingTraces);
          assertBriefingMcpEvidence({
            traces: briefingTraces,
            artifactsDir: session.artifacts.dir
          });

          await session.submit(statusPrompt, {
            delayMs: INTERACTIVE_TYPE_DELAY_MS
          });
          const statusTraces = await waitForStatusMcpEvidence(session);
          assertNoTeamemChannelMcpTrace(statusTraces);
          assertStatusMcpEvidence(statusTraces, session.artifacts.dir);
          assertBriefingMcpEvidence({
            traces: statusTraces,
            artifactsDir: session.artifacts.dir
          });
          assertSelectedRuntimeContext();
          assertLiveInteractiveInputEvidence(session);
          await session.close();

          await assertInteractiveArtifactsExist(session);
          const [hookTraces, mcpTraces] = await Promise.all([
            readHookTraces(session.artifacts.hookTraceDir),
            readMcpTraces(session.artifacts.mcpTraceDir)
          ]);
          assertMcpTracesClosed(mcpTraces, session.artifacts.dir);
          await assertSessionStartEvidence(hookTraces);
          assertNoTeamemChannelMcpTrace(mcpTraces);
          assertStatusMcpEvidence(mcpTraces, session.artifacts.dir);
          assertBriefingMcpEvidence({
            traces: mcpTraces,
            artifactsDir: session.artifacts.dir
          });
          await assertTeamemMcpTraceEvidence(mcpTraces);
          await assertLaunchDidNotForcePluginData(session.artifacts);
          success = true;
        } finally {
          if (!success && session) {
            try {
              await session.close();
            } catch (err) {
              console.error(
                `Failed to close failed interactive briefing smoke session: ${formatError(err)}`
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
                `Preserving failed demo workspace at ${cleanup.demoWorkspaceLaunchCwd}${cleanup.artifactPath ? ` (report ${cleanup.artifactPath})` : ''}`
              );
            }
          }

          if (success) {
            await rm(artifactsDir, { recursive: true, force: true });
          } else {
            console.error(
              `Preserving failed live interactive briefing smoke artifacts at ${artifactsDir}`
            );
          }
        }
      },
      LIVE_INTERACTIVE_SMOKE_TEST_TIMEOUT_MS
    );
  }
);

function formatInteractiveGateReason(): string {
  if (!liveGateEnabled && !interactiveGateEnabled) {
    return 'set TEAMEM_CLAUDE_PLUGIN_E2E=1 and TEAMEM_CLAUDE_PLUGIN_INTERACTIVE_E2E=1 to run live interactive Claude plugin tests';
  }
  if (!liveGateEnabled) {
    return 'set TEAMEM_CLAUDE_PLUGIN_E2E=1 to run live Claude plugin tests';
  }
  return 'set TEAMEM_CLAUDE_PLUGIN_INTERACTIVE_E2E=1 to run live interactive Claude plugin tests';
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

async function waitForStatusMcpEvidence(
  session: InteractiveSession
): Promise<McpTrace[]> {
  return waitForMcpEvidence(session, (traces) =>
    hasRequiredStatusMcpEvidence(traces)
  );
}

async function waitForBriefingMcpEvidence(
  session: InteractiveSession
): Promise<McpTrace[]> {
  return waitForMcpEvidence(
    session,
    (traces) => countSuccessfulToolResponse(traces, 'get_briefing') > 0
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
    `Timed out waiting for interactive briefing MCP evidence after ${INTERACTIVE_WAIT_TIMEOUT_MS}ms. Last trace summary: ${lastTraceSummary}. Artifacts: ${session.artifacts.dir}. Permission mode env: ${TEAMEM_INTERACTIVE_PERMISSION_MODE_ENV}`
  );
}

function hasRequiredStatusMcpEvidence(traces: McpTrace[]): boolean {
  const observedTools = observedTeamemTools(traces);
  const successfulResponses = observedSuccessfulTeamemToolResponses(traces);
  return requiredStatusTools.every(
    (toolName) =>
      observedTools.includes(toolName) && successfulResponses.includes(toolName)
  );
}

function assertStatusMcpEvidence(
  traces: McpTrace[],
  artifactsDir: string
): void {
  const observedTools = observedTeamemToolsOrThrow(traces, artifactsDir);
  const unexpectedTools = observedTools.filter(
    (toolName) => !isExpectedInteractiveTool(toolName)
  );
  if (unexpectedTools.length > 0) {
    throw new Error(
      `Expected only interactive status/briefing MCP tools ${[
        ...requiredStatusTools
      ].join(
        ', '
      )}, observed unexpected ${unexpectedTools.join(', ')}. Artifacts: ${artifactsDir}`
    );
  }

  const missingRequiredTools = requiredStatusTools.filter(
    (toolName) => !observedTools.includes(toolName)
  );
  if (missingRequiredTools.length > 0) {
    throw new Error(
      `Expected status MCP tool calls for ${missingRequiredTools.join(', ')}. Observed ${observedTools.join(', ') || 'none'}. Artifacts: ${artifactsDir}`
    );
  }

  const successfulResponses = observedSuccessfulTeamemToolResponses(traces);
  const missingSuccessfulResponses = requiredStatusTools.filter(
    (toolName) => !successfulResponses.includes(toolName)
  );
  if (missingSuccessfulResponses.length > 0) {
    throw new Error(
      `Expected successful status MCP responses for ${missingSuccessfulResponses.join(', ')}. Observed successful responses ${successfulResponses.join(', ') || 'none'}. ${summarizeTeamemResponseMetadata(traces)}. Artifacts: ${artifactsDir}`
    );
  }
}

function assertBriefingMcpEvidence(input: {
  traces: McpTrace[];
  artifactsDir: string;
}): void {
  const successfulBriefingResponses = successfulTeamemToolResponseMessages(
    input.traces,
    'get_briefing'
  );
  const briefingResponseCount = successfulBriefingResponses.length;

  if (briefingResponseCount === 0) {
    throw new Error(
      `Expected at least one successful get_briefing MCP response. Observed ${briefingResponseCount}. ${summarizeTeamemResponseMetadata(input.traces)}. Artifacts: ${input.artifactsDir}`
    );
  }

  for (const response of successfulBriefingResponses) {
    assertBriefingResponseShape(response, input.artifactsDir);
  }
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

function observedTeamemTools(traces: McpTrace[]): string[] {
  const teamemTrace = traces.find((trace) => trace.serverName === 'teamem');
  if (!teamemTrace) {
    return [];
  }

  return teamemTrace.messages
    .filter(
      (message) =>
        message.direction === 'client-to-server' &&
        message.method === 'tools/call' &&
        typeof message.metadata?.toolName === 'string'
    )
    .map((message) =>
      normalizeTeamemToolName(message.metadata?.toolName ?? '')
    );
}

function observedSuccessfulTeamemToolResponses(traces: McpTrace[]): string[] {
  return successfulTeamemToolResponseMessages(traces).map((message) =>
    normalizeTeamemToolName(message.metadata?.toolName ?? '')
  );
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

function countSuccessfulToolResponse(
  traces: McpTrace[],
  expectedToolName: string
): number {
  return successfulTeamemToolResponseMessages(traces, expectedToolName).length;
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

function isExpectedInteractiveTool(toolName: string): boolean {
  return requiredStatusTools.includes(
    toolName as (typeof requiredStatusTools)[number]
  );
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
  ) as InteractiveArtifactSummary;
  const interactiveEvents = JSON.parse(
    await readFile(session.artifacts.interactiveEventsPath, 'utf8')
  ) as InteractiveSyntheticEvent[];

  expect(summary.kind).toBe('interactive');
  expect(summary.command?.args).toEqual(session.command.args);
  expect(summary.exitStatus?.errorCode).toBeUndefined();
  expect(summary.cwd).toBe(session.cwd);
  expect(summary.result?.eventCount ?? 0).toBeGreaterThan(0);
  expect(summary.result?.hookTraceCount ?? 0).toBeGreaterThan(0);
  expect(summary.result?.mcpTraceCount ?? 0).toBeGreaterThan(0);
  assertInteractiveCloseEvidence({ summary, interactiveEvents });
}

function assertInteractiveCloseEvidence(input: {
  summary: InteractiveArtifactSummary;
  interactiveEvents: InteractiveSyntheticEvent[];
}): void {
  const exitEvents = input.interactiveEvents.filter(
    (event) => event.type === 'exit'
  );
  expect(exitEvents.length).toBeGreaterThan(0);

  const closeEvents = input.interactiveEvents.filter(
    (event): event is InteractiveCloseEvent =>
      event.type === 'close-step' || event.type === 'close-diagnostic'
  );
  expect(closeEvents.length).toBeGreaterThan(0);
  expect(input.summary.result?.closeDiagnostics).toEqual(closeEvents);

  const failedCloseDiagnostics = closeEvents.filter(
    (event) => event.type === 'close-diagnostic' && !event.ok
  );
  expect(failedCloseDiagnostics).toEqual([]);

  const processKillingCloseSteps = closeEvents.filter(
    (event) =>
      event.type === 'close-step' &&
      (event.step === 'kill' || event.step === 'force-kill')
  );
  expect(processKillingCloseSteps).toEqual([]);

  const closeDiagnostics = closeEvents.filter(
    (
      event
    ): event is Extract<InteractiveCloseEvent, { type: 'close-diagnostic' }> =>
      event.type === 'close-diagnostic'
  );
  expect(closeDiagnostics.length).toBeGreaterThan(0);

  const closeDiagnosticPids = [
    ...new Set(
      closeDiagnostics.map((event) => {
        expect(event.pidKind).toBe('pty');
        expect(event.ptyPid ?? event.pid).toBe(event.pid);
        if (typeof event.bridgePid === 'number') {
          expect(event.pid).not.toBe(event.bridgePid);
        }
        return event.pid;
      })
    )
  ].filter((pid) => Number.isInteger(pid) && pid > 0);
  expect(closeDiagnosticPids.length).toBeGreaterThan(0);
  for (const pid of closeDiagnosticPids) {
    expect(isPidAlive(pid)).toBe(false);
  }

  const exitPids = [
    ...new Set(
      exitEvents.map((event) => {
        expect(event.source).toBe('pty');
        expect(event.pidKind).toBe('pty');
        if (typeof event.bridgePid === 'number') {
          expect(event.pid).not.toBe(event.bridgePid);
        }
        return event.pid;
      })
    )
  ];
  for (const pid of exitPids) {
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
      continue;
    }
    expect(isPidAlive(pid)).toBe(false);
  }
}

function assertMcpTracesClosed(traces: McpTrace[], artifactsDir: string): void {
  const erroredTraces = traces.filter((trace) => trace.error);
  if (erroredTraces.length > 0) {
    throw new Error(
      `Expected MCP traces to close without proxy errors, observed ${erroredTraces.map((trace) => `${trace.serverName}:${trace.error}`).join(', ')}. Artifacts: ${artifactsDir}`
    );
  }

  const unexpectedPartialTraces = traces.filter(
    (trace) => trace.partial && !isExpectedInteractiveMcpShutdown(trace)
  );
  if (unexpectedPartialTraces.length > 0) {
    throw new Error(
      `Expected partial MCP traces after interactive session close to come only from signal shutdown, observed ${unexpectedPartialTraces.map((trace) => `${trace.serverName}:${trace.terminationReason}`).join(', ')}. Artifacts: ${artifactsDir}`
    );
  }
}

function isExpectedInteractiveMcpShutdown(trace: McpTrace): boolean {
  return (
    trace.exitCode === 130 ||
    trace.signal === 'SIGINT' ||
    trace.terminationReason.startsWith('process-signal:')
  );
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ESRCH') {
      return false;
    }
    if (isErrnoException(error) && error.code === 'EPERM') {
      return true;
    }
    throw error;
  }
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function assertLiveInteractiveInputEvidence(session: InteractiveSession): void {
  const submittedText = session
    .events()
    .filter((event) => event.type === 'input' && event.source === 'submit')
    .map((event) => ('data' in event ? event.data : ''))
    .join('');

  expect(submittedText).toContain(statusSlashCommand);
  expect(submittedText).toContain(briefingSlashCommand);
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
