import { describe, expect, it } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile
} from 'node:fs/promises';
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
  type McpTrace
} from '../../plugin-e2e-module/src/index.js';
import {
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
  TEAMEM_INTERACTIVE_PERMISSION_MODE_ENV,
  resolveTeamemInteractivePermissionMode
} from './teamem-interactive-permission-mode.js';

type RuntimeClaim = {
  claim_id: string;
  principal: string;
  repo_id: string;
  branch: string;
  path: string;
  mode: string;
  status: string;
  paused_at: string | null;
  paused_reason: string | null;
  created_at: string;
  last_edit_at: string | null;
  expires_at: string | null;
  sprint_id: string | null;
  context: 'space' | 'sprint';
};

type RuntimeClaims = {
  claims: RuntimeClaim[];
};

type RuntimeReleaseScope = {
  released: boolean;
};

const liveGateEnabled = process.env.TEAMEM_CLAUDE_PLUGIN_E2E === '1';
const interactiveGateEnabled =
  process.env.TEAMEM_CLAUDE_PLUGIN_INTERACTIVE_E2E === '1';
const statefulGateEnabled =
  process.env.TEAMEM_CLAUDE_PLUGIN_STATEFUL_E2E === '1';
const liveInteractiveStatefulGateEnabled =
  liveGateEnabled && interactiveGateEnabled && statefulGateEnabled;
const interactivePermissionMode = liveInteractiveStatefulGateEnabled
  ? resolveTeamemInteractivePermissionMode()
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
const INTERACTIVE_WAIT_TIMEOUT_MS = 90_000;
const INTERACTIVE_CLOSE_TIMEOUT_MS = 10_000;
const INTERACTIVE_STARTUP_SETTLE_MS = 2_000;
const INTERACTIVE_TYPE_DELAY_MS = 20;
const LIVE_RUNTIME_POLL_TIMEOUT_MS = 45_000;
const FILE_POLL_TIMEOUT_MS = 60_000;
const TARGET_PATH = 'src/features/collaboration-board.ts';
const pluginScopedToolPrefix = 'mcp__plugin_teamem_teamem__teamem_';

