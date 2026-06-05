import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
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
import { devNull, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
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

type GitResult = {
  stdout: string;
  stderr: string;
  status: number;
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
const LIVE_INTERACTIVE_SMOKE_TEST_TIMEOUT_MS = 300_000;
const INTERACTIVE_READINESS_TIMEOUT_MS = 30_000;
const INTERACTIVE_WAIT_TIMEOUT_MS = 90_000;
const INTERACTIVE_CLOSE_TIMEOUT_MS = 10_000;
const INTERACTIVE_STARTUP_SETTLE_MS = 2_000;
const INTERACTIVE_TYPE_DELAY_MS = 20;
const LIVE_RUNTIME_POLL_TIMEOUT_MS = 45_000;
const FILE_POLL_TIMEOUT_MS = 60_000;
const COMMIT_TARGET_PATH = 'src/features/collaboration-board.ts';
const PAUSE_TARGET_PATH = 'features/collaboration-board.md';
const FEATURE_BRANCH = 'feature/briefing-targets';
const pluginScopedToolPrefix = 'mcp__plugin_teamem_teamem__teamem_';

describeLiveInteractiveStateful(
  `Teamem interactive git handoffs live smoke${runtimePrerequisite.ok ? '' : ` (${runtimePrerequisite.reason})`}`,
  () => {
    it(
      'releases on commit and pauses/resumes claims on branch checkout in a copied demo workspace',
      async () => {
        if (!runtimePrerequisite.ok) {
          throw new Error(runtimePrerequisite.reason);
        }

        await withLiveInteractiveSmokeLock(
          'teamem-interactive-git-handoffs-smoke',
          async () => {
            const runId = createRunId();
            const commitMarker = `// teamem-git-handoff-commit: ${runId}`;
            const pauseMarker = `<!-- teamem-git-handoff-pause: ${runId} -->`;
            const commitEditPrompt = [
              `Edit ${COMMIT_TARGET_PATH}.`,
              `Add this exact line immediately above "export const demoBoard": ${commitMarker}`,
              'Use the Edit tool for the change.',
              'Do not modify any other file. After the edit, stop.'
            ].join(' ');
            const pauseEditPrompt = [
              `Edit ${PAUSE_TARGET_PATH}.`,
              `Append this exact line at the end of the file: ${pauseMarker}`,
              'Use the Edit tool for the change.',
              'Do not modify any other file. After the edit, stop.'
            ].join(' ');
            const sourceFixtureBefore = await readSourceFixtureSnapshot();
            let workspace: DemoRepositoryWorkspace | undefined;
            const artifactsDir = await mkdtemp(
              join(tmpdir(), 'teamem-interactive-git-handoffs-artifacts-')
            );
            const isolatedPluginDataDir = join(
              artifactsDir,
              'teamem-plugin-data'
            );
            let commitSession: InteractiveSession | undefined;
            let pauseSession: InteractiveSession | undefined;
            let commitClaim: RuntimeClaim | undefined;
            let pauseClaim: RuntimeClaim | undefined;
            let commitClaimPendingCleanup = false;
            let pauseClaimPendingCleanup = false;
            let success = false;

            try {
              workspace = await createDemoRepositoryWorkspace({
                teamemSourceRoot: repoRoot
              });
              const projectId = workspace.demoWorkspaceLaunchCwd;
              const workspaceRepoId = await realpath(
                workspace.demoWorkspaceLaunchCwd
              );
              await prepareGitHookData({
                pluginDataDir: isolatedPluginDataDir,
                sessionId: runId,
                spaceId: runtimePrerequisite.selectedEntry.space_id
              });
              await installTeamemGitHooks({
                workspaceRoot: workspace.demoWorkspaceLaunchCwd
              });

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

              commitSession = await launchEditSession(tester, boot);
              await prepareProjectActivation({
                pluginDataDir: isolatedPluginDataDir,
                projectRoot: projectId
              });
              await prepareProjectActivation({
                pluginDataDir: isolatedPluginDataDir,
                projectRoot: workspaceRepoId
              });
              commitClaim = await submitEditAndAssertClaim({
                session: commitSession,
                prompt: commitEditPrompt,
                repoId: workspaceRepoId,
                targetPath: COMMIT_TARGET_PATH,
                runId
              });
              commitClaimPendingCleanup = true;
              await waitForCopiedWorkspaceMarker({
                workspaceRoot: workspace.demoWorkspaceLaunchCwd,
                targetPath: COMMIT_TARGET_PATH,
                marker: commitMarker,
                runId
              });
              assertLiveInteractiveInputEvidence(
                commitSession,
                commitEditPrompt,
                commitMarker
              );
              await commitSession.close();
              await assertInteractiveSessionEvidence({
                session: commitSession,
                pluginDataDir: isolatedPluginDataDir,
                repoId: workspaceRepoId,
                targetPath: COMMIT_TARGET_PATH
              });

              gitOrThrow({
                cwd: workspace.demoWorkspaceLaunchCwd,
                args: ['add', COMMIT_TARGET_PATH],
                env: gitHookEnv({
                  pluginDataDir: isolatedPluginDataDir,
                  sessionId: runId,
                  spaceId: runtimePrerequisite.selectedEntry.space_id,
                  projectId
                }),
                runId
              });
              gitOrThrow({
                cwd: workspace.demoWorkspaceLaunchCwd,
                args: ['commit', '-m', `Teamem git handoff commit ${runId}`],
                env: gitHookEnv({
                  pluginDataDir: isolatedPluginDataDir,
                  sessionId: runId,
                  spaceId: runtimePrerequisite.selectedEntry.space_id,
                  projectId
                }),
                runId
              });
              await waitForRuntimeClaimRelease(commitClaim.claim_id, runId);
              commitClaimPendingCleanup = false;
              await assertGitBranch(workspace.demoWorkspaceLaunchCwd, 'main');

              await removeProjectActivation({
                pluginDataDir: isolatedPluginDataDir,
                projectRoot: projectId
              });
              await removeProjectActivation({
                pluginDataDir: isolatedPluginDataDir,
                projectRoot: workspaceRepoId
              });
              pauseSession = await launchEditSession(tester, boot);
              await prepareProjectActivation({
                pluginDataDir: isolatedPluginDataDir,
                projectRoot: projectId
              });
              await prepareProjectActivation({
                pluginDataDir: isolatedPluginDataDir,
                projectRoot: workspaceRepoId
              });
              pauseClaim = await submitEditAndAssertClaim({
                session: pauseSession,
                prompt: pauseEditPrompt,
                repoId: workspaceRepoId,
                targetPath: PAUSE_TARGET_PATH,
                runId
              });
              pauseClaimPendingCleanup = true;
              await waitForCopiedWorkspaceMarker({
                workspaceRoot: workspace.demoWorkspaceLaunchCwd,
                targetPath: PAUSE_TARGET_PATH,
                marker: pauseMarker,
                runId
              });
              assertLiveInteractiveInputEvidence(
                pauseSession,
                pauseEditPrompt,
                pauseMarker
              );
              await pauseSession.close();
              await assertInteractiveSessionEvidence({
                session: pauseSession,
                pluginDataDir: isolatedPluginDataDir,
                repoId: workspaceRepoId,
                targetPath: PAUSE_TARGET_PATH
              });

              await assertLastBranchState({
                pluginDataDir: isolatedPluginDataDir,
                repoId: workspaceRepoId,
                expectedBranch: 'main'
              });
              gitOrThrow({
                cwd: workspace.demoWorkspaceLaunchCwd,
                args: ['checkout', FEATURE_BRANCH],
                env: gitHookEnv({
                  pluginDataDir: isolatedPluginDataDir,
                  sessionId: runId,
                  spaceId: runtimePrerequisite.selectedEntry.space_id,
                  projectId
                }),
                runId
              });
              await assertGitBranch(
                workspace.demoWorkspaceLaunchCwd,
                FEATURE_BRANCH
              );
              await waitForRuntimeClaimState({
                claimId: pauseClaim.claim_id,
                runId,
                isComplete: (claim) =>
                  claim.paused_at !== null &&
                  claim.paused_reason === 'branch_switch'
              });

              gitOrThrow({
                cwd: workspace.demoWorkspaceLaunchCwd,
                args: ['checkout', 'main'],
                env: gitHookEnv({
                  pluginDataDir: isolatedPluginDataDir,
                  sessionId: runId,
                  spaceId: runtimePrerequisite.selectedEntry.space_id,
                  projectId
                }),
                runId
              });
              await assertGitBranch(workspace.demoWorkspaceLaunchCwd, 'main');
              await waitForRuntimeClaimState({
                claimId: pauseClaim.claim_id,
                runId,
                isComplete: (claim) => claim.paused_at === null
              });

              await releaseRuntimeClaim(pauseClaim.claim_id);
              pauseClaimPendingCleanup = false;
              await waitForRuntimeClaimRelease(pauseClaim.claim_id, runId);

              await assertGitHookEvidence(workspace.demoWorkspaceLaunchCwd);
              await assertSourceFixturesUnchanged(sourceFixtureBefore);
              success = true;
            } catch (err) {
              throw withArtifactError(err, artifactsDir, runId);
            } finally {
              if (commitClaim?.claim_id && commitClaimPendingCleanup) {
                await cleanupRuntimeClaim(commitClaim.claim_id, runId);
              }
              if (pauseClaim?.claim_id && pauseClaimPendingCleanup) {
                await cleanupRuntimeClaim(pauseClaim.claim_id, runId);
              }

              if (!success) {
                await closeFailedSession(commitSession, 'commit', runId);
                await closeFailedSession(pauseSession, 'pause', runId);
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
                  `Preserving failed live interactive git handoffs smoke artifacts at ${artifactsDir} for run id ${runId}`
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

  return `set TEAMEM_CLAUDE_PLUGIN_E2E=1, TEAMEM_CLAUDE_PLUGIN_INTERACTIVE_E2E=1, and TEAMEM_CLAUDE_PLUGIN_STATEFUL_E2E=1 to run stateful interactive Claude plugin git handoff smoke${
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

async function launchEditSession(
  tester: ReturnType<typeof createClaudePluginTester>,
  boot: BootResult
): Promise<InteractiveSession> {
  const session = await tester.launchInteractive({
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
  await delay(INTERACTIVE_STARTUP_SETTLE_MS);

  return session;
}

async function submitEditAndAssertClaim(input: {
  session: InteractiveSession;
  prompt: string;
  repoId: string;
  targetPath: string;
  runId: string;
}): Promise<RuntimeClaim> {
  await input.session.submit(input.prompt, {
    delayMs: INTERACTIVE_TYPE_DELAY_MS
  });
  return waitForRuntimeClaim({
    repoId: input.repoId,
    branch: 'main',
    targetPath: input.targetPath,
    runId: input.runId
  });
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
  branch: string;
  targetPath: string;
  runId: string;
}): Promise<RuntimeClaim> {
  return waitForRuntimeClaimState({
    runId: input.runId,
    isComplete: (claim) =>
      claim.repo_id === input.repoId &&
      claim.branch === input.branch &&
      claim.path === input.targetPath &&
      claim.mode === 'on_commit' &&
      claim.status === 'active' &&
      claim.paused_at === null
  });
}

async function waitForRuntimeClaimState(input: {
  claimId?: string;
  runId: string;
  isComplete: (claim: RuntimeClaim) => boolean;
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
    const claim = response.data.claims.find((item) => {
      if (input.claimId && item.claim_id !== input.claimId) {
        return false;
      }
      return input.isComplete(item);
    });

    if (claim) {
      return claim;
    }

    lastSummary = summarizeClaims(response.data.claims);
    await delay(500);
  }

  throw new Error(
    `Timed out waiting for live runtime claim state for run id ${input.runId}. Last claims summary: ${lastSummary}`
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

async function cleanupRuntimeClaim(
  claimId: string,
  runId: string
): Promise<void> {
  try {
    await releaseRuntimeClaim(claimId);
    await waitForRuntimeClaimRelease(claimId, runId);
  } catch (err) {
    console.error(
      `Failed to release interactive git handoff claim ${claimId} for run id ${runId}: ${formatError(err)}`
    );
  }
}

async function waitForCopiedWorkspaceMarker(input: {
  workspaceRoot: string;
  targetPath: string;
  marker: string;
  runId: string;
}): Promise<void> {
  const targetFile = join(input.workspaceRoot, input.targetPath);
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
    `Timed out waiting for copied workspace marker for run id ${input.runId}. Last ${input.targetPath} content length: ${lastContent.length}`
  );
}

async function readSourceFixtureSnapshot(): Promise<Record<string, string>> {
  return {
    [COMMIT_TARGET_PATH]: await readFile(
      join(
        repoRoot,
        'tests/fixtures/demo-repository-template',
        COMMIT_TARGET_PATH
      ),
      'utf8'
    ),
    [PAUSE_TARGET_PATH]: await readFile(
      join(
        repoRoot,
        'tests/fixtures/demo-repository-template',
        PAUSE_TARGET_PATH
      ),
      'utf8'
    )
  };
}

async function assertSourceFixturesUnchanged(
  expected: Record<string, string>
): Promise<void> {
  for (const [targetPath, expectedContent] of Object.entries(expected)) {
    const actualContent = await readFile(
      join(repoRoot, 'tests/fixtures/demo-repository-template', targetPath),
      'utf8'
    );
    expect(actualContent).toBe(expectedContent);
  }
}

async function prepareGitHookData(input: {
  pluginDataDir: string;
  sessionId: string;
  spaceId: string;
}): Promise<void> {
  const sessionDir = join(input.pluginDataDir, 'sessions', input.sessionId);
  await mkdir(sessionDir, { recursive: true });
  await writeFile(join(sessionDir, 'space'), input.spaceId);
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

async function removeProjectActivation(input: {
  pluginDataDir: string;
  projectRoot: string;
}): Promise<void> {
  const projectKey = createHash('sha1').update(input.projectRoot).digest('hex');
  await rm(join(input.pluginDataDir, 'projects', projectKey, 'auto-on'), {
    force: true
  });
}

async function installTeamemGitHooks(input: {
  workspaceRoot: string;
}): Promise<void> {
  const install = spawnSync(
    'bun',
    ['run', 'teamem', 'install-git-hooks', '--repo', input.workspaceRoot],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: devNull,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_SYSTEM: devNull
      }
    }
  );
  if (install.status !== 0) {
    throw new Error(
      `teamem install-git-hooks failed with status ${install.status ?? 1}: ${
        install.stderr || install.stdout
      }`
    );
  }
  expect(install.stdout).toContain('installed post-commit hook');
  expect(install.stdout).toContain('installed post-checkout hook');
}

async function assertLastBranchState(input: {
  pluginDataDir: string;
  repoId: string;
  expectedBranch: string;
}): Promise<void> {
  const content = await readFile(
    join(
      input.pluginDataDir,
      'last-branch',
      createHash('sha1').update(input.repoId).digest('hex')
    ),
    'utf8'
  );
  expect(content).toBe(input.expectedBranch);
}

function gitHookEnv(input: {
  pluginDataDir: string;
  sessionId: string;
  spaceId: string;
  projectId: string;
}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: 'Teamem Git Handoff Smoke',
    GIT_AUTHOR_EMAIL: 'teamem-git-handoff-smoke@example.com',
    GIT_COMMITTER_NAME: 'Teamem Git Handoff Smoke',
    GIT_COMMITTER_EMAIL: 'teamem-git-handoff-smoke@example.com',
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: devNull,
    CLAUDE_PLUGIN_DATA: input.pluginDataDir,
    TEAMEM_PLUGIN_ROOT: teamemPluginDir,
    CLAUDE_PLUGIN_ROOT: teamemPluginDir,
    TEAMEM_DATA: input.pluginDataDir,
    GIT_TEAMEM_SESSION_ID: input.sessionId,
    TEAMEM_PROJECT_ID: input.projectId,
    TEAMEM_SPACE: input.spaceId,
    TEAMEM_POST_COMMIT_SYNC: '1'
  };
}

function gitOrThrow(input: {
  cwd: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  runId: string;
}): GitResult {
  const result = spawnSync(
    'git',
    ['-c', 'commit.gpgsign=false', '-c', 'tag.gpgSign=false', ...input.args],
    {
      cwd: input.cwd,
      encoding: 'utf8',
      env: input.env
    }
  );
  const gitResult: GitResult = {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? 1
  };

  if (gitResult.status !== 0) {
    throw new Error(
      `git ${input.args.join(' ')} failed for run id ${input.runId} with status ${gitResult.status}: ${gitResult.stderr || gitResult.stdout}`
    );
  }

  return gitResult;
}

async function assertGitBranch(
  cwd: string,
  expectedBranch: string
): Promise<void> {
  const result = gitOrThrow({
    cwd,
    args: ['branch', '--show-current'],
    runId: expectedBranch
  });
  expect(result.stdout.trim()).toBe(expectedBranch);
}

async function assertGitHookEvidence(workspaceRoot: string): Promise<void> {
  const postCommit = await readFile(
    gitHookPath(workspaceRoot, 'post-commit'),
    'utf8'
  );
  const postCheckout = await readFile(
    gitHookPath(workspaceRoot, 'post-checkout'),
    'utf8'
  );

  expect(postCommit).toContain('# teamem-managed-hook');
  expect(postCommit).toContain(teamemPluginDir);
  expect(postCommit).toContain('teamem.release_scope_via_git');
  expect(postCheckout).toContain('# teamem-managed-hook');
  expect(postCheckout).toContain(teamemPluginDir);
  expect(postCheckout).toContain('teamem.pause_claims_for_branch');
}

function gitHookPath(workspaceRoot: string, hookName: string): string {
  const result = gitOrThrow({
    cwd: workspaceRoot,
    args: ['rev-parse', '--git-path', `hooks/${hookName}`],
    runId: hookName
  });
  const hookPath = result.stdout.trim();
  return isAbsolute(hookPath) ? hookPath : join(workspaceRoot, hookPath);
}

async function assertInteractiveSessionEvidence(input: {
  session: InteractiveSession;
  pluginDataDir: string;
  repoId: string;
  targetPath: string;
}): Promise<void> {
  await assertInteractiveArtifactsExist(input.session);
  const [hookTraces, mcpTraces] = await Promise.all([
    readHookTraces(input.session.artifacts.hookTraceDir),
    readMcpTraces(input.session.artifacts.mcpTraceDir)
  ]);
  await assertSessionStartEvidence(hookTraces);
  assertPreToolUseClaimHookEvidence({
    traces: hookTraces,
    artifactsDir: input.session.artifacts.dir,
    targetPath: input.targetPath
  });
  // gate-claim.sh writes last-branch only after Teamem activation succeeds;
  // skip_inactive exits before this file is touched.
  await assertLastBranchState({
    pluginDataDir: input.pluginDataDir,
    repoId: input.repoId,
    expectedBranch: 'main'
  });
  assertNoTeamemChannelMcpTrace(mcpTraces);
  await assertTeamemMcpTraceEvidence(mcpTraces);
  await assertLaunchUsesIsolatedPluginData(input.session.artifacts);
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

async function closeFailedSession(
  session: InteractiveSession | undefined,
  label: string,
  runId: string
): Promise<void> {
  if (!session) {
    return;
  }

  try {
    await session.close();
  } catch (err) {
    console.error(
      `Failed to close failed interactive git handoff ${label} session for run id ${runId}: ${formatError(err)}`
    );
  }
}

function summarizeClaims(claims: RuntimeClaim[]): string {
  if (claims.length === 0) {
    return 'none';
  }

  return claims
    .map(
      (claim) =>
        `${claim.claim_id}:${claim.repo_id}:${claim.branch}:${claim.path}:${claim.status}:${claim.mode}:paused-${claim.paused_at ?? 'none'}`
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
