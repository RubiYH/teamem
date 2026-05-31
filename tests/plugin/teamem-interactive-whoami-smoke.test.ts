import { describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createClaudePluginTester,
  normalizeTranscript,
  readHookTraces,
  readMcpTraces,
  type HookTrace,
  type InteractiveSession,
  type McpTrace
} from '../../plugin-e2e-module/src/index.js';
import {
  assertLaunchDidNotForcePluginData,
  assertNoTeamemChannelMcpTrace,
  assertObservedPluginDataIsRedacted,
  assertTraceArtifactsExist,
  assertWhoamiMcpEvidence,
  createLiveRuntimeEnv,
  expectOnlyTeamemMcpIsProxied,
  initGitRepo,
  inspectRuntimePrerequisite
} from './teamem-live-smoke-helpers.js';
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
const LIVE_INTERACTIVE_SMOKE_TEST_TIMEOUT_MS = 120_000;
const INTERACTIVE_READINESS_TIMEOUT_MS = 30_000;
const INTERACTIVE_WAIT_TIMEOUT_MS = 45_000;
const INTERACTIVE_CLOSE_TIMEOUT_MS = 10_000;
const INTERACTIVE_STARTUP_SETTLE_MS = 2_000;
const INTERACTIVE_TYPE_DELAY_MS = 20;
const whoamiSlashCommand = '/teamem:teamem-whoami';
const pluginScopedToolPrefix = 'mcp__plugin_teamem_teamem__teamem_';

