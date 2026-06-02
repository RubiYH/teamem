import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import {
  createClaudePluginTester,
  readHookTraces,
  readMcpTraces,
  type BootResult,
  type HookTrace,
  type InteractiveSession
} from '../../plugin-e2e-module/src/index.js';
import {
  checkJwtExp,
  loadCredentials,
  pickEntry,
  type CredentialEntry
} from '../../src/bridge/credentials.js';
import {
  assertNoTeamemChannelMcpTrace,
  callLiveRuntimeTool,
  createLiveRuntimeEnv,
  type RuntimeWhoamiEvidence,
  TEAMEM_MCP_INSTRUMENTATION_OPTIONS
} from './teamem-live-smoke-helpers.js';
import {
  acceptClaudeStartupPromptsIfPresent,
  isClaudeInteractiveReadyOrSafetyPrompt
} from './teamem-interactive-readiness.js';
import {
  createDemoRepositoryWorkspace,
  finishDemoRepositoryWorkspace,
  type DemoRepositoryWorkspace
} from './teamem-demo-repository-workspace.js';
import {
  DEFAULT_TEAMEM_INTERACTIVE_PERMISSION_MODE,
  DEFAULT_TEAMEM_INTERACTIVE_SCRIPT_PERMISSION_MODE,
  resolveTeamemInteractivePermissionMode
} from './teamem-interactive-permission-mode.js';
import {
  TEAMEM_MULTI_PROFILE_E2E_ENV,
  defaultMultiProfilePersonas,
  finishMultiProfileRun,
  planTeamemDevClaudeMultiProfileRun,
  type MultiProfileRunPlan
} from './teamem-multi-profile-coordinator.js';

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

type FailureRuntimeEvidence = Array<Record<string, unknown>>;

type RuntimeReleaseScope = {
  released: boolean;
};

type GitResult = {
  stdout: string;
  stderr: string;
  status: number;
};

type MultiProfilePersonaPlan = MultiProfileRunPlan['personaPlans'][number];

const liveGateEnabled = process.env.TEAMEM_CLAUDE_PLUGIN_E2E === '1';
const interactiveGateEnabled =
  process.env.TEAMEM_CLAUDE_PLUGIN_INTERACTIVE_E2E === '1';
const statefulGateEnabled =
  process.env.TEAMEM_CLAUDE_PLUGIN_STATEFUL_E2E === '1';
const multiProfileGateEnabled =
  process.env[TEAMEM_MULTI_PROFILE_E2E_ENV] === '1';
const unredactedTraceGateEnabled =
  process.env.CLAUDE_PLUGIN_E2E_ALLOW_UNREDACTED === '1';
const liveMultiProfileGitHandoffsGateEnabled =
  liveGateEnabled &&
  interactiveGateEnabled &&
  statefulGateEnabled &&
  multiProfileGateEnabled &&
  unredactedTraceGateEnabled;
const describeLiveMultiProfileGitHandoffs =
  liveMultiProfileGitHandoffsGateEnabled ? describe : describe.skip;
const interactivePermissionMode = liveMultiProfileGitHandoffsGateEnabled
  ? resolveTeamemInteractivePermissionMode(
      process.env,
      DEFAULT_TEAMEM_INTERACTIVE_SCRIPT_PERMISSION_MODE
    )
  : DEFAULT_TEAMEM_INTERACTIVE_PERMISSION_MODE;

const repoRoot = process.cwd();
const teamemPluginDir = join(repoRoot, 'plugin');
const LIVE_MULTI_PROFILE_GIT_HANDOFFS_TIMEOUT_MS = 420_000;
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
const canonicalTeamemToolPrefix = 'mcp__teamem__teamem_';

