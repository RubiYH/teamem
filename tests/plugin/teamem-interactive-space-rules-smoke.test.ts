import { describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import {
  createClaudePluginTester,
  normalizeTranscript,
  readHookTraces,
  readMcpTraces,
  type BootResult,
  type HookTrace,
  type InteractiveSession,
  type InteractiveSyntheticEvent,
  type McpTrace
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

type SpaceRulesSnapshot = {
  has_server_rules: boolean;
  rendered_rules_body: string;
  metadata: {
    format_version: number;
    source: string;
    managed_begin: string;
    managed_end: string;
    rules_version: number;
    rules_hash: string;
    generated_at: string;
    space_id?: string | null;
    space_label?: string | null;
    source_event_id?: string | null;
    snapshot_updated_at?: string | null;
    snapshot_updated_by?: string | null;
  };
};

type SnapshotCache = {
  saved_at?: string;
  snapshot?: SpaceRulesSnapshot;
};

type OptionalFileState =
  | { exists: true; content: string }
  | { exists: false; content?: undefined };

const liveGateEnabled = process.env.TEAMEM_CLAUDE_PLUGIN_E2E === '1';
const interactiveGateEnabled =
  process.env.TEAMEM_CLAUDE_PLUGIN_INTERACTIVE_E2E === '1';
const liveInteractiveGateEnabled = liveGateEnabled && interactiveGateEnabled;
const interactivePermissionMode = liveInteractiveGateEnabled
  ? resolveTeamemInteractivePermissionMode(
      process.env,
      DEFAULT_TEAMEM_INTERACTIVE_SCRIPT_PERMISSION_MODE
    )
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
const FILE_POLL_TIMEOUT_MS = 45_000;
const ruleInitSlashCommand = '/teamem:rule init';
const pluginScopedToolPrefix = 'mcp__plugin_teamem_teamem__teamem_';
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
  `Teamem interactive non-stateful Space Rules init live smoke${runtimePrerequisite.ok ? '' : ` (${runtimePrerequisite.reason})`}`,
  () => {
    it(
      'types /teamem:rule init through the Claude Code TTY and writes only the copied workspace cache',
      async () => {
        if (!runtimePrerequisite.ok) {
          throw new Error(runtimePrerequisite.reason);
        }

        const sourceTeamemBefore = await readOptionalFile(
          join(repoRoot, 'TEAMEM.md')
        );
        const expectedSnapshotResponse =
          await callLiveRuntimeTool<SpaceRulesSnapshot>(
            runtimePrerequisite.selectedEntry,
            'teamem.export_space_rules_snapshot'
          );
        const expectedSnapshot = expectedSnapshotResponse.data;
        let workspace: DemoRepositoryWorkspace | undefined;
        const artifactsDir = await mkdtemp(
          join(tmpdir(), 'teamem-interactive-space-rules-artifacts-')
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
          expect(workspace.demoWorkspaceLaunchCwd).not.toBe(repoRoot);
          await expectOnlyTeamemMcpIsProxied(boot);

          const ruleInitPrompt = await tester.slashCommandPrompt(
            'rule',
            'init'
          );
          expect(ruleInitPrompt).toBe(ruleInitSlashCommand);

          session = await tester.launchInteractive({
            permissionMode: interactivePermissionMode,
            allowedTools: ['Bash(bash:*)'],
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
              `${pluginScopedToolPrefix}share_finding`,
              `${pluginScopedToolPrefix}get_finding`,
              `${pluginScopedToolPrefix}acknowledge_finding`,
              `${pluginScopedToolPrefix}get_briefing`,
              `${pluginScopedToolPrefix}export_space_rules_snapshot`,
              `${pluginScopedToolPrefix}publish_space_rules_snapshot`,
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
          const workspaceTeamemBeforeCommand =
            await resetWorkspaceSpaceRulesOutputs(
              workspace.demoWorkspaceLaunchCwd
            );
          await assertSourceTeamemUnchanged(sourceTeamemBefore);
          await session.submit(ruleInitPrompt, {
            delayMs: INTERACTIVE_TYPE_DELAY_MS
          });
          await assertRuleInitCommandEvidence(session);

          const workspaceEvidence = await waitForWorkspaceSpaceRulesEvidence({
            workspaceRoot: workspace.demoWorkspaceLaunchCwd,
            expectedSnapshot,
            teamemBeforeCommand: workspaceTeamemBeforeCommand
          });
          assertWorkspaceOnlyPaths(workspace.demoWorkspaceLaunchCwd, [
            workspaceEvidence.teamemPath,
            workspaceEvidence.cachePath
          ]);
          await assertSourceTeamemUnchanged(sourceTeamemBefore);
          assertLiveInteractiveInputEvidence(session, ruleInitPrompt);
          await session.close();

          await assertInteractiveArtifactsExist(session);
          const [hookTraces, mcpTraces] = await Promise.all([
            readHookTraces(session.artifacts.hookTraceDir),
            readMcpTraces(session.artifacts.mcpTraceDir)
          ]);
          assertMcpTracesClosed(mcpTraces, session.artifacts.dir);
          await assertSessionStartEvidence(hookTraces);
          assertNoTeamemChannelMcpTrace(mcpTraces);
          assertNoTeamemMcpToolCallTrace(mcpTraces, session.artifacts.dir);
          await assertTeamemMcpTraceEvidence(mcpTraces);
          await assertLaunchDidNotForcePluginData(session.artifacts);
          await assertSourceTeamemUnchanged(sourceTeamemBefore);
          success = true;
        } finally {
          if (!success && session) {
            try {
              await session.close();
            } catch (err) {
              console.error(
                `Failed to close failed interactive Space Rules smoke session: ${formatError(err)}`
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
              `Preserving failed live interactive Space Rules smoke artifacts at ${artifactsDir}`
            );
          }
        }
      },
      LIVE_INTERACTIVE_SMOKE_TEST_TIMEOUT_MS
    );
  }
);

function formatInteractiveGateReason(): string {
  const baseReason =
    'Space Rules init only reads teamem.export_space_rules_snapshot and writes local TEAMEM.md/.teamem cache, so no stateful live gate is required';
  if (!liveGateEnabled && !interactiveGateEnabled) {
    return `${baseReason}; set TEAMEM_CLAUDE_PLUGIN_E2E=1 and TEAMEM_CLAUDE_PLUGIN_INTERACTIVE_E2E=1 to run live interactive Claude plugin tests`;
  }
  if (!liveGateEnabled) {
    return `${baseReason}; set TEAMEM_CLAUDE_PLUGIN_E2E=1 to run live Claude plugin tests`;
  }
  return `${baseReason}; set TEAMEM_CLAUDE_PLUGIN_INTERACTIVE_E2E=1 to run live interactive Claude plugin tests`;
}

async function resetWorkspaceSpaceRulesOutputs(
  workspaceRoot: string
): Promise<OptionalFileState> {
  const teamemPath = join(workspaceRoot, 'TEAMEM.md');
  const cachePath = join(workspaceRoot, '.teamem', 'space-rules-snapshot.json');
  const teamemStateBeforeReset = await readOptionalFile(teamemPath);

  await Promise.all([
    rm(teamemPath, { force: true }),
    rm(join(workspaceRoot, '.teamem'), { recursive: true, force: true })
  ]);

  await expect(readOptionalFile(teamemPath)).resolves.toEqual({
    exists: false
  });
  await expect(readOptionalFile(cachePath)).resolves.toEqual({
    exists: false
  });
  expect(teamemStateBeforeReset.exists).toBe(true);

  return { exists: false };
}

async function assertRuleInitCommandEvidence(
  session: InteractiveSession
): Promise<void> {
  await session.waitFor(hasRuleInitTranscriptEvidence, {
    timeoutMs: INTERACTIVE_WAIT_TIMEOUT_MS
  });
  expect(hasRuleInitTranscriptEvidence(session.normalizedTranscript())).toBe(
    true
  );
}

function hasRuleInitTranscriptEvidence(transcript: string): boolean {
  const normalized = normalizeTranscript(transcript);

  return (
    normalized.includes('teamem-rule-init.sh') ||
    normalized.includes('Initialized TEAMEM.md') ||
    normalized.includes('Teamem-managed Space Rules block')
  );
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

async function waitForWorkspaceSpaceRulesEvidence(input: {
  workspaceRoot: string;
  expectedSnapshot: SpaceRulesSnapshot;
  teamemBeforeCommand: OptionalFileState;
}): Promise<{
  teamemPath: string;
  cachePath: string;
  teamem: string;
  cache: SnapshotCache;
}> {
  const teamemPath = join(input.workspaceRoot, 'TEAMEM.md');
  const cachePath = join(
    input.workspaceRoot,
    '.teamem',
    'space-rules-snapshot.json'
  );
  const deadline = Date.now() + FILE_POLL_TIMEOUT_MS;
  let lastSummary = 'TEAMEM.md/cache not observed yet';

  while (Date.now() < deadline) {
    const [teamemState, cacheState] = await Promise.all([
      readOptionalFile(teamemPath),
      readOptionalFile(cachePath)
    ]);

    if (teamemState.exists && cacheState.exists) {
      try {
        const cache = JSON.parse(cacheState.content) as SnapshotCache;
        assertSpaceRulesFilesystemEvidence({
          teamem: teamemState.content,
          cache,
          expectedSnapshot: input.expectedSnapshot,
          teamemBeforeCommand: input.teamemBeforeCommand
        });

        return {
          teamemPath,
          cachePath,
          teamem: teamemState.content,
          cache
        };
      } catch (err) {
        lastSummary = formatError(err);
      }
    } else {
      lastSummary = `TEAMEM.md exists=${teamemState.exists}; cache exists=${cacheState.exists}`;
    }

    await delay(250);
  }

  throw new Error(
    `Timed out waiting for Space Rules filesystem evidence after ${FILE_POLL_TIMEOUT_MS}ms. Last state: ${lastSummary}. Permission mode env: ${TEAMEM_INTERACTIVE_PERMISSION_MODE_ENV}. Workspace: ${input.workspaceRoot}`
  );
}

function assertSpaceRulesFilesystemEvidence(input: {
  teamem: string;
  cache: SnapshotCache;
  expectedSnapshot: SpaceRulesSnapshot;
  teamemBeforeCommand: OptionalFileState;
}): void {
  expect(input.teamemBeforeCommand).toEqual({ exists: false });
  expect(normalizeGeneratedAt(input.cache.snapshot)).toEqual(
    normalizeGeneratedAt(input.expectedSnapshot)
  );
  expect(input.cache.saved_at).toEqual(expect.any(String));
  expect(input.cache.snapshot?.metadata.generated_at).toEqual(
    expect.any(String)
  );
  expect(input.teamem.length).toBeGreaterThan(0);

  if (!input.expectedSnapshot.has_server_rules) {
    expect(input.cache.snapshot?.has_server_rules).toBe(false);
    expect(input.cache.snapshot?.metadata).toEqual(
      expect.objectContaining({
        ...input.expectedSnapshot.metadata,
        generated_at: expect.any(String)
      })
    );
    expect(input.teamem).toContain('# TEAMEM.md');
    expect(input.teamem).toContain('## Local Notes');
    expect(input.teamem).toContain('## Teamem Space Rules');
    expect(input.teamem).toContain('Run `/teamem:rule init`');
    expect(input.teamem).not.toContain(
      input.expectedSnapshot.metadata.managed_begin
    );
    expect(input.teamem).not.toContain(
      input.expectedSnapshot.metadata.managed_end
    );
    return;
  }

  const metadata = input.expectedSnapshot.metadata;
  expect(metadata.rules_hash).toBeTruthy();
  expect(metadata.rules_version).toBeGreaterThan(0);
  expect(metadata.space_id || metadata.space_label).toBeTruthy();
  expect(input.teamem).toContain(metadata.managed_begin);
  expect(input.teamem).toContain(metadata.managed_end);
  expect(countOccurrences(input.teamem, metadata.managed_begin)).toBe(1);
  expect(countOccurrences(input.teamem, metadata.managed_end)).toBe(1);
  expect(input.teamem).toContain(input.expectedSnapshot.rendered_rules_body);

  const parsedMetadata = parseManagedBlockMetadata(input.teamem, metadata);
  expect(parsedMetadata).toEqual(
    expect.objectContaining({
      ...metadata,
      generated_at: expect.any(String)
    })
  );
  expect(parsedMetadata.rules_hash).toBe(metadata.rules_hash);
  expect(parsedMetadata.rules_version).toBe(metadata.rules_version);
  if (metadata.space_id) {
    expect(parsedMetadata.space_id).toBe(metadata.space_id);
  } else {
    expect(parsedMetadata.space_label).toBe(metadata.space_label);
  }

  const body = managedBlockBody(input.teamem, metadata);
  expect(body).toBe(input.expectedSnapshot.rendered_rules_body);
}

function normalizeGeneratedAt(snapshot: SpaceRulesSnapshot | undefined): Omit<
  SpaceRulesSnapshot,
  'metadata'
> & {
  metadata: Omit<SpaceRulesSnapshot['metadata'], 'generated_at'>;
} {
  expect(snapshot).toBeDefined();
  if (!snapshot) {
    throw new Error('Expected Space Rules snapshot to be defined');
  }
  const { generated_at, ...metadata } = snapshot.metadata;
  expect(generated_at).toEqual(expect.any(String));
  return {
    ...snapshot,
    metadata
  };
}

function parseManagedBlockMetadata(
  teamem: string,
  metadata: SpaceRulesSnapshot['metadata']
): SpaceRulesSnapshot['metadata'] {
  const block = managedBlock(teamem, metadata);
  const metadataLine = block
    .split('\n')
    .find((line) => line.startsWith('<!-- teamem:space-rules '));
  expect(metadataLine).toBeTruthy();

  return JSON.parse(
    metadataLine?.replace('<!-- teamem:space-rules ', '').replace(' -->', '') ??
      '{}'
  ) as SpaceRulesSnapshot['metadata'];
}

function managedBlockBody(
  teamem: string,
  metadata: SpaceRulesSnapshot['metadata']
): string {
  const block = managedBlock(teamem, metadata);
  const lines = block.split('\n');
  return lines.slice(2, -1).join('\n');
}

function managedBlock(
  teamem: string,
  metadata: SpaceRulesSnapshot['metadata']
): string {
  const begin = teamem.indexOf(metadata.managed_begin);
  const end = teamem.indexOf(metadata.managed_end);
  expect(begin).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(begin);

  return teamem.slice(begin, end + metadata.managed_end.length);
}

function countOccurrences(value: string, needle: string): number {
  expect(needle.length).toBeGreaterThan(0);
  return value.split(needle).length - 1;
}

function assertWorkspaceOnlyPaths(
  workspaceRoot: string,
  paths: string[]
): void {
  for (const filePath of paths) {
    expect(isPathInside(workspaceRoot, filePath)).toBe(true);
    expect(isPathInside(repoRoot, filePath)).toBe(false);
  }
}

async function assertSourceTeamemUnchanged(
  before: OptionalFileState
): Promise<void> {
  await expect(readOptionalFile(join(repoRoot, 'TEAMEM.md'))).resolves.toEqual(
    before
  );
}

async function readOptionalFile(path: string): Promise<OptionalFileState> {
  try {
    return { exists: true, content: await readFile(path, 'utf8') };
  } catch (err) {
    if (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      err.code === 'ENOENT'
    ) {
      return { exists: false };
    }
    throw err;
  }
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

function assertLiveInteractiveInputEvidence(
  session: InteractiveSession,
  ruleInitPrompt: string
): void {
  const submittedText = session
    .events()
    .filter((event) => event.type === 'input' && event.source === 'submit')
    .map((event) => ('data' in event ? event.data : ''))
    .join('');

  expect(submittedText).toContain(ruleInitPrompt);
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

function assertNoTeamemMcpToolCallTrace(
  traces: McpTrace[],
  artifactsDir: string
): void {
  const teamemTrace = traces.find((trace) => trace.serverName === 'teamem');
  const toolCalls =
    teamemTrace?.messages.filter(
      (message) =>
        message.direction === 'client-to-server' &&
        message.method === 'tools/call'
    ) ?? [];

  if (toolCalls.length > 0) {
    throw new Error(
      `Expected /teamem:rule init to use Bash/direct teamem-call rather than Teamem MCP tool calls. Observed ${toolCalls
        .map((message) => message.metadata?.toolName ?? 'unknown')
        .join(', ')}. Artifacts: ${artifactsDir}`
    );
  }
}

function isPathInside(parent: string, child: string): boolean {
  const relativePath = relative(resolve(parent), resolve(child));
  return (
    relativePath.length > 0 &&
    !relativePath.startsWith('..') &&
    !relativePath.includes(`..${sep}`)
  );
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