describeLiveInteractive(
  `Teamem interactive whoami live smoke${runtimePrerequisite.ok ? '' : ` (${runtimePrerequisite.reason})`}`,
  () => {
    it(
      'types /teamem:teamem-whoami through the Claude Code TTY',
      async () => {
        const cwd = await mkdtemp(join(tmpdir(), 'teamem-interactive-cwd-'));
        const artifactsDir = await mkdtemp(
          join(tmpdir(), 'teamem-interactive-artifacts-')
        );
        let session: InteractiveSession | undefined;
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
              interactiveReadinessMs: INTERACTIVE_READINESS_TIMEOUT_MS,
              interactiveWaitMs: INTERACTIVE_WAIT_TIMEOUT_MS,
              interactiveCloseMs: INTERACTIVE_CLOSE_TIMEOUT_MS
            }
          });
          const boot = await tester.boot();

          await expectOnlyTeamemMcpIsProxied(boot);

          const commandPrompt =
            await tester.slashCommandPrompt('teamem-whoami');
          expect(commandPrompt).toBe(whoamiSlashCommand);

          session = await tester.launchInteractive({
            permissionMode: interactivePermissionMode,
            allowedTools: [`${pluginScopedToolPrefix}whoami`],
            disallowedTools: [
              `${pluginScopedToolPrefix}get_current_sprint`,
              `${pluginScopedToolPrefix}list_claims`,
              `${pluginScopedToolPrefix}get_briefing`
            ],
            readiness: isClaudeInteractiveReady,
            readinessTimeoutMs: INTERACTIVE_READINESS_TIMEOUT_MS,
            waitTimeoutMs: INTERACTIVE_WAIT_TIMEOUT_MS,
            closeTimeoutMs: INTERACTIVE_CLOSE_TIMEOUT_MS
          });
          expectPermissionModeLaunchArgs(
            session.command.args,
            interactivePermissionMode
          );

          await delay(INTERACTIVE_STARTUP_SETTLE_MS);
          await session.submit(commandPrompt, {
            delayMs: INTERACTIVE_TYPE_DELAY_MS
          });
          const liveMcpTraces = await waitForWhoamiMcpEvidence(session);
          assertNoTeamemChannelMcpTrace(liveMcpTraces);
          assertWhoamiMcpEvidence(liveMcpTraces);
          await session.close();

          await assertInteractiveArtifactsExist(session);
          const [hookTraces, mcpTraces] = await Promise.all([
            readHookTraces(session.artifacts.hookTraceDir),
            readMcpTraces(session.artifacts.mcpTraceDir)
          ]);
          await assertSessionStartEvidence(hookTraces);
          assertNoTeamemChannelMcpTrace(mcpTraces);
          assertWhoamiMcpEvidence(mcpTraces);
          await assertTeamemMcpTraceEvidence(mcpTraces);
          await assertLaunchDidNotForcePluginData(session.artifacts);
          success = true;
        } finally {
          if (!success && session) {
            try {
              await session.close();
            } catch (err) {
              console.error(
                `Failed to close failed interactive smoke session: ${formatError(err)}`
              );
            }
          }

          if (success) {
            await rm(artifactsDir, { recursive: true, force: true });
            await rm(cwd, { recursive: true, force: true });
          } else {
            console.error(
              `Preserving failed live interactive smoke artifacts at ${artifactsDir} and cwd ${cwd}`
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

function expectPermissionModeLaunchArgs(
  args: string[],
  permissionMode: string
): void {
  const permissionFlagIndex = args.indexOf('--permission-mode');
  expect(permissionFlagIndex).toBeGreaterThanOrEqual(0);
  expect(args[permissionFlagIndex + 1]).toBe(permissionMode);
}

function isClaudeInteractiveReady(transcript: string): boolean {
  const normalized = normalizeTranscript(transcript);

  return (
    /(^|\n)\s*[>›]\s*$/.test(normalized) ||
    /\btry ["'].*["']/i.test(normalized)
  );
}

async function waitForWhoamiMcpEvidence(
  session: InteractiveSession
): Promise<McpTrace[]> {
  const deadline = Date.now() + INTERACTIVE_WAIT_TIMEOUT_MS;
  let lastTraceSummary = 'no MCP traces observed';

  while (Date.now() < deadline) {
    const traces = await readMcpTraces(session.artifacts.mcpTraceDir, {
      ignoreTransientErrors: true
    });
    const teamemTrace = traces.find((trace) => trace.serverName === 'teamem');
    const toolCall = teamemTrace?.messages.find(
      (message) =>
        message.direction === 'client-to-server' &&
        message.method === 'tools/call'
    );

    if (toolCall) {
      return traces;
    }

    lastTraceSummary =
      traces.length === 0
        ? 'no MCP traces observed'
        : traces
            .map(
              (trace) =>
                `${trace.serverName}:${trace.messages
                  .map((message) => message.method ?? 'unknown')
                  .join(',') || 'no messages'}`
            )
            .join('; ');
    await delay(250);
  }

  throw new Error(
    `Timed out waiting for live teamem tools/call MCP evidence after ${INTERACTIVE_WAIT_TIMEOUT_MS}ms. Last trace summary: ${lastTraceSummary}. Artifacts: ${session.artifacts.dir}. Permission mode env: ${TEAMEM_INTERACTIVE_PERMISSION_MODE_ENV}`
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
  ) as {
    kind?: string;
    result?: {
      eventCount?: number;
      hookTraceCount?: number;
      mcpTraceCount?: number;
    };
  };

  expect(summary.kind).toBe('interactive');
  expect(summary.result?.eventCount ?? 0).toBeGreaterThan(0);
  expect(summary.result?.hookTraceCount ?? 0).toBeGreaterThan(0);
  expect(summary.result?.mcpTraceCount ?? 0).toBeGreaterThan(0);
}

async function assertSessionStartEvidence(
  traces: HookTrace[]
): Promise<void> {
  const sessionStart = traces.find((trace) => trace.event === 'SessionStart');
  expect(sessionStart).toBeDefined();

  if (sessionStart) {
    expect(sessionStart.exitCode).toBe(0);
    await assertTraceArtifactsExist(sessionStart);
    assertObservedPluginDataIsRedacted(sessionStart);
  }
}

async function assertTeamemMcpTraceEvidence(
  traces: McpTrace[]
): Promise<void> {
  const teamemTrace = traces.find((trace) => trace.serverName === 'teamem');
  expect(teamemTrace).toBeDefined();

  if (teamemTrace) {
    await assertTraceArtifactsExist(teamemTrace);
    assertObservedPluginDataIsRedacted(teamemTrace);
  }
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