describeLiveMultiProfileGitHandoffs(
  `Teamem L5 multi-profile Git handoffs smoke${liveMultiProfileGitHandoffsGateEnabled ? '' : ` (${formatGateReason()})`}`,
  () => {
    it(
      'proves persona-owned claims release on commit and pause/resume on checkout in one copied demo workspace',
      async () => {
        let workspace: DemoRepositoryWorkspace | undefined;
        let plan: MultiProfileRunPlan | undefined;
        const sessions: InteractiveSession[] = [];
        let aliceClaim: RuntimeClaim | undefined;
        let bobClaim: RuntimeClaim | undefined;
        let aliceClaimPendingCleanup = false;
        let bobClaimPendingCleanup = false;
        let success = false;

        try {
          workspace = await createDemoRepositoryWorkspace({
            teamemSourceRoot: repoRoot
          });
          const runId = createGitHandoffsRunId();
          const aliceMarker = `// teamem-l5-git-handoff-alice: ${runId}`;
          const bobMarker = `<!-- teamem-l5-git-handoff-bob: ${runId} -->`;
          const sourceFixtureBefore = await readSourceFixtureSnapshot();

          plan = await planTeamemDevClaudeMultiProfileRun({
            runId,
            personas: defaultMultiProfilePersonas(),
            teamemRoot: repoRoot,
            workspace,
            artifactsParentDir: tmpdir()
          });
          const alicePlan = requirePersonaPlan(plan, 'alice');
          const bobPlan = requirePersonaPlan(plan, 'bob');
          const aliceRuntime = await inspectProfileRuntime(
            alicePlan.profile.credentialsPath
          );
          const bobRuntime = await inspectProfileRuntime(
            bobPlan.profile.credentialsPath
          );
          expect(aliceRuntime.whoami.space_id).toBe(bobRuntime.whoami.space_id);
          expect(aliceRuntime.whoami.principal).not.toBe(
            bobRuntime.whoami.principal
          );

          const workspaceRepoId = await realpath(
            workspace.demoWorkspaceLaunchCwd
          );
          await installTeamemGitHooks({
            workspaceRoot: workspace.demoWorkspaceLaunchCwd
          });
          await prepareGitHookData({
            pluginDataDir: alicePlan.profile.pluginDataDir,
            sessionId: runId,
            spaceId: aliceRuntime.entry.space_id
          });
          await prepareGitHookData({
            pluginDataDir: bobPlan.profile.pluginDataDir,
            sessionId: runId,
            spaceId: bobRuntime.entry.space_id
          });

          const aliceEnv = createProfileRuntimeEnv(
            alicePlan.profile,
            teamemPluginDir
          );
          const aliceTester = createPersonaTester({
            personaPlan: alicePlan,
            profileEnv: aliceEnv,
            workspace
          });
          const aliceBoot = await aliceTester.boot();
          assertDevLaunchPlanParity({
            personaPlan: alicePlan,
            profileEnv: aliceEnv,
            boot: aliceBoot,
            launchCwd: workspace.demoWorkspaceLaunchCwd
          });
          const aliceSession = await launchEditSession({
            tester: aliceTester,
            boot: aliceBoot,
            personaPlan: alicePlan,
            launchCwd: workspace.demoWorkspaceLaunchCwd
          });
          sessions.push(aliceSession);

          const alicePrompt = [
            `Edit ${COMMIT_TARGET_PATH}.`,
            `Add this exact line immediately above "export const demoBoard": ${aliceMarker}`,
            'Use the Edit tool for the change.',
            'Do not modify any other file. After the edit, stop.'
          ].join(' ');
          aliceClaim = await submitEditAndAssertClaim({
            session: aliceSession,
            prompt: alicePrompt,
            entry: aliceRuntime.entry,
            repoId: workspaceRepoId,
            branch: 'main',
            targetPath: COMMIT_TARGET_PATH,
            expectedPrincipal: aliceRuntime.whoami.principal,
            runId
          });
          aliceClaimPendingCleanup = true;
          await waitForCopiedWorkspaceMarker({
            workspaceRoot: workspace.demoWorkspaceLaunchCwd,
            targetPath: COMMIT_TARGET_PATH,
            marker: aliceMarker,
            runId
          });
          assertLiveInteractiveInputEvidence(
            aliceSession,
            alicePrompt,
            aliceMarker
          );
          await aliceSession.close();
          await assertPersonaEditArtifacts({
            session: aliceSession,
            profileEnv: aliceEnv,
            pluginDataDir: alicePlan.profile.pluginDataDir,
            repoId: workspaceRepoId,
            targetPath: COMMIT_TARGET_PATH
          });

          gitOrThrow({
            cwd: workspace.demoWorkspaceLaunchCwd,
            args: ['add', COMMIT_TARGET_PATH],
            env: gitHookEnv({
              profileEnv: aliceEnv,
              pluginDataDir: alicePlan.profile.pluginDataDir,
              sessionId: runId,
              spaceId: aliceRuntime.entry.space_id
            }),
            runId
          });
          gitOrThrow({
            cwd: workspace.demoWorkspaceLaunchCwd,
            args: ['commit', '-m', `Teamem L5 git handoff ${runId}`],
            env: gitHookEnv({
              profileEnv: aliceEnv,
              pluginDataDir: alicePlan.profile.pluginDataDir,
              sessionId: runId,
              spaceId: aliceRuntime.entry.space_id
            }),
            runId
          });
          await waitForRuntimeClaimRelease({
            entry: aliceRuntime.entry,
            claimId: aliceClaim.claim_id,
            runId
          });
          aliceClaimPendingCleanup = false;
          await assertGitBranch(workspace.demoWorkspaceLaunchCwd, 'main');

          const bobEnv = createProfileRuntimeEnv(
            bobPlan.profile,
            teamemPluginDir
          );
          const bobTester = createPersonaTester({
            personaPlan: bobPlan,
            profileEnv: bobEnv,
            workspace
          });
          const bobBoot = await bobTester.boot();
          assertDevLaunchPlanParity({
            personaPlan: bobPlan,
            profileEnv: bobEnv,
            boot: bobBoot,
            launchCwd: workspace.demoWorkspaceLaunchCwd
          });
          const bobSession = await launchEditSession({
            tester: bobTester,
            boot: bobBoot,
            personaPlan: bobPlan,
            launchCwd: workspace.demoWorkspaceLaunchCwd
          });
          sessions.push(bobSession);

          const bobPrompt = [
            `Edit ${PAUSE_TARGET_PATH}.`,
            `Append this exact line at the end of the file: ${bobMarker}`,
            'Use the Edit tool for the change.',
            'Do not modify any other file. After the edit, stop.'
          ].join(' ');
          bobClaim = await submitEditAndAssertClaim({
            session: bobSession,
            prompt: bobPrompt,
            entry: bobRuntime.entry,
            repoId: workspaceRepoId,
            branch: 'main',
            targetPath: PAUSE_TARGET_PATH,
            expectedPrincipal: bobRuntime.whoami.principal,
            runId
          });
          bobClaimPendingCleanup = true;
          await waitForCopiedWorkspaceMarker({
            workspaceRoot: workspace.demoWorkspaceLaunchCwd,
            targetPath: PAUSE_TARGET_PATH,
            marker: bobMarker,
            runId
          });
          assertLiveInteractiveInputEvidence(bobSession, bobPrompt, bobMarker);
          await bobSession.close();
          await assertPersonaEditArtifacts({
            session: bobSession,
            profileEnv: bobEnv,
            pluginDataDir: bobPlan.profile.pluginDataDir,
            repoId: workspaceRepoId,
            targetPath: PAUSE_TARGET_PATH
          });

          gitOrThrow({
            cwd: workspace.demoWorkspaceLaunchCwd,
            args: ['checkout', FEATURE_BRANCH],
            env: gitHookEnv({
              profileEnv: bobEnv,
              pluginDataDir: bobPlan.profile.pluginDataDir,
              sessionId: runId,
              spaceId: bobRuntime.entry.space_id
            }),
            runId
          });
          await assertGitBranch(
            workspace.demoWorkspaceLaunchCwd,
            FEATURE_BRANCH
          );
          await waitForRuntimeClaimState({
            entry: bobRuntime.entry,
            claimId: bobClaim.claim_id,
            runId,
            isComplete: (claim) =>
              claim.paused_at !== null &&
              claim.paused_reason === 'branch_switch'
          });

          gitOrThrow({
            cwd: workspace.demoWorkspaceLaunchCwd,
            args: ['checkout', 'main'],
            env: gitHookEnv({
              profileEnv: bobEnv,
              pluginDataDir: bobPlan.profile.pluginDataDir,
              sessionId: runId,
              spaceId: bobRuntime.entry.space_id
            }),
            runId
          });
          await assertGitBranch(workspace.demoWorkspaceLaunchCwd, 'main');
          await waitForRuntimeClaimState({
            entry: bobRuntime.entry,
            claimId: bobClaim.claim_id,
            runId,
            isComplete: (claim) => claim.paused_at === null
          });

          await releaseRuntimeClaim(bobRuntime.entry, bobClaim.claim_id);
          bobClaimPendingCleanup = false;
          await waitForRuntimeClaimRelease({
            entry: bobRuntime.entry,
            claimId: bobClaim.claim_id,
            runId
          });

          await writeGitHandoffArtifacts({
            plan,
            alicePlan,
            bobPlan,
            aliceSession,
            bobSession,
            runId,
            workspaceRoot: workspace.demoWorkspaceLaunchCwd,
            workspaceRepoId,
            sharedWorkspace: true,
            aliceWhoami: aliceRuntime.whoami,
            bobWhoami: bobRuntime.whoami,
            alicePrompt,
            bobPrompt,
            aliceMarker,
            bobMarker,
            aliceClaim,
            bobClaim
          });
          await assertGitHookEvidence(workspace.demoWorkspaceLaunchCwd);
          await assertSourceFixturesUnchanged(sourceFixtureBefore);

          success = true;
        } finally {
          let failureRuntimeEvidence: FailureRuntimeEvidence | undefined;
          if (!success && plan) {
            try {
              failureRuntimeEvidence =
                await collectFailureRuntimeEvidence(plan);
            } catch (err) {
              failureRuntimeEvidence = [
                {
                  runId: plan.runId,
                  error: formatError(err)
                }
              ];
              console.error(
                `Failed to capture multi-profile Git handoff failure runtime evidence: ${formatError(err)}`
              );
            }
          }
          for (const session of sessions) {
            try {
              await session.close();
            } catch {
              // Preserve the original failure and artifact paths.
            }
          }
          if (!success && plan && workspace) {
            try {
              await writeFailureGitHandoffArtifacts({
                plan,
                workspaceRoot: workspace.demoWorkspaceLaunchCwd,
                aliceClaimId: aliceClaim?.claim_id,
                bobClaimId: bobClaim?.claim_id,
                runtimeEvidence: failureRuntimeEvidence ?? []
              });
            } catch (err) {
              console.error(
                `Failed to write multi-profile Git handoff failure artifacts: ${formatError(err)}`
              );
            }
          }
          if (aliceClaim?.claim_id && aliceClaimPendingCleanup && plan) {
            await cleanupRuntimeClaim({
              plan,
              persona: 'alice',
              claimId: aliceClaim.claim_id,
              runId: plan.runId
            });
          }
          if (bobClaim?.claim_id && bobClaimPendingCleanup && plan) {
            await cleanupRuntimeClaim({
              plan,
              persona: 'bob',
              claimId: bobClaim.claim_id,
              runId: plan.runId
            });
          }
          if (plan) {
            const cleanup = await finishMultiProfileRun(plan, { success });
            if (cleanup.preserved) {
              console.error(
                `Preserving failed multi-profile Git handoffs smoke artifacts at ${cleanup.artifactsDir}`
              );
            }
          }
          if (workspace) {
            const cleanup = await finishDemoRepositoryWorkspace(workspace, {
              success,
              artifactsDir: plan?.artifactsDir
            });
            if (cleanup.preserved) {
              console.error(
                `Preserving failed multi-profile Git handoffs demo workspace at ${cleanup.demoWorkspaceLaunchCwd}${cleanup.artifactPath ? ` (report ${cleanup.artifactPath})` : ''}`
              );
            }
          }
        }
      },
      LIVE_MULTI_PROFILE_GIT_HANDOFFS_TIMEOUT_MS
    );
  }
);