describeLiveInteractiveStateful(
  `Teamem interactive scope claims live smoke${runtimePrerequisite.ok ? '' : ` (${runtimePrerequisite.reason})`}`,
  () => {
    it(
      'auto-claims a copied demo repository file before a real Claude Code edit',
      async () => {
        if (!runtimePrerequisite.ok) {
          throw new Error(runtimePrerequisite.reason);
        }

        await withLiveInteractiveSmokeLock(
          'teamem-interactive-scope-claims-smoke',
          async () => {
            const runId = createRunId();
            const marker = `// teamem-scope-claim-smoke: ${runId}`;
            const editPrompt = [
              `Edit ${TARGET_PATH}.`,
              `Add this exact line immediately above "export const demoBoard": ${marker}`,
              'Use the Edit tool for the change.',
              'Do not modify any other file. After the edit, stop.'
            ].join(' ');
            const sourceFixtureBefore = await readFile(
              join(
                repoRoot,
                'tests/fixtures/demo-repository-template',
                TARGET_PATH
              ),
              'utf8'
            );
            let workspace: DemoRepositoryWorkspace | undefined;
            const artifactsDir = await mkdtemp(
              join(tmpdir(), 'teamem-interactive-scope-claims-artifacts-')
            );
            const isolatedPluginDataDir = join(
              artifactsDir,
              'teamem-plugin-data'
            );
            let session: InteractiveSession | undefined;
            let observedClaim: RuntimeClaim | undefined;
            let releaseSucceeded = false;
            let success = false;

            try {
              workspace = await createDemoRepositoryWorkspace({
                teamemSourceRoot: repoRoot
              });
              const projectId = workspace.demoWorkspaceLaunchCwd;
              const expectedRepoId = await realpath(
                workspace.demoWorkspaceLaunchCwd
              );

              const tester = createClaudePluginTester({
                pluginDir: teamemPluginDir,
                cwd: workspace.demoWorkspaceLaunchCwd,
                artifactsDir,
                cleanup: 'never',
                mcp: TEAMEM_MCP_INSTRUMENTATION_OPTIONS,
                env: createLiveInteractiveRuntimeEnv({
                  pluginDataDir: isolatedPluginDataDir,
                  spaceId: runtimePrerequisite.selectedEntry.space_id,
                  projectId
                }),
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
              expect(workspace.demoWorkspaceLaunchCwd).not.toBe(repoRoot);
              await expectOnlyTeamemMcpIsProxied(boot);

              session = await tester.launchInteractive({
                permissionMode: interactivePermissionMode,
                allowedTools: ['Read', 'Edit', 'MultiEdit', 'Write'],
                disallowedTools: [
                  'Bash(*)',
                  'NotebookEdit',
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

              await prepareProjectActivation({
                pluginDataDir: isolatedPluginDataDir,
                projectRoot: projectId
              });
              await prepareProjectActivation({
                pluginDataDir: isolatedPluginDataDir,
                projectRoot: expectedRepoId
              });
              await delay(INTERACTIVE_STARTUP_SETTLE_MS);
              await session.submit(editPrompt, {
                delayMs: INTERACTIVE_TYPE_DELAY_MS
              });

              observedClaim = await waitForRuntimeClaim({
                repoId: expectedRepoId,
                targetPath: TARGET_PATH,
                runId
              });
              await waitForCopiedWorkspaceMarker({
                workspaceRoot: workspace.demoWorkspaceLaunchCwd,
                marker,
                runId
              });
              await assertSourceFixtureUnchanged(sourceFixtureBefore);
              assertLiveInteractiveInputEvidence(session, editPrompt, marker);
              await session.close();

              await assertInteractiveArtifactsExist(session);
              const [hookTraces, mcpTraces] = await Promise.all([
                readHookTraces(session.artifacts.hookTraceDir),
                readMcpTraces(session.artifacts.mcpTraceDir)
              ]);
              await assertSessionStartEvidence(hookTraces);
              assertPreToolUseClaimHookEvidence({
                traces: hookTraces,
                artifactsDir: session.artifacts.dir,
                targetPath: TARGET_PATH
              });
              assertNoTeamemChannelMcpTrace(mcpTraces);
              await assertTeamemMcpTraceEvidence(mcpTraces);
              await assertLaunchUsesIsolatedPluginData(session.artifacts);

              await releaseRuntimeClaim(observedClaim.claim_id);
              releaseSucceeded = true;
              await waitForRuntimeClaimRelease(observedClaim.claim_id, runId);

              success = true;
            } catch (err) {
              throw withArtifactError(err, artifactsDir, runId);
            } finally {
              if (observedClaim && !releaseSucceeded) {
                try {
                  await releaseRuntimeClaim(observedClaim.claim_id);
                  releaseSucceeded = true;
                } catch (err) {
                  console.error(
                    `Failed to release interactive scope claim ${observedClaim.claim_id} for run id ${runId}: ${formatError(err)}`
                  );
                }
              }

              if (!success && session) {
                try {
                  await session.close();
                } catch (err) {
                  console.error(
                    `Failed to close failed interactive scope claims smoke session for run id ${runId}: ${formatError(err)}`
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
                  `Preserving failed live interactive scope claims smoke artifacts at ${artifactsDir} for run id ${runId}`
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

  return `set TEAMEM_CLAUDE_PLUGIN_E2E=1, TEAMEM_CLAUDE_PLUGIN_INTERACTIVE_E2E=1, and TEAMEM_CLAUDE_PLUGIN_STATEFUL_E2E=1 to run stateful interactive Claude plugin scope claim smoke${
    missingGates.length > 0 ? `; missing ${missingGates.join(', ')}` : ''
  }`;
}

function createRunId(): string {
  return `${Date.now().toString(36)}${randomUUID().replaceAll('-', '').slice(0, 6)}`;
}

function createLiveInteractiveRuntimeEnv(input: {
  pluginDataDir: string;
  spaceId: string;
  projectId: string;
}): NodeJS.ProcessEnv {
  return {
    ...createLiveRuntimeEnv(),
    CLAUDE_PLUGIN_DATA: input.pluginDataDir,
    CLAUDE_PLUGIN_OPTION_DEFAULT_SPACE: input.spaceId,
    TEAMEM_DATA: input.pluginDataDir,
    TEAMEM_PROJECT_ID: input.projectId,
    TEAMEM_SPACE: input.spaceId
  };
}

async function prepareProjectActivation(input: {
  pluginDataDir: string;
  projectRoot: string;
}): Promise<void> {
  const projectKey = createHash('sha1').update(input.projectRoot).digest('hex');
  const projectDir = join(input.pluginDataDir, 'projects', projectKey);
  await mkdir(projectDir, { recursive: true });
  await writeFile(join(projectDir, 'auto-on'), new Date().toISOString());
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

async function waitForRuntimeClaim(input: {
  repoId: string;
  targetPath: string;
  runId: string;
}): Promise<RuntimeClaim> {
  if (!runtimePrerequisite.ok) {
    throw new Error(runtimePrerequisite.reason);
  }

  const deadline = Date.now() + LIVE_RUNTIME_POLL_TIMEOUT_MS;
  let lastSummary = 'no runtime claims observed';

  while (Date.now() < deadline) {
    const response = await callLiveRuntimeTool<RuntimeClaims>(
      runtimePrerequisite.selectedEntry,
      'teamem.list_claims',
      { scope: 'space', view: 'current' }
    );
    const claim = response.data.claims.find(
      (item) =>
        item.repo_id === input.repoId &&
        item.branch === 'main' &&
        item.path === input.targetPath &&
        item.mode === 'on_commit' &&
        item.status === 'active'
    );

    if (claim) {
      return claim;
    }

    lastSummary = summarizeClaims(response.data.claims);
    await delay(500);
  }

  throw new Error(
    `Timed out waiting for live runtime claim on ${input.targetPath} for run id ${input.runId}. Last claims summary: ${lastSummary}`
  );
}

async function waitForRuntimeClaimRelease(
  claimId: string,
  runId: string
): Promise<void> {
  if (!runtimePrerequisite.ok) {
    throw new Error(runtimePrerequisite.reason);
  }

  const deadline = Date.now() + LIVE_RUNTIME_POLL_TIMEOUT_MS;
  let lastSummary = 'no runtime claims observed';

  while (Date.now() < deadline) {
    const response = await callLiveRuntimeTool<RuntimeClaims>(
      runtimePrerequisite.selectedEntry,
      'teamem.list_claims',
      { scope: 'space', view: 'current' }
    );

    if (!response.data.claims.some((item) => item.claim_id === claimId)) {
      return;
    }

    lastSummary = summarizeClaims(response.data.claims);
    await delay(500);
  }

  throw new Error(
    `Timed out waiting for live runtime claim release ${claimId} for run id ${runId}. Last claims summary: ${lastSummary}`
  );
}

async function releaseRuntimeClaim(claimId: string): Promise<void> {
  if (!runtimePrerequisite.ok) {
    throw new Error(runtimePrerequisite.reason);
  }

  const response = await callLiveRuntimeTool<RuntimeReleaseScope>(
    runtimePrerequisite.selectedEntry,
    'teamem.release_scope',
    { claim_id: claimId }
  );
  expect(response.data.released).toBe(true);
}

async function waitForCopiedWorkspaceMarker(input: {
  workspaceRoot: string;
  marker: string;
  runId: string;
}): Promise<void> {
  const targetFile = join(input.workspaceRoot, TARGET_PATH);
  const deadline = Date.now() + FILE_POLL_TIMEOUT_MS;
  let lastContent = '';

  while (Date.now() < deadline) {
    const content = await readFile(targetFile, 'utf8');
    if (content.includes(input.marker)) {
      return;
    }
    lastContent = content;
    await delay(500);
  }

  throw new Error(
    `Timed out waiting for copied workspace marker for run id ${input.runId}. Last ${TARGET_PATH} content length: ${lastContent.length}`
  );
}

async function assertSourceFixtureUnchanged(
  sourceFixtureBefore: string
): Promise<void> {
  const sourceFixtureAfter = await readFile(
    join(repoRoot, 'tests/fixtures/demo-repository-template', TARGET_PATH),
    'utf8'
  );
  expect(sourceFixtureAfter).toBe(sourceFixtureBefore);
}

function assertPreToolUseClaimHookEvidence(input: {
  traces: HookTrace[];
  artifactsDir: string;
  targetPath: string;
}): void {
  const preToolTrace = input.traces.find(
    (trace) => trace.event === 'PreToolUse' && trace.exitCode === 0
  );

  if (!preToolTrace) {
    throw new Error(
      `Expected successful PreToolUse hook evidence during the real edit of ${input.targetPath}. Observed hooks: ${summarizeHookTraces(input.traces)}. Artifacts: ${input.artifactsDir}`
    );
  }

  expect(preToolTrace.stderr).not.toContain('scope_conflict');
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
  ) as Array<{ type?: string; source?: string; step?: string }>;

  expect(summary.kind).toBe('interactive');
  expect(summary.command?.args).toEqual(session.command.args);
  expect(summary.exitStatus?.errorCode).toBeUndefined();
  expect(summary.cwd).toBe(session.cwd);
  expect(summary.result?.eventCount ?? 0).toBeGreaterThan(0);
  expect(summary.result?.hookTraceCount ?? 0).toBeGreaterThan(0);
  expect(interactiveEvents.some((event) => event.type === 'close-step')).toBe(
    true
  );
}

async function assertLaunchUsesIsolatedPluginData(
  artifacts: InteractiveSession['artifacts']
): Promise<void> {
  const environment = JSON.parse(
    await readFile(artifacts.environmentPath, 'utf8')
  ) as {
    env?: Record<string, string>;
  };

  expect(environment.env?.CLAUDE_PLUGIN_DATA).toBe('[REDACTED]');
}

function assertLiveInteractiveInputEvidence(
  session: InteractiveSession,
  prompt: string,
  marker: string
): void {
  const submittedText = session
    .events()
    .filter((event) => event.type === 'input' && event.source === 'submit')
    .map((event) => ('data' in event ? event.data : ''))
    .join('');

  expect(submittedText).toContain(prompt);
  expect(submittedText).toContain(marker);
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
  if (!teamemTrace) {
    return;
  }

  await assertTraceArtifactsExist(teamemTrace);
  assertObservedPluginDataIsRedacted(teamemTrace);
}

function summarizeClaims(claims: RuntimeClaim[]): string {
  if (claims.length === 0) {
    return 'none';
  }

  return claims
    .map(
      (claim) =>
        `${claim.claim_id}:${claim.repo_id}:${claim.branch}:${claim.path}:${claim.status}:${claim.mode}`
    )
    .join(', ');
}

function summarizeHookTraces(traces: HookTrace[]): string {
  if (traces.length === 0) {
    return 'none';
  }

  return traces
    .map((trace) => {
      const toolName = isRecord(trace.stdinJson)
        ? String(trace.stdinJson.tool_name ?? 'unknown')
        : 'unknown';
      return `${trace.event}:${toolName}:exit-${trace.exitCode}`;
    })
    .join(', ');
}

function withArtifactError(
  err: unknown,
  artifactsDir: string,
  runId: string
): Error {
  const suffix = `Artifacts: ${artifactsDir}. Run id: ${runId}. Permission mode env: ${TEAMEM_INTERACTIVE_PERMISSION_MODE_ENV}`;
  if (err instanceof Error) {
    err.message = `${err.message}. ${suffix}`;
    return err;
  }
  return new Error(`${String(err)}. ${suffix}`);
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