async function inspectProfileRuntime(
  credentialsPath: string
): Promise<{ entry: CredentialEntry; whoami: RuntimeWhoamiEvidence }> {
  const credentials = await loadCredentials(credentialsPath);
  if (!credentials) {
    throw new Error(
      `Invalid profile credentials at ${credentialsPath}; refusing to open Claude.`
    );
  }
  const entry = pickEntry({ creds: credentials });
  checkJwtExp(entry);
  const whoami = await callLiveRuntimeTool<RuntimeWhoamiEvidence>(
    entry,
    'teamem.whoami'
  );
  expect(whoami.data.principal).toBe(entry.member_name);
  expect(whoami.data.space_id).toBe(entry.space_id);
  expect(whoami.data.label).toBe(entry.label);
  return { entry, whoami: whoami.data };
}

function createPersonaTester(input: {
  personaPlan: MultiProfilePersonaPlan;
  profileEnv: NodeJS.ProcessEnv;
  workspace: DemoRepositoryWorkspace;
}) {
  return createClaudePluginTester({
    pluginDir: teamemPluginDir,
    cwd: input.workspace.demoWorkspaceLaunchCwd,
    artifactsDir: input.personaPlan.artifactDir,
    cleanup: 'never',
    mcp: TEAMEM_MCP_INSTRUMENTATION_OPTIONS,
    env: input.profileEnv,
    redaction: { mode: 'off' },
    timeouts: {
      interactiveReadinessMs: INTERACTIVE_READINESS_TIMEOUT_MS,
      interactiveWaitMs: INTERACTIVE_WAIT_TIMEOUT_MS,
      interactiveCloseMs: INTERACTIVE_CLOSE_TIMEOUT_MS
    }
  });
}

function createProfileRuntimeEnv(
  profile: {
    readonly claudeConfigDir: string;
    readonly pluginCacheDir: string;
    readonly pluginDataDir: string;
    readonly credentialsPath: string;
  },
  pluginRoot: string
): NodeJS.ProcessEnv {
  return {
    ...createLiveRuntimeEnv(),
    CLAUDE_CONFIG_DIR: profile.claudeConfigDir,
    CLAUDE_CODE_PLUGIN_CACHE_DIR: profile.pluginCacheDir,
    CLAUDE_CODE_MCP_ALLOWLIST_ENV: '1',
    CLAUDE_PLUGIN_DATA: profile.pluginDataDir,
    CLAUDE_PLUGIN_ROOT: pluginRoot,
    TEAMEM_CLAUDE_LAUNCH_INTENT: 'activate',
    TEAMEM_CREDENTIALS: profile.credentialsPath
  };
}

async function launchEditSession(input: {
  tester: ReturnType<typeof createClaudePluginTester>;
  boot: BootResult;
  personaPlan: MultiProfilePersonaPlan;
  launchCwd: string;
}): Promise<InteractiveSession> {
  const session = await input.tester.launchInteractive({
    useInstrumentedMcpConfig: true,
    strictMcpConfig: true,
    permissionMode: interactivePermissionMode,
    allowedTools: ['Read', 'Edit', 'MultiEdit', 'Write'],
    disallowedTools: disallowedTeamemToolsForEditSmoke(),
    readiness: isClaudeInteractiveReadyOrSafetyPrompt,
    readinessTimeoutMs: INTERACTIVE_READINESS_TIMEOUT_MS,
    waitTimeoutMs: INTERACTIVE_WAIT_TIMEOUT_MS,
    closeTimeoutMs: INTERACTIVE_CLOSE_TIMEOUT_MS
  });
  await acceptClaudeStartupPromptsIfPresent(
    session,
    INTERACTIVE_READINESS_TIMEOUT_MS
  );

  assertInteractiveLaunchParity({
    personaPlan: input.personaPlan,
    boot: input.boot,
    session,
    launchCwd: input.launchCwd
  });
  await delay(INTERACTIVE_STARTUP_SETTLE_MS);

  return session;
}

async function submitEditAndAssertClaim(input: {
  session: InteractiveSession;
  prompt: string;
  entry: CredentialEntry;
  repoId: string;
  branch: string;
  targetPath: string;
  expectedPrincipal: string;
  runId: string;
}): Promise<RuntimeClaim> {
  await input.session.submit(input.prompt, {
    delayMs: INTERACTIVE_TYPE_DELAY_MS
  });
  return waitForRuntimeClaim({
    entry: input.entry,
    repoId: input.repoId,
    branch: input.branch,
    targetPath: input.targetPath,
    expectedPrincipal: input.expectedPrincipal,
    runId: input.runId
  });
}

async function waitForRuntimeClaim(input: {
  entry: CredentialEntry;
  repoId: string;
  branch: string;
  targetPath: string;
  expectedPrincipal: string;
  runId: string;
}): Promise<RuntimeClaim> {
  return waitForRuntimeClaimState({
    entry: input.entry,
    runId: input.runId,
    isComplete: (claim) =>
      claim.repo_id === input.repoId &&
      claim.branch === input.branch &&
      claim.path === input.targetPath &&
      claim.mode === 'on_commit' &&
      claim.status === 'active' &&
      claim.paused_at === null &&
      claim.principal === input.expectedPrincipal &&
      claim.sprint_id === null &&
      claim.context === 'space'
  });
}

async function waitForRuntimeClaimState(input: {
  entry: CredentialEntry;
  claimId?: string;
  runId: string;
  isComplete: (claim: RuntimeClaim) => boolean;
}): Promise<RuntimeClaim> {
  const deadline = Date.now() + LIVE_RUNTIME_POLL_TIMEOUT_MS;
  let lastSummary = 'no runtime claims observed';

  while (Date.now() < deadline) {
    const response = await callLiveRuntimeTool<RuntimeClaims>(
      input.entry,
      'teamem.list_claims',
      { scope: 'self', view: 'space' }
    );
    const claim = response.data.claims.find((item) => {
      if (input.claimId && item.claim_id !== input.claimId) {
        return false;
      }
      return input.isComplete(item);
    });

    if (claim) {
      expect(claim.sprint_id).toBeNull();
      expect(claim.context).toBe('space');
      return claim;
    }

    lastSummary = summarizeClaims(response.data.claims);
    await delay(500);
  }

  throw new Error(
    `Timed out waiting for live runtime claim state for run id ${input.runId}. Last claims summary: ${lastSummary}`
  );
}

async function waitForRuntimeClaimRelease(input: {
  entry: CredentialEntry;
  claimId: string;
  runId: string;
}): Promise<void> {
  const deadline = Date.now() + LIVE_RUNTIME_POLL_TIMEOUT_MS;
  let lastSummary = 'no runtime claims observed';

  while (Date.now() < deadline) {
    const response = await callLiveRuntimeTool<RuntimeClaims>(
      input.entry,
      'teamem.list_claims',
      { scope: 'self', view: 'space' }
    );

    if (!response.data.claims.some((item) => item.claim_id === input.claimId)) {
      return;
    }

    lastSummary = summarizeClaims(response.data.claims);
    await delay(500);
  }

  throw new Error(
    `Timed out waiting for runtime claim release ${input.claimId} for run id ${input.runId}. Last claims summary: ${lastSummary}`
  );
}

async function releaseRuntimeClaim(
  entry: CredentialEntry,
  claimId: string
): Promise<void> {
  const response = await callLiveRuntimeTool<RuntimeReleaseScope>(
    entry,
    'teamem.release_scope',
    { claim_id: claimId }
  );
  expect(response.data.released).toBe(true);
}

async function cleanupRuntimeClaim(input: {
  plan: MultiProfileRunPlan;
  persona: string;
  claimId: string;
  runId: string;
}): Promise<void> {
  const personaPlan = input.plan.personaPlans.find(
    (candidate) => candidate.persona === input.persona
  );
  if (!personaPlan) {
    return;
  }
  try {
    const runtime = await inspectProfileRuntime(
      personaPlan.profile.credentialsPath
    );
    await releaseRuntimeClaim(runtime.entry, input.claimId);
    await waitForRuntimeClaimRelease({
      entry: runtime.entry,
      claimId: input.claimId,
      runId: input.runId
    });
  } catch (err) {
    console.error(
      `Failed to release multi-profile Git handoff claim ${input.claimId}: ${formatError(err)}`
    );
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

function gitHookEnv(input: {
  profileEnv: NodeJS.ProcessEnv;
  pluginDataDir: string;
  sessionId: string;
  spaceId: string;
}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...input.profileEnv,
    GIT_AUTHOR_NAME: 'Teamem Multi-Profile Git Handoff Smoke',
    GIT_AUTHOR_EMAIL: 'teamem-git-handoff-smoke@example.com',
    GIT_COMMITTER_NAME: 'Teamem Multi-Profile Git Handoff Smoke',
    GIT_COMMITTER_EMAIL: 'teamem-git-handoff-smoke@example.com',
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: devNull,
    CLAUDE_PLUGIN_DATA: input.pluginDataDir,
    TEAMEM_PLUGIN_ROOT: teamemPluginDir,
    CLAUDE_PLUGIN_ROOT: teamemPluginDir,
    TEAMEM_DATA: input.pluginDataDir,
    GIT_TEAMEM_SESSION_ID: input.sessionId,
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

function gitMaybe(input: { cwd: string; args: string[] }): GitResult {
  const result = spawnSync('git', [...input.args], {
    cwd: input.cwd,
    encoding: 'utf8'
  });

  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? 1
  };
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

async function assertPersonaEditArtifacts(input: {
  session: InteractiveSession;
  profileEnv: NodeJS.ProcessEnv;
  pluginDataDir: string;
  repoId: string;
  targetPath: string;
}): Promise<void> {
  await expect(stat(input.session.artifacts.summaryPath)).resolves.toBeTruthy();
  await expect(
    stat(input.session.artifacts.environmentPath)
  ).resolves.toBeTruthy();
  await expect(
    stat(input.session.artifacts.rawTranscriptPath)
  ).resolves.toBeTruthy();
  await expect(
    stat(input.session.artifacts.normalizedTranscriptPath)
  ).resolves.toBeTruthy();
  await expect(
    stat(input.session.artifacts.interactiveEventsPath)
  ).resolves.toBeTruthy();

  const environment = JSON.parse(
    await readFile(input.session.artifacts.environmentPath, 'utf8')
  ) as { env?: Record<string, string> };
  const summary = JSON.parse(
    await readFile(input.session.artifacts.summaryPath, 'utf8')
  ) as {
    kind?: string;
    cwd?: string;
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
    await readFile(input.session.artifacts.interactiveEventsPath, 'utf8')
  ) as Array<{ type?: string; source?: string; step?: string }>;

  expect(summary.kind).toBe('interactive');
  expect(summary.exitStatus?.errorCode).toBeUndefined();
  expect(summary.cwd).toBe(input.session.cwd);
  expect(summary.result?.eventCount ?? 0).toBeGreaterThan(0);
  expect(summary.result?.hookTraceCount ?? 0).toBeGreaterThan(0);
  expect(interactiveEvents.some((event) => event.type === 'close-step')).toBe(
    true
  );
  expect(environment.env ?? {}).toMatchObject({
    CLAUDE_PLUGIN_DATA: input.profileEnv.CLAUDE_PLUGIN_DATA,
    CLAUDE_PLUGIN_ROOT: input.profileEnv.CLAUDE_PLUGIN_ROOT
  });
  const mcpConfig = JSON.parse(
    await readFile(join(input.session.artifacts.dir, 'mcp-config.json'), 'utf8')
  ) as {
    mcpServers?: Record<string, { env?: Record<string, string> }>;
  };
  expect(mcpConfig.mcpServers?.teamem?.env ?? {}).toMatchObject({
    TEAMEM_CREDENTIALS: input.profileEnv.TEAMEM_CREDENTIALS
  });

  const [hookTraces, mcpTraces] = await Promise.all([
    readHookTraces(input.session.artifacts.hookTraceDir),
    readMcpTraces(input.session.artifacts.mcpTraceDir)
  ]);
  const hookPluginDataDir = resolveHookPluginDataDir({
    traces: hookTraces,
    targetPath: input.targetPath,
    fallbackPluginDataDir: input.pluginDataDir
  });
  assertSessionStartEvidence(hookTraces);
  assertPreToolUseClaimHookAllowEvidence({
    traces: hookTraces,
    artifactsDir: input.session.artifacts.dir,
    targetPath: input.targetPath
  });
  await assertLastBranchState({
    pluginDataDir: hookPluginDataDir,
    repoId: input.repoId,
    expectedBranch: 'main'
  });
  assertNoTeamemChannelMcpTrace(mcpTraces);
}

function resolveHookPluginDataDir(input: {
  traces: HookTrace[];
  targetPath: string;
  fallbackPluginDataDir: string;
}): string {
  const editTrace = input.traces.find(
    (trace) =>
      trace.event === 'PreToolUse' &&
      isEditTraceForTarget(trace, input.targetPath)
  );
  const pluginDataDir = editTrace?.environment?.env?.CLAUDE_PLUGIN_DATA;

  return pluginDataDir || input.fallbackPluginDataDir;
}

function assertSessionStartEvidence(traces: HookTrace[]): void {
  const sessionStart = traces.find((trace) => trace.event === 'SessionStart');
  expect(sessionStart).toBeDefined();
  expect(sessionStart?.exitCode).toBe(0);
}

function assertPreToolUseClaimHookAllowEvidence(input: {
  traces: HookTrace[];
  artifactsDir: string;
  targetPath: string;
}): void {
  const preToolTrace = input.traces.find((trace) => {
    if (trace.event !== 'PreToolUse' || trace.exitCode !== 0) {
      return false;
    }
    if (!isEditTraceForTarget(trace, input.targetPath)) {
      return false;
    }
    return !trace.stdout.includes('"permissionDecision":"deny"');
  });

  if (!preToolTrace) {
    throw new Error(
      `Expected PreToolUse hook allow evidence for ${input.targetPath}. Observed hooks: ${summarizeHookTraces(input.traces)}. Artifacts: ${input.artifactsDir}`
    );
  }
}

async function writeGitHandoffArtifacts(input: {
  plan: MultiProfileRunPlan;
  alicePlan: MultiProfilePersonaPlan;
  bobPlan: MultiProfilePersonaPlan;
  aliceSession: InteractiveSession;
  bobSession: InteractiveSession;
  runId: string;
  workspaceRoot: string;
  workspaceRepoId: string;
  sharedWorkspace: boolean;
  aliceWhoami: RuntimeWhoamiEvidence;
  bobWhoami: RuntimeWhoamiEvidence;
  alicePrompt: string;
  bobPrompt: string;
  aliceMarker: string;
  bobMarker: string;
  aliceClaim: RuntimeClaim;
  bobClaim: RuntimeClaim;
}): Promise<void> {
  const gitHistory = gitOrThrow({
    cwd: input.workspaceRoot,
    args: ['log', '--oneline', '--decorate', '--graph', '--all', '--stat'],
    runId: input.runId
  }).stdout;
  const gitStatus = gitOrThrow({
    cwd: input.workspaceRoot,
    args: ['status', '--short', '--branch'],
    runId: input.runId
  }).stdout;

  await writeFile(
    join(
      input.alicePlan.runtimeEvidenceDir,
      `${input.alicePlan.persona}-git-commit-release-${input.runId}.json`
    ),
    `${JSON.stringify(
      {
        runId: input.runId,
        persona: input.alicePlan.persona,
        profileName: input.alicePlan.profile.profileName,
        workspaceChoice:
          'shared copied demo workspace; Alice commit release and Bob checkout pause/resume operate on one real git repository',
        sharedWorkspace: input.sharedWorkspace,
        workspaceRoot: input.workspaceRoot,
        workspaceRepoId: input.workspaceRepoId,
        targetPath: COMMIT_TARGET_PATH,
        prompt: input.alicePrompt,
        marker: input.aliceMarker,
        whoami: input.aliceWhoami,
        claim: input.aliceClaim,
        gitHistory,
        gitStatus,
        rawTranscriptPath: input.aliceSession.artifacts.rawTranscriptPath,
        normalizedTranscriptPath:
          input.aliceSession.artifacts.normalizedTranscriptPath,
        mcpTraceDir: input.aliceSession.artifacts.mcpTraceDir,
        hookTraceDir: input.aliceSession.artifacts.hookTraceDir
      },
      null,
      2
    )}\n`
  );
  await writeFile(
    join(
      input.bobPlan.runtimeEvidenceDir,
      `${input.bobPlan.persona}-git-checkout-pause-resume-${input.runId}.json`
    ),
    `${JSON.stringify(
      {
        runId: input.runId,
        persona: input.bobPlan.persona,
        profileName: input.bobPlan.profile.profileName,
        workspaceChoice:
          'shared copied demo workspace; checkout hook evidence must observe the same repo branch state as the edit claim',
        sharedWorkspace: input.sharedWorkspace,
        workspaceRoot: input.workspaceRoot,
        workspaceRepoId: input.workspaceRepoId,
        targetPath: PAUSE_TARGET_PATH,
        featureBranch: FEATURE_BRANCH,
        prompt: input.bobPrompt,
        marker: input.bobMarker,
        whoami: input.bobWhoami,
        claim: input.bobClaim,
        gitHistory,
        gitStatus,
        rawTranscriptPath: input.bobSession.artifacts.rawTranscriptPath,
        normalizedTranscriptPath:
          input.bobSession.artifacts.normalizedTranscriptPath,
        mcpTraceDir: input.bobSession.artifacts.mcpTraceDir,
        hookTraceDir: input.bobSession.artifacts.hookTraceDir
      },
      null,
      2
    )}\n`
  );
  await writeFile(
    join(input.plan.artifactsDir, `git-handoffs-run-${input.runId}.json`),
    `${JSON.stringify(
      {
        runId: input.runId,
        artifactsDir: input.plan.artifactsDir,
        demoWorkspaceLaunchCwd: input.plan.demoWorkspaceLaunchCwd,
        sharedWorkspace: input.sharedWorkspace,
        workspaceRepoId: input.workspaceRepoId,
        aliceClaimId: input.aliceClaim.claim_id,
        bobClaimId: input.bobClaim.claim_id,
        aliceArtifactDir: input.alicePlan.artifactDir,
        bobArtifactDir: input.bobPlan.artifactDir,
        gitHistory,
        gitStatus
      },
      null,
      2
    )}\n`
  );
}

async function writeFailureGitHandoffArtifacts(input: {
  plan: MultiProfileRunPlan;
  workspaceRoot: string;
  aliceClaimId: string | undefined;
  bobClaimId: string | undefined;
  runtimeEvidence: FailureRuntimeEvidence;
}): Promise<void> {
  const gitHistory = gitMaybe({
    cwd: input.workspaceRoot,
    args: ['log', '--oneline', '--decorate', '--graph', '--all', '--stat']
  });
  const gitStatus = gitMaybe({
    cwd: input.workspaceRoot,
    args: ['status', '--short', '--branch']
  });
  const gitBranch = gitMaybe({
    cwd: input.workspaceRoot,
    args: ['branch', '--show-current']
  });
  const payload = {
    runId: input.plan.runId,
    artifactsDir: input.plan.artifactsDir,
    demoWorkspaceLaunchCwd: input.plan.demoWorkspaceLaunchCwd,
    workspaceRoot: input.workspaceRoot,
    sharedWorkspace: true,
    aliceClaimId: input.aliceClaimId,
    bobClaimId: input.bobClaimId,
    runtimeEvidence: input.runtimeEvidence,
    gitHistory,
    gitStatus,
    gitBranch,
    personaArtifacts: input.plan.personaPlans.map((personaPlan) => ({
      persona: personaPlan.persona,
      artifactDir: personaPlan.artifactDir,
      transcriptDir: personaPlan.transcriptDir,
      hookTraceDir: personaPlan.hookTraceDir,
      mcpTraceDir: personaPlan.mcpTraceDir,
      runtimeEvidenceDir: personaPlan.runtimeEvidenceDir
    }))
  };

  await writeFile(
    join(
      input.plan.artifactsDir,
      `git-handoffs-failure-${input.plan.runId}.json`
    ),
    `${JSON.stringify(payload, null, 2)}\n`
  );
  await Promise.all(
    input.plan.personaPlans.map((personaPlan) =>
      writeFile(
        join(
          personaPlan.runtimeEvidenceDir,
          `${personaPlan.persona}-git-handoff-failure-${input.plan.runId}.json`
        ),
        `${JSON.stringify(
          {
            ...payload,
            personaRuntimeEvidence:
              input.runtimeEvidence.find(
                (evidence) => evidence.persona === personaPlan.persona
              ) ?? null
          },
          null,
          2
        )}\n`
      )
    )
  );
}

async function collectFailureRuntimeEvidence(
  plan: MultiProfileRunPlan
): Promise<FailureRuntimeEvidence> {
  return Promise.all(
    plan.personaPlans.map(async (personaPlan) => {
      const base = {
        persona: personaPlan.persona,
        profileName: personaPlan.profile.profileName,
        credentialsPath: personaPlan.profile.credentialsPath
      };

      try {
        const credentials = await loadCredentials(
          personaPlan.profile.credentialsPath
        );
        if (!credentials) {
          throw new Error(
            `Invalid profile credentials at ${personaPlan.profile.credentialsPath}`
          );
        }
        const entry = pickEntry({ creds: credentials });
        checkJwtExp(entry);
        const [whoami, claims] = await Promise.all([
          callLiveRuntimeTool<RuntimeWhoamiEvidence>(entry, 'teamem.whoami'),
          callLiveRuntimeTool<RuntimeClaims>(entry, 'teamem.list_claims', {
            scope: 'self',
            view: 'space'
          })
        ]);

        return {
          ...base,
          selectedEntry: {
            label: entry.label,
            memberName: entry.member_name,
            spaceId: entry.space_id
          },
          whoami: whoami.data,
          claims: claims.data
        };
      } catch (err) {
        return {
          ...base,
          error: formatError(err)
        };
      }
    })
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

function assertDevLaunchPlanParity(input: {
  personaPlan: MultiProfilePersonaPlan;
  profileEnv: NodeJS.ProcessEnv;
  boot: BootResult;
  launchCwd: string;
}): void {
  const profile = input.personaPlan.profile;
  const dryRunOutput = input.personaPlan.result.stdout;

  expect(input.profileEnv.CLAUDE_CONFIG_DIR).toBe(profile.claudeConfigDir);
  expect(input.profileEnv.CLAUDE_CODE_PLUGIN_CACHE_DIR).toBe(
    profile.pluginCacheDir
  );
  expect(input.profileEnv.CLAUDE_CODE_MCP_ALLOWLIST_ENV).toBe('1');
  expect(input.profileEnv.CLAUDE_PLUGIN_DATA).toBe(profile.pluginDataDir);
  expect(input.profileEnv.CLAUDE_PLUGIN_ROOT).toBe(teamemPluginDir);
  expect(input.profileEnv.TEAMEM_CREDENTIALS).toBe(profile.credentialsPath);
  expect(input.profileEnv.TEAMEM_CLAUDE_LAUNCH_INTENT).toBe('activate');

  expect(input.boot.plugin.pluginDir).toBe(teamemPluginDir);
  expect(input.boot.instrumentedPlugin.sourcePluginDir).toBe(teamemPluginDir);
  expect(dryRunOutput).toContain(`Launch cwd: ${input.launchCwd}`);
  expect(dryRunOutput).toContain(`Source root: ${repoRoot}`);
  expect(dryRunOutput).toContain(`Plugin source: ${teamemPluginDir}`);
  expect(dryRunOutput).toContain(`Profile: ${profile.profileName}`);
  expect(dryRunOutput).toContain(`Profile root: ${profile.profileRoot}`);
  expect(dryRunOutput).toContain(`Claude config: ${profile.claudeConfigDir}`);
  expect(dryRunOutput).toContain(`Plugin cache: ${profile.pluginCacheDir}`);
  expect(dryRunOutput).toContain(`Plugin data: ${profile.pluginDataDir}`);
  expect(dryRunOutput).toContain(`Credentials: ${profile.credentialsPath}`);
  expect(dryRunOutput).toContain(`MCP config: ${profile.mcpConfigPath}`);
  expect(dryRunOutput).toContain(`Session name: teamem-${profile.profileName}`);
}

function assertInteractiveLaunchParity(input: {
  personaPlan: MultiProfilePersonaPlan;
  boot: BootResult;
  session: InteractiveSession;
  launchCwd: string;
}): void {
  const mcpConfigFlagIndex = input.session.command.args.indexOf('--mcp-config');
  expect(input.session.cwd).toBe(input.launchCwd);
  expect(input.session.command.args).toContain('--plugin-dir');
  expect(input.session.command.args).toContain(
    input.boot.instrumentedPlugin.pluginDir
  );
  expect(input.boot.instrumentedPlugin.mcpPath).toBeDefined();
  expect(mcpConfigFlagIndex).toBeGreaterThanOrEqual(0);
  const runMcpConfigPath =
    input.session.command.args[mcpConfigFlagIndex + 1] ?? '';
  expect(runMcpConfigPath).toContain(input.session.artifacts.dir);
  expect(input.session.command.args).toContain('--strict-mcp-config');
  expect(input.boot.instrumentedPlugin.sourcePluginDir).toBe(teamemPluginDir);
  expect(input.personaPlan.result.stdout).toContain(
    `Launch cwd: ${input.launchCwd}`
  );
}

function requirePersonaPlan(
  plan: MultiProfileRunPlan,
  persona: string
): MultiProfilePersonaPlan {
  const personaPlan = plan.personaPlans.find(
    (candidate) => candidate.persona === persona
  );
  if (!personaPlan) {
    throw new Error(`Missing ${persona} multi-profile plan`);
  }
  return personaPlan;
}

function disallowedTeamemToolsForEditSmoke(): string[] {
  return [
    'Bash(*)',
    'NotebookEdit',
    'mcp__plugin_teamem_channel__*',
    'mcp__teamem-channel__*',
    `${canonicalTeamemToolPrefix}whoami`,
    `${canonicalTeamemToolPrefix}get_current_sprint`,
    `${canonicalTeamemToolPrefix}list_claims`,
    `${canonicalTeamemToolPrefix}claim_scope`,
    `${canonicalTeamemToolPrefix}release_scope`,
    `${canonicalTeamemToolPrefix}force_release`,
    `${canonicalTeamemToolPrefix}post_message`,
    `${canonicalTeamemToolPrefix}record_decision`,
    `${canonicalTeamemToolPrefix}share_finding`,
    `${canonicalTeamemToolPrefix}get_finding`,
    `${canonicalTeamemToolPrefix}acknowledge_finding`,
    `${canonicalTeamemToolPrefix}get_briefing`,
    `${canonicalTeamemToolPrefix}list_sprints`,
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
  ];
}

function isEditTraceForTarget(trace: HookTrace, targetPath: string): boolean {
  if (!isRecord(trace.stdinJson)) {
    return false;
  }
  const toolName = trace.stdinJson.tool_name;
  if (toolName !== 'Edit' && toolName !== 'MultiEdit' && toolName !== 'Write') {
    return false;
  }
  const toolInput = trace.stdinJson.tool_input;
  return (
    isRecord(toolInput) &&
    typeof toolInput.file_path === 'string' &&
    toolInput.file_path.endsWith(targetPath)
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

function summarizeClaims(claims: RuntimeClaim[]): string {
  if (claims.length === 0) {
    return 'none';
  }

  return claims
    .map(
      (claim) =>
        `${claim.claim_id}:${claim.principal}:${claim.repo_id}:${claim.branch}:${claim.path}:${claim.status}:${claim.mode}:${claim.context}:${claim.sprint_id ?? 'no-sprint'}:paused-${claim.paused_at ?? 'none'}`
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
      const decision = trace.stdout.includes('"permissionDecision":"deny"')
        ? 'deny'
        : 'allow-or-empty';
      return `${trace.event}:${toolName}:exit-${trace.exitCode}:${decision}`;
    })
    .join(', ');
}

function formatGateReason(): string {
  return `set TEAMEM_CLAUDE_PLUGIN_E2E=1, TEAMEM_CLAUDE_PLUGIN_INTERACTIVE_E2E=1, TEAMEM_CLAUDE_PLUGIN_STATEFUL_E2E=1, ${TEAMEM_MULTI_PROFILE_E2E_ENV}=1, and CLAUDE_PLUGIN_E2E_ALLOW_UNREDACTED=1 to run L5 multi-profile Git handoffs Claude plugin smoke`;
}

function createGitHandoffsRunId(): string {
  return `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()
    .replaceAll('-', '')
    .slice(0, 8)}`;
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
