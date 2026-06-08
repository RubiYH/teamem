import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import {
  createClaudePluginTester,
  readHookTraces,
  readMcpTraces,
  type BootResult,
  type HookTrace,
  type InteractiveSession,
  type McpTrace,
  type McpTraceMessage
} from '../../plugin-e2e-module/src/index.js';
import {
  checkJwtExp,
  loadCredentials,
  pickEntry,
  type CredentialEntry
} from '../../src/bridge/credentials.js';
import type { TeamemEvent } from '../../src/domain/events/types.js';
import {
  assertNoTeamemChannelMcpTrace,
  callLiveRuntimeTool,
  createLiveRuntimeEnv,
  type RuntimeWhoamiEvidence,
  TEAMEM_MCP_INSTRUMENTATION_OPTIONS,
  withLiveInteractiveSmokeLock
} from './teamem-live-smoke-helpers.js';
import {
  acceptClaudeStartupPromptsIfPresent,
  isClaudeInteractiveReadyOrSafetyPrompt
} from './teamem-interactive-readiness.js';
import {
  DEFAULT_TEAMEM_INTERACTIVE_PERMISSION_MODE,
  DEFAULT_TEAMEM_INTERACTIVE_SCRIPT_PERMISSION_MODE,
  resolveTeamemInteractivePermissionMode
} from './teamem-interactive-permission-mode.js';
import {
  createDemoRepositoryWorkspace,
  finishDemoRepositoryWorkspace,
  type DemoRepositoryWorkspace
} from './teamem-demo-repository-workspace.js';
import {
  defaultMultiProfilePersonas,
  finishMultiProfileRun,
  planTeamemDevClaudeMultiProfileRun,
  TEAMEM_MULTI_PROFILE_E2E_ENV,
  type MultiProfilePersona,
  type MultiProfileRunPlan
} from './teamem-multi-profile-coordinator.js';

type SprintSummary = {
  sprint_id: string;
  slug: string;
  display_name: string;
  goal: string;
  status: 'active' | 'archived';
};

type SprintLifecycleData = {
  sprint: SprintSummary | null;
  old_context: { mode: 'space' | 'sprint'; sprint: SprintSummary | null };
  new_context: { mode: 'space' | 'sprint'; sprint: SprintSummary | null };
  event_ids: string[];
  idempotent: boolean;
  message: string;
  warnings: string[];
};

type SprintCurrentData = {
  context: { mode: 'space' | 'sprint'; sprint: SprintSummary | null };
  sprint: SprintSummary | null;
  current_members: string[];
};

type SprintArchiveData = {
  sprint: SprintSummary;
  event_ids: string[];
  idempotent: boolean;
  released_claims: Array<{
    claim_id: string;
    original_holder: string;
    event_id: string;
  }>;
  message: string;
};

type SprintHistoryData = {
  sprint: SprintSummary;
  events: Array<{
    event_id: string;
    event_type: string;
    timestamp: string;
    principal: string;
    sprint_id: string;
    summary: string;
    payload: Record<string, unknown>;
  }>;
  limit: number;
  truncated: boolean;
};

type RuntimeUpdatesData = {
  events: TeamemEvent[];
  next_cursor: string | null;
};

type ToolEnvelope<TData> = {
  ok: true;
  data: TData;
};

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

type RuntimeClaimScope = {
  claim_id: string;
  expires_at: string | null;
};

type RuntimeReleaseScope = {
  released: boolean;
};

type RuntimeBriefing = {
  current_context: {
    mode: 'space' | 'sprint';
    sprint: (SprintSummary & { current_members: string[] }) | null;
  };
  active_claims: Array<{
    principal?: string;
    path?: string;
    scope?: { paths?: string[] };
    blocking_principals?: Array<{
      principal?: string;
      paths?: string[];
    }>;
  }>;
  recent_notifications: Array<{
    event_id?: string;
    event_type?: string;
    principal?: string;
    summary?: string;
    sprint_id?: string | null;
    delivery_scope?: 'direct' | 'sprint' | 'space';
    routing_reason?: string;
    payload?: Record<string, unknown>;
  }>;
  outside_current_context: {
    active_claims: Array<{
      principal?: string;
      path?: string;
      scope?: { paths?: string[] };
    }>;
  };
};

type RuntimeUnreadNotifications = {
  notifications: Array<{
    event_id: string;
    event_type: string;
    payload: Record<string, unknown>;
    created_at: string;
  }>;
};

type MultiProfilePersonaPlan = MultiProfileRunPlan['personaPlans'][number];

type PersonaRuntime = {
  readonly entry: CredentialEntry;
  readonly whoami: RuntimeWhoamiEvidence;
};

type PersonaSession = {
  readonly personaPlan: MultiProfilePersonaPlan;
  readonly runtime: PersonaRuntime;
  readonly boot: BootResult;
  readonly session: InteractiveSession;
  readonly slashCommandPrompt: (
    commandName: string,
    args?: string
  ) => Promise<string>;
  readonly env: NodeJS.ProcessEnv;
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
const multiProfileGateEnabled =
  process.env[TEAMEM_MULTI_PROFILE_E2E_ENV] === '1';
const unredactedTraceGateEnabled =
  process.env.CLAUDE_PLUGIN_E2E_ALLOW_UNREDACTED === '1';
const liveSprintReleaseCleanupGateEnabled =
  liveGateEnabled &&
  interactiveGateEnabled &&
  statefulGateEnabled &&
  multiProfileGateEnabled &&
  unredactedTraceGateEnabled;
const describeLiveSprintReleaseCleanup = liveSprintReleaseCleanupGateEnabled
  ? describe
  : describe.skip;
const interactivePermissionMode = liveSprintReleaseCleanupGateEnabled
  ? resolveTeamemInteractivePermissionMode(
      process.env,
      DEFAULT_TEAMEM_INTERACTIVE_SCRIPT_PERMISSION_MODE
    )
  : DEFAULT_TEAMEM_INTERACTIVE_PERMISSION_MODE;

const repoRoot = process.cwd();
const teamemPluginDir = join(repoRoot, 'plugin');
const LIVE_SPRINT_RELEASE_CLEANUP_TIMEOUT_MS = 540_000;
const INTERACTIVE_READINESS_TIMEOUT_MS = 30_000;
const INTERACTIVE_WAIT_TIMEOUT_MS = 90_000;
const INTERACTIVE_CLOSE_TIMEOUT_MS = 10_000;
const INTERACTIVE_STARTUP_SETTLE_MS = 2_000;
const INTERACTIVE_TYPE_DELAY_MS = 20;
const LIVE_RUNTIME_POLL_TIMEOUT_MS = 45_000;
const FILE_POLL_TIMEOUT_MS = 60_000;
const pluginScopedToolPrefix = 'mcp__plugin_teamem_teamem__teamem_';
const canonicalTeamemToolPrefix = 'mcp__teamem__teamem_';

describeLiveSprintReleaseCleanup(
  `Teamem L5 Sprint release and cleanup live smoke${liveSprintReleaseCleanupGateEnabled ? '' : ` (${formatGateReason()})`}`,
  () => {
    it(
      'proves git release routing, pending unblocks, multi-context release routing, and archive cleanup evidence',
      async () => {
        await withLiveInteractiveSmokeLock(
          'teamem-interactive-sprint-release-cleanup-smoke',
          runSprintReleaseCleanupCase
        );
      },
      LIVE_SPRINT_RELEASE_CLEANUP_TIMEOUT_MS
    );
  }
);

async function runSprintReleaseCleanupCase(): Promise<void> {
  let workspace: DemoRepositoryWorkspace | undefined;
  let plan: MultiProfileRunPlan | undefined;
  const sessions: InteractiveSession[] = [];
  let partialEvidence: PartialSprintReleaseCleanupEvidence | undefined;
  const claimsToRelease: Array<{
    entry: CredentialEntry;
    claimId: string;
    label: string;
  }> = [];
  const sprintsToArchive: Array<{
    entry: CredentialEntry;
    sprint: SprintSummary;
    label: string;
  }> = [];
  let success = false;

  try {
    workspace = await createDemoRepositoryWorkspace({
      teamemSourceRoot: repoRoot
    });
    const runId = createRunId();
    const expectedRepoId = await realpath(workspace.demoWorkspaceLaunchCwd);
    const releasePath = `src/features/${runId}-release.ts`;
    const sprintBPath = `src/features/${runId}-sprint-b.ts`;
    const spacePath = `src/features/${runId}-space.ts`;
    const archiveAlicePath = `src/features/${runId}-archive-alice.ts`;
    const archiveBobPath = `src/features/${runId}-archive-bob.ts`;
    const aliceReleaseMarker = `// alice release owner ${runId}`;
    const bobDeniedMarker = `// bob pending denied ${runId}`;
    const gitReleaseMarker = `// git release commit ${runId}`;
    const sprintBMarker = `// sprint-b git release ${runId}`;
    const spaceMarker = `// space git release ${runId}`;
    const archiveAliceMarker = `// archive cleanup alice ${runId}`;
    const archiveBobMarker = `// archive cleanup bob ${runId}`;

    plan = await planTeamemDevClaudeMultiProfileRun({
      runId,
      personas: sprintReleaseCleanupPersonas(),
      teamemRoot: repoRoot,
      workspace,
      artifactsParentDir: tmpdir()
    });

    const alicePlan = requirePersonaPlan(plan, 'alice');
    const bobPlan = requirePersonaPlan(plan, 'bob');
    const carolPlan = requirePersonaPlan(plan, 'carol');
    const [aliceRuntime, bobRuntime, carolRuntime] = await Promise.all([
      inspectProfileRuntime(alicePlan.profile.credentialsPath),
      inspectProfileRuntime(bobPlan.profile.credentialsPath),
      inspectProfileRuntime(carolPlan.profile.credentialsPath)
    ]);
    assertProfilePrincipals({
      alice: aliceRuntime,
      bob: bobRuntime,
      carol: carolRuntime
    });

    await Promise.all([
      leaveCurrentSprintIfAny(aliceRuntime.entry),
      leaveCurrentSprintIfAny(bobRuntime.entry),
      leaveCurrentSprintIfAny(carolRuntime.entry)
    ]);

    const releaseSprint = await createSprint({
      entry: aliceRuntime.entry,
      displayName: `Sprint release cleanup A ${runId}`,
      goal: `Git release original-context proof ${runId}`
    });
    sprintsToArchive.push({
      entry: aliceRuntime.entry,
      sprint: releaseSprint,
      label: 'release-sprint'
    });
    await joinSprint({
      entry: bobRuntime.entry,
      sprint: releaseSprint,
      expectedOldContext: 'space'
    });

    const alice = await launchPersona({
      personaPlan: alicePlan,
      runtime: aliceRuntime,
      workspace
    });
    sessions.push(alice.session);
    const alicePrompt = [
      `Write ${releasePath}.`,
      `Create the file with exactly these two lines: ${aliceReleaseMarker} and export const sprintReleaseCleanup = ${JSON.stringify(runId)};`,
      'Use the Write tool for the change.',
      'Do not use Teamem MCP tools. After the edit, stop.'
    ].join(' ');
    await delay(INTERACTIVE_STARTUP_SETTLE_MS);
    await alice.session.submit(alicePrompt, {
      delayMs: INTERACTIVE_TYPE_DELAY_MS
    });
    const aliceClaim = await waitForRuntimeClaim({
      entry: aliceRuntime.entry,
      repoId: expectedRepoId,
      targetPath: releasePath,
      expectedPrincipal: aliceRuntime.whoami.principal,
      expectedSprintId: releaseSprint.sprint_id,
      expectedContext: 'sprint',
      runId,
      view: 'current'
    });
    claimsToRelease.push({
      entry: aliceRuntime.entry,
      claimId: aliceClaim.claim_id,
      label: 'alice-release-sprint'
    });
    await waitForCopiedWorkspaceMarker({
      workspaceRoot: workspace.demoWorkspaceLaunchCwd,
      targetPath: releasePath,
      marker: aliceReleaseMarker,
      runId
    });
    assertLiveInteractiveInputEvidence(alice.session, alicePrompt, runId);
    assertPreToolUseAllowEvidence({
      traces: await readHookTraces(alice.session.artifacts.hookTraceDir),
      targetPath: releasePath,
      artifactsDir: alice.session.artifacts.dir
    });

    const bob = await launchPersona({
      personaPlan: bobPlan,
      runtime: bobRuntime,
      workspace
    });
    sessions.push(bob.session);
    const bobDeniedPrompt = [
      `Attempt to write ${releasePath}.`,
      `Replace the file with exactly these two lines: ${bobDeniedMarker} and export const deniedSprintReleaseCleanup = ${JSON.stringify(runId)};`,
      'Use Write, Edit, or MultiEdit for the change before reading, searching, or summarizing the file.',
      'Do not use Teamem MCP tools and do not call teamem.request_edit_permission.',
      'If the Teamem hook denies the edit because another teammate holds the scope claim, stop immediately.'
    ].join(' ');
    await delay(INTERACTIVE_STARTUP_SETTLE_MS);
    await bob.session.submit(bobDeniedPrompt, {
      delayMs: INTERACTIVE_TYPE_DELAY_MS
    });
    const bobDenyHook = await waitForClaimConflictHookEvidence({
      session: bob.session,
      targetPath: releasePath,
      incumbentClaim: aliceClaim,
      incumbentPrincipal: aliceRuntime.whoami.principal,
      runId,
      afterCount: 0
    });
    await assertRuntimePendingEditQueued({
      entry: bobRuntime.entry,
      claimId: aliceClaim.claim_id,
      incumbentPrincipal: aliceRuntime.whoami.principal,
      bobPrincipal: bobRuntime.whoami.principal,
      targetPath: releasePath,
      runId
    });
    await assertCopiedWorkspaceDoesNotContainMarker({
      workspaceRoot: workspace.demoWorkspaceLaunchCwd,
      targetPath: releasePath,
      marker: bobDeniedMarker,
      runId
    });
    assertLiveInteractiveInputEvidence(bob.session, bobDeniedPrompt, runId);

    const releaserCurrentSprint = await createSprint({
      entry: aliceRuntime.entry,
      displayName: `Sprint release cleanup current ${runId}`,
      goal: `Current Sprint must not steal git release routing ${runId}`
    });
    sprintsToArchive.push({
      entry: aliceRuntime.entry,
      sprint: releaserCurrentSprint,
      label: 'releaser-current-sprint'
    });
    await assertCurrentSprint({
      entry: aliceRuntime.entry,
      sprint: releaserCurrentSprint
    });

    const sprintB = await createSprint({
      entry: bobRuntime.entry,
      displayName: `Sprint release cleanup B ${runId}`,
      goal: `Multi-context git release proof ${runId}`
    });
    sprintsToArchive.push({
      entry: bobRuntime.entry,
      sprint: sprintB,
      label: 'sprint-b'
    });
    const bobClaim = await claimRuntimeScope({
      entry: bobRuntime.entry,
      repoId: expectedRepoId,
      targetPath: sprintBPath,
      intent: `multi-context sprint release ${runId}`
    });
    claimsToRelease.push({
      entry: bobRuntime.entry,
      claimId: bobClaim.claim_id,
      label: 'bob-sprint-b'
    });

    await leaveCurrentSprintIfAny(carolRuntime.entry);
    const carolClaim = await claimRuntimeScope({
      entry: carolRuntime.entry,
      repoId: expectedRepoId,
      targetPath: spacePath,
      intent: `multi-context space release ${runId}`
    });
    claimsToRelease.push({
      entry: carolRuntime.entry,
      claimId: carolClaim.claim_id,
      label: 'carol-space'
    });

    await installTeamemGitHooks({
      workspaceRoot: workspace.demoWorkspaceLaunchCwd
    });
    await assertGitHookEvidence(workspace.demoWorkspaceLaunchCwd);
    await appendWorkspaceFile({
      workspaceRoot: workspace.demoWorkspaceLaunchCwd,
      targetPath: releasePath,
      marker: gitReleaseMarker
    });
    await appendWorkspaceFile({
      workspaceRoot: workspace.demoWorkspaceLaunchCwd,
      targetPath: sprintBPath,
      marker: sprintBMarker
    });
    await appendWorkspaceFile({
      workspaceRoot: workspace.demoWorkspaceLaunchCwd,
      targetPath: spacePath,
      marker: spaceMarker
    });
    await prepareGitHookSessionSpace({
      pluginDataDir: alicePlan.profile.pluginDataDir,
      sessionId: runId,
      spaceId: aliceRuntime.entry.space_id
    });
    gitOrThrow({
      cwd: workspace.demoWorkspaceLaunchCwd,
      args: ['add', releasePath, sprintBPath, spacePath],
      env: gitHookEnv({
        profile: alicePlan.profile,
        sessionId: runId,
        projectId: workspace.demoWorkspaceLaunchCwd
      }),
      runId
    });
    const commitResult = gitOrThrow({
      cwd: workspace.demoWorkspaceLaunchCwd,
      args: ['commit', '-m', `Teamem Sprint release cleanup ${runId}`],
      env: gitHookEnv({
        profile: alicePlan.profile,
        sessionId: runId,
        projectId: workspace.demoWorkspaceLaunchCwd
      }),
      runId
    });
    expect(commitResult.stdout).toContain(runId);
    await waitForRuntimeClaimRelease({
      entry: bobRuntime.entry,
      claimId: aliceClaim.claim_id,
      runId
    });
    await waitForRuntimeClaimRelease({
      entry: bobRuntime.entry,
      claimId: bobClaim.claim_id,
      runId
    });
    await waitForRuntimeClaimRelease({
      entry: carolRuntime.entry,
      claimId: carolClaim.claim_id,
      runId
    });
    removeClaimCleanup(claimsToRelease, aliceClaim.claim_id);
    removeClaimCleanup(claimsToRelease, bobClaim.claim_id);
    removeClaimCleanup(claimsToRelease, carolClaim.claim_id);
    await assertGitReleaseRoutingEvidence({
      aliceEntry: aliceRuntime.entry,
      bobEntry: bobRuntime.entry,
      carolEntry: carolRuntime.entry,
      releaseSprint,
      releaserCurrentSprint,
      sprintB,
      claims: {
        alice: aliceClaim,
        bob: bobClaim,
        carol: carolClaim
      },
      targetPaths: {
        release: releasePath,
        sprintB: sprintBPath,
        space: spacePath
      },
      runId
    });
    await assertCopiedWorkspaceMarkers({
      workspaceRoot: workspace.demoWorkspaceLaunchCwd,
      markers: [
        { targetPath: releasePath, marker: gitReleaseMarker },
        { targetPath: sprintBPath, marker: sprintBMarker },
        { targetPath: spacePath, marker: spaceMarker }
      ],
      runId
    });

    const archiveSprint = await createSprint({
      entry: aliceRuntime.entry,
      displayName: `Sprint release cleanup archive ${runId}`,
      goal: `Archive cleanup force-release proof ${runId}`
    });
    sprintsToArchive.push({
      entry: aliceRuntime.entry,
      sprint: archiveSprint,
      label: 'archive-sprint'
    });
    const archiveAliceClaim = await claimRuntimeScope({
      entry: aliceRuntime.entry,
      repoId: expectedRepoId,
      targetPath: archiveAlicePath,
      intent: `archive cleanup alice ${runId}`
    });
    claimsToRelease.push({
      entry: aliceRuntime.entry,
      claimId: archiveAliceClaim.claim_id,
      label: 'archive-alice'
    });
    await joinSprint({
      entry: bobRuntime.entry,
      sprint: archiveSprint,
      expectedOldContext: 'sprint'
    });
    const archiveBobClaim = await claimRuntimeScope({
      entry: bobRuntime.entry,
      repoId: expectedRepoId,
      targetPath: archiveBobPath,
      intent: `archive cleanup bob ${runId}`
    });
    claimsToRelease.push({
      entry: bobRuntime.entry,
      claimId: archiveBobClaim.claim_id,
      label: 'archive-bob'
    });
    await appendWorkspaceFile({
      workspaceRoot: workspace.demoWorkspaceLaunchCwd,
      targetPath: archiveAlicePath,
      marker: archiveAliceMarker
    });
    await appendWorkspaceFile({
      workspaceRoot: workspace.demoWorkspaceLaunchCwd,
      targetPath: archiveBobPath,
      marker: archiveBobMarker
    });
    await Promise.all([
      leaveCurrentSprintIfAny(aliceRuntime.entry),
      leaveCurrentSprintIfAny(bobRuntime.entry)
    ]);
    const archiveResult = await archiveSprintAndAssertCleanup({
      session: alice,
      sprint: archiveSprint,
      expectedClaims: [archiveAliceClaim, archiveBobClaim],
      runId
    });
    removeClaimCleanup(claimsToRelease, archiveAliceClaim.claim_id);
    removeClaimCleanup(claimsToRelease, archiveBobClaim.claim_id);
    removeSprintCleanup(sprintsToArchive, archiveSprint.sprint_id);
    const [aliceCleanupNotices, bobCleanupNotices, carolCleanupNotices] =
      await Promise.all([
        fetchUnreadNotifications(aliceRuntime.entry),
        fetchUnreadNotifications(bobRuntime.entry),
        fetchUnreadNotifications(carolRuntime.entry)
      ]);
    partialEvidence = {
      plan,
      workspace,
      runId,
      commitResult,
      sprints: {
        releaseSprint,
        releaserCurrentSprint,
        sprintB,
        archiveSprint
      },
      claims: {
        aliceRelease: aliceClaim,
        bobSprintB: bobClaim,
        carolSpace: carolClaim,
        archiveAlice: archiveAliceClaim,
        archiveBob: archiveBobClaim
      },
      bobDenyHook,
      archiveResult,
      archiveNotifications: {
        alice: aliceCleanupNotices.notifications,
        bob: bobCleanupNotices.notifications,
        carol: carolCleanupNotices.notifications
      },
      personas: { alice, bob }
    };
    await writeSprintReleaseCleanupEvidence(partialEvidence);
    assertArchiveCleanupUnreadNotice({
      notifications: aliceCleanupNotices.notifications,
      claim: archiveAliceClaim,
      owner: aliceRuntime.whoami.principal,
      releaser: aliceRuntime.whoami.principal,
      sprint: archiveSprint,
      runId
    });
    assertArchiveCleanupUnreadNotice({
      notifications: bobCleanupNotices.notifications,
      claim: archiveBobClaim,
      owner: bobRuntime.whoami.principal,
      releaser: aliceRuntime.whoami.principal,
      sprint: archiveSprint,
      runId
    });
    assertNoArchiveCleanupNoticeForUnrelatedMember({
      notifications: carolCleanupNotices.notifications,
      sprint: archiveSprint,
      runId
    });
    const history = await getSprintHistory({
      entry: aliceRuntime.entry,
      sprint: archiveSprint,
      limit: 3
    });
    partialEvidence = { ...partialEvidence, history };
    await writeSprintReleaseCleanupEvidence(partialEvidence);
    assertArchiveHistoryEvidence({
      history,
      archiveResult,
      expectedClaims: [archiveAliceClaim, archiveBobClaim],
      runId
    });

    await writeSprintReleaseCleanupEvidence({
      plan,
      workspace,
      runId,
      commitResult,
      sprints: {
        releaseSprint,
        releaserCurrentSprint,
        sprintB,
        archiveSprint
      },
      claims: {
        aliceRelease: aliceClaim,
        bobSprintB: bobClaim,
        carolSpace: carolClaim,
        archiveAlice: archiveAliceClaim,
        archiveBob: archiveBobClaim
      },
      bobDenyHook,
      archiveResult,
      archiveNotifications: {
        alice: aliceCleanupNotices.notifications,
        bob: bobCleanupNotices.notifications,
        carol: carolCleanupNotices.notifications
      },
      history,
      personas: { alice, bob }
    });

    await Promise.all([alice.session.close(), bob.session.close()]);
    await Promise.all([
      assertPersonaArtifacts(alice),
      assertPersonaArtifacts(bob)
    ]);
    await Promise.all([
      assertPersonaMcpAndHookArtifacts(alice),
      assertPersonaMcpAndHookArtifacts(bob)
    ]);

    await releaseClaims(claimsToRelease);
    claimsToRelease.length = 0;
    await archiveSprints(sprintsToArchive);
    sprintsToArchive.length = 0;
    success = true;
  } finally {
    for (const session of sessions) {
      try {
        await session.close();
      } catch {
        // Preserve the original failure and artifact paths.
      }
    }
    await releaseClaims(claimsToRelease).catch((err) => {
      console.error(`Failed to release Sprint release-cleanup claims: ${err}`);
    });
    await archiveSprints(sprintsToArchive).catch((err) => {
      console.error(`Failed to archive Sprint release-cleanup Sprints: ${err}`);
    });
    if (!success && partialEvidence) {
      await writeSprintReleaseCleanupEvidence(partialEvidence).catch((err) => {
        console.error(
          `Failed to write partial Sprint release-cleanup evidence: ${err}`
        );
      });
    }
    if (plan) {
      const cleanup = await finishMultiProfileRun(plan, { success });
      if (cleanup.preserved) {
        console.error(
          `Preserving failed Sprint release-cleanup smoke artifacts at ${cleanup.artifactsDir}`
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
          `Preserving failed Sprint release-cleanup demo workspace at ${cleanup.demoWorkspaceLaunchCwd}${cleanup.artifactPath ? ` (report ${cleanup.artifactPath})` : ''}`
        );
      }
    }
  }
}

async function inspectProfileRuntime(
  credentialsPath: string
): Promise<PersonaRuntime> {
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
  return { entry, whoami: whoami.data };
}

function assertProfilePrincipals(input: {
  alice: PersonaRuntime;
  bob: PersonaRuntime;
  carol: PersonaRuntime;
}): void {
  expect(input.alice.whoami.space_id).toBe(input.bob.whoami.space_id);
  expect(input.alice.whoami.space_id).toBe(input.carol.whoami.space_id);
  expect(
    new Set([
      input.alice.whoami.principal,
      input.bob.whoami.principal,
      input.carol.whoami.principal
    ]).size
  ).toBe(3);
}

async function launchPersona(input: {
  personaPlan: MultiProfilePersonaPlan;
  runtime: PersonaRuntime;
  workspace: DemoRepositoryWorkspace;
}): Promise<PersonaSession> {
  const env = createProfileRuntimeEnv(input.personaPlan.profile);
  const tester = createClaudePluginTester({
    pluginDir: teamemPluginDir,
    cwd: input.workspace.demoWorkspaceLaunchCwd,
    artifactsDir: input.personaPlan.artifactDir,
    cleanup: 'never',
    mcp: TEAMEM_MCP_INSTRUMENTATION_OPTIONS,
    env,
    redaction: { mode: 'off' },
    timeouts: {
      interactiveReadinessMs: INTERACTIVE_READINESS_TIMEOUT_MS,
      interactiveWaitMs: INTERACTIVE_WAIT_TIMEOUT_MS,
      interactiveCloseMs: INTERACTIVE_CLOSE_TIMEOUT_MS
    }
  });
  const boot = await tester.boot();
  assertDevLaunchPlanParity({
    personaPlan: input.personaPlan,
    profileEnv: env,
    boot,
    launchCwd: input.workspace.demoWorkspaceLaunchCwd
  });
  const session = await tester.launchInteractive({
    useInstrumentedMcpConfig: true,
    strictMcpConfig: true,
    permissionMode: interactivePermissionMode,
    allowedTools: [
      'Edit',
      'MultiEdit',
      'Write',
      `${pluginScopedToolPrefix}archive_sprint`
    ],
    disallowedTools: disallowedTeamemToolsForEditSmoke(),
    readiness: isClaudeInteractiveReadyOrSafetyPrompt,
    readinessTimeoutMs: INTERACTIVE_READINESS_TIMEOUT_MS,
    waitTimeoutMs: INTERACTIVE_WAIT_TIMEOUT_MS,
    closeTimeoutMs: INTERACTIVE_CLOSE_TIMEOUT_MS
  });
  try {
    await acceptClaudeStartupPromptsIfPresent(
      session,
      INTERACTIVE_READINESS_TIMEOUT_MS
    );
    assertInteractiveLaunchParity({
      personaPlan: input.personaPlan,
      boot,
      session,
      launchCwd: input.workspace.demoWorkspaceLaunchCwd
    });
  } catch (error) {
    try {
      await session.close();
    } catch {
      // Preserve startup failure evidence.
    }
    throw error;
  }

  return {
    personaPlan: input.personaPlan,
    runtime: input.runtime,
    boot,
    session,
    slashCommandPrompt: tester.slashCommandPrompt,
    env
  };
}

function createProfileRuntimeEnv(
  profile: MultiProfilePersonaPlan['profile']
): NodeJS.ProcessEnv {
  return {
    ...createLiveRuntimeEnv(),
    CLAUDE_CONFIG_DIR: profile.claudeConfigDir,
    CLAUDE_CODE_PLUGIN_CACHE_DIR: profile.pluginCacheDir,
    CLAUDE_CODE_MCP_ALLOWLIST_ENV: '1',
    CLAUDE_PLUGIN_DATA: profile.pluginDataDir,
    CLAUDE_PLUGIN_ROOT: teamemPluginDir,
    TEAMEM_CREDENTIALS: profile.credentialsPath,
    TEAMEM_DATA: profile.pluginDataDir,
    TEAMEM_CLAUDE_LAUNCH_INTENT: 'activate'
  };
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
  expect(input.profileEnv.CLAUDE_PLUGIN_DATA).toBe(profile.pluginDataDir);
  expect(input.profileEnv.TEAMEM_DATA).toBe(profile.pluginDataDir);
  expect(input.profileEnv.TEAMEM_CREDENTIALS).toBe(profile.credentialsPath);
  expect(input.boot.plugin.pluginDir).toBe(teamemPluginDir);
  expect(input.boot.instrumentedPlugin.sourcePluginDir).toBe(teamemPluginDir);
  expect(dryRunOutput).toContain(`Launch cwd: ${input.launchCwd}`);
  expect(dryRunOutput).toContain(`Plugin source: ${teamemPluginDir}`);
  expect(dryRunOutput).toContain(`Profile: ${profile.profileName}`);
  expect(dryRunOutput).toContain(`Claude config: ${profile.claudeConfigDir}`);
  expect(dryRunOutput).toContain(`Plugin cache: ${profile.pluginCacheDir}`);
  expect(dryRunOutput).toContain(`Plugin data: ${profile.pluginDataDir}`);
  expect(dryRunOutput).toContain(`Credentials: ${profile.credentialsPath}`);
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
  expect(mcpConfigFlagIndex).toBeGreaterThanOrEqual(0);
  expect(input.session.command.args).toContain('--strict-mcp-config');
  expect(input.boot.instrumentedPlugin.sourcePluginDir).toBe(teamemPluginDir);
  expect(input.personaPlan.result.stdout).toContain(
    `Launch cwd: ${input.launchCwd}`
  );
}

async function createSprint(input: {
  entry: CredentialEntry;
  displayName: string;
  goal: string;
}): Promise<SprintSummary> {
  const response = await callLiveRuntimeTool<SprintLifecycleData>(
    input.entry,
    'teamem.create_sprint',
    {
      display_name: input.displayName,
      goal: input.goal
    }
  );
  const sprint = response.data.sprint;
  if (!sprint) {
    throw new Error(`Expected create_sprint to return ${input.displayName}`);
  }
  expect(response.data.new_context.mode).toBe('sprint');
  expect(response.data.new_context.sprint?.sprint_id).toBe(sprint.sprint_id);
  return sprint;
}

async function joinSprint(input: {
  entry: CredentialEntry;
  sprint: SprintSummary;
  expectedOldContext?: 'space' | 'sprint';
}): Promise<void> {
  const response = await callLiveRuntimeTool<SprintLifecycleData>(
    input.entry,
    'teamem.join_sprint',
    { sprint: input.sprint.slug }
  );
  if (input.expectedOldContext) {
    expect(response.data.old_context.mode).toBe(input.expectedOldContext);
  }
  expect(response.data.new_context.mode).toBe('sprint');
  expect(response.data.new_context.sprint?.sprint_id).toBe(
    input.sprint.sprint_id
  );
}

async function leaveCurrentSprintIfAny(entry: CredentialEntry): Promise<void> {
  const current = await callLiveRuntimeTool<SprintCurrentData>(
    entry,
    'teamem.get_current_sprint',
    {}
  );
  if (current.data.context.mode === 'space') return;
  const response = await callLiveRuntimeTool<SprintLifecycleData>(
    entry,
    'teamem.leave_sprint',
    {}
  );
  expect(response.data.new_context.mode).toBe('space');
}

async function assertCurrentSprint(input: {
  entry: CredentialEntry;
  sprint: SprintSummary;
}): Promise<void> {
  const current = await callLiveRuntimeTool<SprintCurrentData>(
    input.entry,
    'teamem.get_current_sprint',
    {}
  );
  expect(current.data.context.mode).toBe('sprint');
  expect(current.data.sprint?.sprint_id).toBe(input.sprint.sprint_id);
}

async function claimRuntimeScope(input: {
  entry: CredentialEntry;
  repoId: string;
  targetPath: string;
  intent: string;
}): Promise<RuntimeClaim> {
  const claimed = await callLiveRuntimeTool<RuntimeClaimScope>(
    input.entry,
    'teamem.claim_scope',
    {
      scope: { paths: [input.targetPath] },
      repo_id: input.repoId,
      branch: 'main',
      auto_release_mode: 'on_commit',
      intent: input.intent
    }
  );
  const claim = await waitForRuntimeClaim({
    entry: input.entry,
    repoId: input.repoId,
    targetPath: input.targetPath,
    expectedPrincipal: input.entry.member_name,
    expectedSprintId: await currentSprintId(input.entry),
    expectedContext:
      (await currentSprintId(input.entry)) === null ? 'space' : 'sprint',
    runId: input.intent,
    view: 'current'
  });
  expect(claim.claim_id).toBe(claimed.data.claim_id);
  expect(claim.mode).toBe('on_commit');
  return claim;
}

async function currentSprintId(entry: CredentialEntry): Promise<string | null> {
  const current = await callLiveRuntimeTool<SprintCurrentData>(
    entry,
    'teamem.get_current_sprint',
    {}
  );
  return current.data.sprint?.sprint_id ?? null;
}

async function waitForRuntimeClaim(input: {
  entry: CredentialEntry;
  repoId: string;
  targetPath: string;
  expectedPrincipal: string;
  expectedSprintId: string | null;
  expectedContext: 'space' | 'sprint';
  runId: string;
  view: 'current' | 'outside_current_context';
}): Promise<RuntimeClaim> {
  const deadline = Date.now() + LIVE_RUNTIME_POLL_TIMEOUT_MS;
  let lastSummary = 'no runtime claims observed';

  while (Date.now() < deadline) {
    const response = await callLiveRuntimeTool<RuntimeClaims>(
      input.entry,
      'teamem.list_claims',
      { scope: 'self', view: input.view }
    );
    const claim = response.data.claims.find((item) =>
      matchesTargetClaim(item, input)
    );
    if (claim) {
      expect(claim.principal).toBe(input.expectedPrincipal);
      expect(claim.sprint_id).toBe(input.expectedSprintId);
      expect(claim.context).toBe(input.expectedContext);
      return claim;
    }

    lastSummary = summarizeClaims(response.data.claims);
    await delay(500);
  }

  throw new Error(
    `Timed out waiting for ${input.expectedContext} runtime claim on ${input.targetPath} for run id ${input.runId}. Last claims summary: ${lastSummary}`
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
    const [current, outside] = await Promise.all([
      callLiveRuntimeTool<RuntimeClaims>(input.entry, 'teamem.list_claims', {
        scope: 'space',
        view: 'current'
      }),
      callLiveRuntimeTool<RuntimeClaims>(input.entry, 'teamem.list_claims', {
        scope: 'space',
        view: 'outside_current_context'
      })
    ]);
    const visibleClaims = [...current.data.claims, ...outside.data.claims];
    if (!visibleClaims.some((item) => item.claim_id === input.claimId)) {
      return;
    }

    lastSummary = summarizeClaims(visibleClaims);
    await delay(500);
  }

  throw new Error(
    `Timed out waiting for git/archive release ${input.claimId} for run id ${input.runId}. Last claims summary: ${lastSummary}`
  );
}

async function assertRuntimePendingEditQueued(input: {
  entry: CredentialEntry;
  claimId: string;
  incumbentPrincipal: string;
  bobPrincipal: string;
  targetPath: string;
  runId: string;
}): Promise<void> {
  const deadline = Date.now() + LIVE_RUNTIME_POLL_TIMEOUT_MS;
  let lastBriefing = 'no briefing observed';
  while (Date.now() < deadline) {
    const response = await callLiveRuntimeTool<RuntimeBriefing>(
      input.entry,
      'teamem.get_briefing',
      {}
    );
    const activeClaim = response.data.active_claims.find(
      (claim) =>
        claim.principal === input.incumbentPrincipal &&
        claimContainsPath(claim, input.targetPath)
    );
    const queued = activeClaim?.blocking_principals?.find(
      (blocked) =>
        blocked.principal === input.bobPrincipal &&
        (blocked.paths ?? []).includes(input.targetPath)
    );
    if (queued) return;

    lastBriefing = JSON.stringify(response.data.active_claims);
    await delay(500);
  }

  throw new Error(
    `Bob denial did not create pending queued edit for claim ${input.claimId} on ${input.targetPath} for run id ${input.runId}. Last active_claims: ${lastBriefing}`
  );
}

async function assertGitReleaseRoutingEvidence(input: {
  aliceEntry: CredentialEntry;
  bobEntry: CredentialEntry;
  carolEntry: CredentialEntry;
  releaseSprint: SprintSummary;
  releaserCurrentSprint: SprintSummary;
  sprintB: SprintSummary;
  claims: {
    alice: RuntimeClaim;
    bob: RuntimeClaim;
    carol: RuntimeClaim;
  };
  targetPaths: {
    release: string;
    sprintB: string;
    space: string;
  };
  runId: string;
}): Promise<void> {
  const sprintBUpdates = await getRuntimeUpdates({
    entry: input.bobEntry,
    limit: 500
  });
  const sprintBReleaseEvent = findUpdatesPayloadEvent({
    updates: sprintBUpdates,
    eventType: 'scope_released_via_git',
    claim: input.claims.bob,
    targetPath: input.targetPaths.sprintB,
    expectedSprintId: input.sprintB.sprint_id,
    runId: input.runId
  });
  const bobReleaseBriefing = await callLiveRuntimeTool<RuntimeBriefing>(
    input.bobEntry,
    'teamem.get_briefing',
    {}
  );
  expect(bobReleaseBriefing.data.current_context.sprint?.sprint_id).toBe(
    input.sprintB.sprint_id
  );
  expect(
    bobReleaseBriefing.data.recent_notifications.some(
      (notification) =>
        notification.event_type === 'scope_released_via_git' &&
        notification.sprint_id === input.sprintB.sprint_id &&
        notification.delivery_scope === 'sprint' &&
        notification.routing_reason === 'current_sprint' &&
        notification.event_id === sprintBReleaseEvent.event_id
    ),
    `Expected Bob to see Sprint-B git release for ${input.claims.bob.claim_id} on ${input.targetPaths.sprintB} in current Sprint for run id ${input.runId}`
  ).toBe(true);

  await joinSprint({
    entry: input.bobEntry,
    sprint: input.releaseSprint,
    expectedOldContext: 'sprint'
  });
  const bobOriginalContextBriefing = await callLiveRuntimeTool<RuntimeBriefing>(
    input.bobEntry,
    'teamem.get_briefing',
    {}
  );
  const releaseSprintUpdates = await getRuntimeUpdates({
    entry: input.bobEntry,
    limit: 500
  });
  const releaseEvent = findUpdatesPayloadEvent({
    updates: releaseSprintUpdates,
    eventType: 'scope_released_via_git',
    claim: input.claims.alice,
    targetPath: input.targetPaths.release,
    expectedSprintId: input.releaseSprint.sprint_id,
    runId: input.runId
  });
  const conflictResolvedEvent = findUpdatesPayloadEvent({
    updates: releaseSprintUpdates,
    eventType: 'conflict_resolved',
    claim: input.claims.alice,
    targetPath: input.targetPaths.release,
    expectedSprintId: input.releaseSprint.sprint_id,
    runId: input.runId
  });
  expect(
    bobOriginalContextBriefing.data.recent_notifications.some(
      (notification) =>
        notification.event_type === 'scope_released_via_git' &&
        notification.sprint_id === input.releaseSprint.sprint_id &&
        notification.delivery_scope === 'sprint' &&
        notification.routing_reason === 'current_sprint' &&
        notification.event_id === releaseEvent.event_id
    ),
    `Expected git release for Alice claim ${input.claims.alice.claim_id} on ${input.targetPaths.release} to route to the claim's original Sprint for run id ${input.runId}`
  ).toBe(true);
  expect(
    bobOriginalContextBriefing.data.recent_notifications.some(
      (notification) =>
        notification.event_type === 'conflict_resolved' &&
        notification.sprint_id === input.releaseSprint.sprint_id &&
        notification.delivery_scope === 'direct' &&
        notification.routing_reason === 'direct_to_me' &&
        notification.event_id === conflictResolvedEvent.event_id
    ),
    `Expected same-context pending edit for ${input.claims.alice.claim_id} on ${input.targetPaths.release} to unblock Bob directly for run id ${input.runId}`
  ).toBe(true);

  const aliceCurrentBriefing = await callLiveRuntimeTool<RuntimeBriefing>(
    input.aliceEntry,
    'teamem.get_briefing',
    {}
  );
  expect(aliceCurrentBriefing.data.current_context.sprint?.sprint_id).toBe(
    input.releaserCurrentSprint.sprint_id
  );
  expect(
    aliceCurrentBriefing.data.recent_notifications.some(
      (notification) =>
        notification.event_type === 'scope_released_via_git' &&
        notification.sprint_id === input.releaseSprint.sprint_id
    ),
    `Releaser current Sprint must not receive original-Sprint git release noise for run id ${input.runId}`
  ).toBe(false);

  const carolUpdates = await getRuntimeUpdates({
    entry: input.carolEntry,
    limit: 500
  });
  const carolSpaceReleaseEvent = findUpdatesPayloadEvent({
    updates: carolUpdates,
    eventType: 'scope_released_via_git',
    claim: input.claims.carol,
    targetPath: input.targetPaths.space,
    expectedSprintId: null,
    runId: input.runId
  });
  const carolBriefing = await callLiveRuntimeTool<RuntimeBriefing>(
    input.carolEntry,
    'teamem.get_briefing',
    {}
  );
  expect(carolBriefing.data.current_context.mode).toBe('space');
  expect(
    carolBriefing.data.recent_notifications.some(
      (notification) =>
        notification.event_type === 'scope_released_via_git' &&
        notification.sprint_id === null &&
        notification.delivery_scope === 'space' &&
        notification.routing_reason === 'space_mode' &&
        notification.event_id === carolSpaceReleaseEvent.event_id
    ),
    `Expected Space-mode git release for ${input.claims.carol.claim_id} on ${input.targetPaths.space} to route only as Space-mode evidence for run id ${input.runId}`
  ).toBe(true);
  expect(
    carolBriefing.data.recent_notifications.some(
      (notification) =>
        notification.event_type === 'scope_released_via_git' &&
        notification.sprint_id === input.releaseSprint.sprint_id
    ),
    `Carol should not receive unrelated Sprint release noise for run id ${input.runId}`
  ).toBe(false);
  expect(
    carolBriefing.data.recent_notifications.some(
      (notification) =>
        notification.event_type === 'scope_released_via_git' &&
        notification.sprint_id === input.sprintB.sprint_id
    ),
    `Carol should not receive Sprint-B release noise for run id ${input.runId}`
  ).toBe(false);
}

function findUpdatesPayloadEvent(input: {
  updates: RuntimeUpdatesData;
  eventType: 'scope_released_via_git' | 'conflict_resolved';
  claim: RuntimeClaim;
  targetPath: string;
  expectedSprintId: string | null;
  runId: string;
}): TeamemEvent {
  const event = input.updates.events.find((candidate) => {
    if (candidate.event_type !== input.eventType) return false;
    if (candidate.sprint_id !== input.expectedSprintId) return false;
    if (input.eventType === 'scope_released_via_git') {
      return (
        candidate.payload.claim_id === input.claim.claim_id &&
        candidate.payload.path === input.targetPath
      );
    }
    return (
      candidate.payload.blocking_claim_id === input.claim.claim_id &&
      Array.isArray(candidate.payload.previously_blocked_paths) &&
      candidate.payload.previously_blocked_paths.includes(input.targetPath)
    );
  });
  if (!event) {
    throw new Error(
      `Expected ${input.eventType} get_updates payload for claim ${input.claim.claim_id} on ${input.targetPath} in Sprint ${input.expectedSprintId} for run id ${input.runId}. Observed updates: ${JSON.stringify(input.updates.events)}`
    );
  }
  return event;
}

function claimContainsPath(
  claim:
    | RuntimeBriefing['active_claims'][number]
    | RuntimeBriefing['outside_current_context']['active_claims'][number],
  targetPath: string
): boolean {
  if (claim.path === targetPath) return true;
  return (claim.scope?.paths ?? []).includes(targetPath);
}

async function waitForClaimConflictHookEvidence(input: {
  session: InteractiveSession;
  targetPath: string;
  incumbentClaim: RuntimeClaim;
  incumbentPrincipal: string;
  runId: string;
  afterCount: number;
}): Promise<HookTrace> {
  const deadline = Date.now() + INTERACTIVE_WAIT_TIMEOUT_MS;
  let lastSummary = 'no hook traces observed';
  let lastReadError: string | undefined;

  while (Date.now() < deadline) {
    const traces = await readHookTracesIfStable(
      input.session.artifacts.hookTraceDir
    ).catch((err) => {
      lastReadError = formatError(err);
      return [];
    });
    const denyTrace = traces.slice(input.afterCount).find((trace) => {
      if (trace.event !== 'PreToolUse' || trace.exitCode !== 0) {
        return false;
      }
      if (!isEditTraceForTarget(trace, input.targetPath)) {
        return false;
      }
      return (
        trace.stdout.includes('"permissionDecision":"deny"') &&
        trace.stdout.includes(input.incumbentClaim.claim_id) &&
        trace.stdout.includes(input.incumbentPrincipal) &&
        trace.stdout.includes('your intent was queued')
      );
    });
    if (denyTrace) {
      return denyTrace;
    }

    lastSummary = summarizeHookTraces(traces);
    await delay(250);
  }

  throw new Error(
    `Timed out waiting for same-Sprint PreToolUse denial on ${input.targetPath} for run id ${input.runId}. Last hook summary: ${lastSummary}.${lastReadError ? ` Last hook read error: ${lastReadError}.` : ''} Artifacts: ${input.session.artifacts.dir}`
  );
}

async function readHookTracesIfStable(traceDir: string): Promise<HookTrace[]> {
  try {
    return await readHookTraces(traceDir);
  } catch {
    await delay(100);
    return readHookTraces(traceDir);
  }
}

function assertPreToolUseAllowEvidence(input: {
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

async function waitForCopiedWorkspaceMarker(input: {
  workspaceRoot: string;
  targetPath: string;
  marker: string;
  runId: string;
}): Promise<void> {
  const targetFile = join(input.workspaceRoot, input.targetPath);
  const deadline = Date.now() + FILE_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const content = await readOptionalFile(targetFile);
    if (content.includes(input.marker)) return;
    await delay(500);
  }
  throw new Error(
    `Timed out waiting for copied workspace marker for run id ${input.runId} at ${input.targetPath}`
  );
}

async function assertCopiedWorkspaceDoesNotContainMarker(input: {
  workspaceRoot: string;
  targetPath: string;
  marker: string;
  runId: string;
}): Promise<void> {
  const content = await readFile(
    join(input.workspaceRoot, input.targetPath),
    'utf8'
  );
  expect(content, `Unexpected denied marker for ${input.runId}`).not.toContain(
    input.marker
  );
}

async function appendWorkspaceFile(input: {
  workspaceRoot: string;
  targetPath: string;
  marker: string;
}): Promise<void> {
  const targetFile = join(input.workspaceRoot, input.targetPath);
  await mkdir(join(input.workspaceRoot, 'src/features'), { recursive: true });
  const existing = await readOptionalFile(targetFile);
  const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  await writeFile(
    targetFile,
    `${existing}${prefix}${input.marker}\nexport const marker = ${JSON.stringify(input.marker)};\n`
  );
}

async function assertCopiedWorkspaceMarkers(input: {
  workspaceRoot: string;
  markers: Array<{ targetPath: string; marker: string }>;
  runId: string;
}): Promise<void> {
  for (const marker of input.markers) {
    await waitForCopiedWorkspaceMarker({
      workspaceRoot: input.workspaceRoot,
      targetPath: marker.targetPath,
      marker: marker.marker,
      runId: input.runId
    });
  }
}

async function assertPersonaArtifacts(
  launchedPersona: PersonaSession
): Promise<void> {
  await expect(
    stat(launchedPersona.session.artifacts.summaryPath)
  ).resolves.toBeTruthy();
  await expect(
    stat(launchedPersona.session.artifacts.environmentPath)
  ).resolves.toBeTruthy();
  await expect(
    stat(launchedPersona.session.artifacts.rawTranscriptPath)
  ).resolves.toBeTruthy();
  await expect(
    stat(launchedPersona.session.artifacts.normalizedTranscriptPath)
  ).resolves.toBeTruthy();
  const environment = JSON.parse(
    await readFile(launchedPersona.session.artifacts.environmentPath, 'utf8')
  ) as { env?: Record<string, string> };
  const summary = JSON.parse(
    await readFile(launchedPersona.session.artifacts.summaryPath, 'utf8')
  ) as {
    kind?: string;
    exitStatus?: { errorCode?: string };
  };
  expect(summary.kind).toBe('interactive');
  expect(summary.exitStatus?.errorCode).toBeUndefined();
  expect(environment.env ?? {}).toMatchObject({
    CLAUDE_PLUGIN_DATA: launchedPersona.env.CLAUDE_PLUGIN_DATA,
    CLAUDE_PLUGIN_ROOT: launchedPersona.env.CLAUDE_PLUGIN_ROOT,
    TEAMEM_DATA: launchedPersona.env.TEAMEM_DATA
  });
}

async function assertPersonaMcpAndHookArtifacts(
  launchedPersona: PersonaSession
): Promise<void> {
  const [hookTraces, mcpTraces] = await Promise.all([
    readHookTraces(launchedPersona.session.artifacts.hookTraceDir),
    readMcpTraces(launchedPersona.session.artifacts.mcpTraceDir)
  ]);
  expect(hookTraces.some((trace) => trace.event === 'SessionStart')).toBe(true);
  expect(hookTraces.some((trace) => trace.event === 'PreToolUse')).toBe(true);
  assertNoTeamemChannelMcpTrace(mcpTraces);
  const teamemTrace = mcpTraces.find((trace) => trace.serverName === 'teamem');
  if (teamemTrace) {
    await expect(stat(teamemTrace.artifacts.tracePath)).resolves.toBeTruthy();
  }
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

async function prepareGitHookSessionSpace(input: {
  pluginDataDir: string;
  sessionId: string;
  spaceId: string;
}): Promise<void> {
  const sessionDir = join(input.pluginDataDir, 'sessions', input.sessionId);
  await mkdir(sessionDir, { recursive: true });
  await writeFile(join(sessionDir, 'space'), input.spaceId);
  await expect(readFile(join(sessionDir, 'space'), 'utf8')).resolves.toBe(
    input.spaceId
  );
}

function gitHookEnv(input: {
  profile: MultiProfilePersonaPlan['profile'];
  sessionId: string;
  projectId: string;
}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: 'Teamem Sprint Release Cleanup Smoke',
    GIT_AUTHOR_EMAIL: 'teamem-sprint-release-cleanup-smoke@example.com',
    GIT_COMMITTER_NAME: 'Teamem Sprint Release Cleanup Smoke',
    GIT_COMMITTER_EMAIL: 'teamem-sprint-release-cleanup-smoke@example.com',
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: devNull,
    CLAUDE_CONFIG_DIR: input.profile.claudeConfigDir,
    CLAUDE_CODE_PLUGIN_CACHE_DIR: input.profile.pluginCacheDir,
    CLAUDE_CODE_MCP_ALLOWLIST_ENV: '1',
    CLAUDE_PLUGIN_DATA: input.profile.pluginDataDir,
    CLAUDE_PLUGIN_ROOT: teamemPluginDir,
    TEAMEM_CREDENTIALS: input.profile.credentialsPath,
    TEAMEM_PLUGIN_ROOT: teamemPluginDir,
    TEAMEM_DATA: input.profile.pluginDataDir,
    GIT_TEAMEM_SESSION_ID: input.sessionId,
    TEAMEM_PROJECT_ID: input.projectId,
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

async function archiveSprintAndAssertCleanup(input: {
  session: PersonaSession;
  sprint: SprintSummary;
  expectedClaims: RuntimeClaim[];
  runId: string;
}): Promise<SprintArchiveData> {
  const archivePrompt = await input.session.slashCommandPrompt(
    'teamem-sprint',
    `archive ${input.sprint.slug}`
  );
  const archived = await submitAndWaitForToolResponse<SprintArchiveData>({
    session: input.session.session,
    prompt: archivePrompt,
    toolName: 'archive_sprint'
  });
  expect(archived.sprint.status).toBe('archived');
  expect(archived.sprint.sprint_id).toBe(input.sprint.sprint_id);
  for (const expectedClaim of input.expectedClaims) {
    expect(
      archived.released_claims.some(
        (released) =>
          released.claim_id === expectedClaim.claim_id &&
          released.original_holder === expectedClaim.principal
      ),
      `Expected plugin archive response to include released claim ${expectedClaim.claim_id} for run id ${input.runId}`
    ).toBe(true);
  }
  return archived;
}

async function submitAndWaitForToolResponse<TData>(input: {
  session: InteractiveSession;
  prompt: string;
  toolName: string;
}): Promise<TData> {
  const beforeCount = successfulTeamemToolResponseMessages(
    await readMcpTraces(input.session.artifacts.mcpTraceDir, {
      ignoreTransientErrors: true
    }),
    input.toolName
  ).length;

  await input.session.submit(input.prompt, {
    delayMs: INTERACTIVE_TYPE_DELAY_MS
  });

  const message = await waitForNextSuccessfulToolResponse({
    session: input.session,
    toolName: input.toolName,
    beforeCount
  });
  return parseToolEnvelope<TData>(message).data;
}

async function waitForNextSuccessfulToolResponse(input: {
  session: InteractiveSession;
  toolName: string;
  beforeCount: number;
}): Promise<McpTraceMessage> {
  const deadline = Date.now() + INTERACTIVE_WAIT_TIMEOUT_MS;
  let lastTraceSummary = 'no MCP traces observed';

  while (Date.now() < deadline) {
    const traces = await readMcpTraces(input.session.artifacts.mcpTraceDir, {
      ignoreTransientErrors: true
    });
    const responses = successfulTeamemToolResponseMessages(
      traces,
      input.toolName
    );
    if (responses.length > input.beforeCount) {
      return responses.at(-1)!;
    }

    lastTraceSummary = summarizeMcpTraces(traces);
    await delay(250);
  }

  throw new Error(
    `Timed out waiting for /teamem-sprint MCP response ${input.toolName}. Last trace summary: ${lastTraceSummary}. Artifacts: ${input.session.artifacts.dir}`
  );
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
        normalizeTeamemToolName(message.metadata.toolName) === expectedToolName
      );
    });
}

function parseToolEnvelope<TData>(
  message: McpTraceMessage
): ToolEnvelope<TData> {
  const json = isRecord(message.json) ? message.json : {};
  const result = isRecord(json.result) ? json.result : {};
  const content = Array.isArray(result.content) ? result.content : [];
  const textBlock = content.find((item) => {
    const record = isRecord(item) ? item : {};
    return record.type === 'text' && typeof record.text === 'string';
  });
  const text = isRecord(textBlock) ? textBlock.text : undefined;
  if (typeof text !== 'string') {
    throw new Error(
      `Expected unredacted MCP text response for ${message.metadata?.toolName ?? 'unknown tool'}. Artifacts: ${message.artifacts.tracePath}`
    );
  }

  const parsed = JSON.parse(text) as unknown;
  if (!isToolEnvelope<TData>(parsed)) {
    throw new Error(
      `Expected successful MCP tool envelope for ${message.metadata?.toolName ?? 'unknown tool'}. Artifacts: ${message.artifacts.tracePath}`
    );
  }
  return parsed;
}

function isToolEnvelope<TData>(value: unknown): value is ToolEnvelope<TData> {
  return isRecord(value) && value.ok === true && 'data' in value;
}

async function fetchUnreadNotifications(
  entry: CredentialEntry
): Promise<RuntimeUnreadNotifications> {
  const response = await callLiveRuntimeTool<RuntimeUnreadNotifications>(
    entry,
    'teamem.fetch_unread_notifications',
    {}
  );
  return response.data;
}

function assertArchiveCleanupUnreadNotice(input: {
  notifications: RuntimeUnreadNotifications['notifications'];
  claim: RuntimeClaim;
  owner: string;
  releaser: string;
  sprint: SprintSummary;
  runId: string;
}): void {
  const notice = input.notifications.find(
    (notification) =>
      notification.event_type === 'claim_force_released' &&
      notification.payload.claim_id === input.claim.claim_id &&
      notification.payload.original_holder === input.owner &&
      notification.payload.released_by === input.releaser &&
      notification.payload.archive_cleanup === true &&
      notification.payload.sprint_id === input.sprint.sprint_id
  );
  expect(
    notice,
    `Expected direct archive cleanup unread notice for ${input.claim.claim_id} and run id ${input.runId}`
  ).toBeDefined();
}

function assertNoArchiveCleanupNoticeForUnrelatedMember(input: {
  notifications: RuntimeUnreadNotifications['notifications'];
  sprint: SprintSummary;
  runId: string;
}): void {
  expect(
    input.notifications.some(
      (notification) =>
        notification.event_type === 'claim_force_released' &&
        notification.payload.archive_cleanup === true &&
        notification.payload.sprint_id === input.sprint.sprint_id
    ),
    `Unrelated Space member should not receive archive cleanup direct notices for run id ${input.runId}`
  ).toBe(false);
}

async function getSprintHistory(input: {
  entry: CredentialEntry;
  sprint: SprintSummary;
  limit: number;
}): Promise<SprintHistoryData> {
  const response = await callLiveRuntimeTool<SprintHistoryData>(
    input.entry,
    'teamem.get_sprint_history',
    { sprint: input.sprint.slug, limit: input.limit }
  );
  return response.data;
}

async function getRuntimeUpdates(input: {
  entry: CredentialEntry;
  limit: number;
  maxPages?: number;
}): Promise<RuntimeUpdatesData> {
  const events: TeamemEvent[] = [];
  const seenCursors = new Set<string>();
  let since: string | undefined;
  let nextCursor: string | null = null;
  const maxPages = input.maxPages ?? 25;

  for (let page = 0; page < maxPages; page += 1) {
    const response = await callLiveRuntimeTool<RuntimeUpdatesData>(
      input.entry,
      'teamem.get_updates',
      since ? { since, limit: input.limit } : { limit: input.limit },
      10_000
    );
    events.push(...response.data.events);
    nextCursor = response.data.next_cursor;

    if (!nextCursor) {
      return { events, next_cursor: null };
    }
    if (seenCursors.has(nextCursor)) {
      throw new Error(
        `teamem.get_updates returned repeated cursor ${nextCursor} after ${page + 1} pages`
      );
    }
    seenCursors.add(nextCursor);
    since = nextCursor;
  }

  throw new Error(
    `teamem.get_updates exceeded ${maxPages} pages while scanning visible updates; last cursor ${nextCursor ?? 'null'}`
  );
}

function assertArchiveHistoryEvidence(input: {
  history: SprintHistoryData;
  archiveResult: SprintArchiveData;
  expectedClaims: RuntimeClaim[];
  runId: string;
}): void {
  expect(input.history.limit).toBe(3);
  expect(input.history.events.length).toBeLessThanOrEqual(3);
  expect(input.history.truncated).toBe(true);
  expect(
    input.history.events.some((event) => event.event_type === 'sprint_archived')
  ).toBe(true);
  for (const expectedClaim of input.expectedClaims) {
    expect(
      input.history.events.some(
        (event) =>
          event.event_type === 'claim_force_released' &&
          event.payload.claim_id === expectedClaim.claim_id &&
          event.payload.archive_cleanup === true
      ),
      `Expected capped Sprint history to include archive cleanup audit for ${expectedClaim.claim_id} and run id ${input.runId}`
    ).toBe(true);
  }
  expect(
    input.archiveResult.event_ids.every((eventId) =>
      input.history.events.some((event) => event.event_id === eventId)
    )
  ).toBe(true);
}

type PartialSprintReleaseCleanupEvidence = {
  plan: MultiProfileRunPlan;
  workspace: DemoRepositoryWorkspace;
  runId: string;
  commitResult: GitResult;
  sprints: Record<string, SprintSummary>;
  claims: Record<string, RuntimeClaim>;
  bobDenyHook: HookTrace;
  archiveResult: SprintArchiveData;
  archiveNotifications: Record<
    string,
    RuntimeUnreadNotifications['notifications']
  >;
  history?: SprintHistoryData;
  personas: {
    alice: PersonaSession;
    bob: PersonaSession;
  };
};

async function writeSprintReleaseCleanupEvidence(
  input: PartialSprintReleaseCleanupEvidence
): Promise<void> {
  await writeFile(
    join(input.plan.artifactsDir, `sprint-release-cleanup-${input.runId}.json`),
    `${JSON.stringify(
      {
        runId: input.runId,
        artifactsDir: input.plan.artifactsDir,
        workspace: input.workspace.demoWorkspaceLaunchCwd,
        commitResult: input.commitResult,
        sprints: input.sprints,
        claims: input.claims,
        bobDenyHook: {
          event: input.bobDenyHook.event,
          exitCode: input.bobDenyHook.exitCode,
          stdout: input.bobDenyHook.stdout,
          stderr: input.bobDenyHook.stderr,
          artifacts: input.bobDenyHook.artifacts
        },
        archiveResult: input.archiveResult,
        archiveNotifications: input.archiveNotifications,
        history: input.history,
        personas: {
          alice: personaEvidence(input.personas.alice),
          bob: personaEvidence(input.personas.bob)
        }
      },
      null,
      2
    )}\n`
  );
}

function personaEvidence(persona: PersonaSession): Record<string, unknown> {
  return {
    persona: persona.personaPlan.persona,
    principal: persona.runtime.whoami.principal,
    profileName: persona.personaPlan.profile.profileName,
    artifactRunDir: persona.session.artifacts.dir,
    summaryPath: persona.session.artifacts.summaryPath,
    environmentPath: persona.session.artifacts.environmentPath,
    rawTranscriptPath: persona.session.artifacts.rawTranscriptPath,
    normalizedTranscriptPath:
      persona.session.artifacts.normalizedTranscriptPath,
    mcpTraceDir: persona.session.artifacts.mcpTraceDir,
    hookTraceDir: persona.session.artifacts.hookTraceDir
  };
}

async function releaseClaims(
  claims: Array<{ entry: CredentialEntry; claimId: string; label: string }>
): Promise<void> {
  while (claims.length > 0) {
    const claim = claims.pop()!;
    const response = await callLiveRuntimeTool<RuntimeReleaseScope>(
      claim.entry,
      'teamem.release_scope',
      { claim_id: claim.claimId }
    );
    expect(
      response.data.released,
      `Expected to release ${claim.label} claim ${claim.claimId}`
    ).toBe(true);
  }
}

async function archiveSprints(
  sprints: Array<{
    entry: CredentialEntry;
    sprint: SprintSummary;
    label: string;
  }>
): Promise<void> {
  while (sprints.length > 0) {
    const item = sprints.pop()!;
    const current = await callLiveRuntimeTool<SprintCurrentData>(
      item.entry,
      'teamem.get_current_sprint',
      {}
    );
    if (current.data.sprint?.sprint_id === item.sprint.sprint_id) {
      await callLiveRuntimeTool<SprintLifecycleData>(
        item.entry,
        'teamem.leave_sprint',
        {}
      );
    }
    const archived = await callLiveRuntimeTool<SprintArchiveData>(
      item.entry,
      'teamem.archive_sprint',
      { sprint: item.sprint.slug }
    );
    expect(
      archived.data.sprint.status,
      `Expected cleanup archive for ${item.label}`
    ).toBe('archived');
  }
}

function sprintReleaseCleanupPersonas(): readonly MultiProfilePersona[] {
  return [
    ...defaultMultiProfilePersonas(),
    {
      persona: 'carol',
      profileName: process.env.TEAMEM_CAROL_PROFILE ?? 'carol',
      ownership: 'developer'
    }
  ];
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
    `${canonicalTeamemToolPrefix}create_sprint`,
    `${canonicalTeamemToolPrefix}join_sprint`,
    `${canonicalTeamemToolPrefix}leave_sprint`,
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
    `${pluginScopedToolPrefix}list_sprints`,
    `${pluginScopedToolPrefix}create_sprint`,
    `${pluginScopedToolPrefix}join_sprint`,
    `${pluginScopedToolPrefix}leave_sprint`
  ];
}

function matchesTargetClaim(
  claim: RuntimeClaim,
  input: { repoId: string; targetPath: string }
): boolean {
  return (
    claim.repo_id === input.repoId &&
    claim.branch === 'main' &&
    claim.path === input.targetPath &&
    claim.mode === 'on_commit' &&
    claim.status === 'active'
  );
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
        `${claim.claim_id}:${claim.principal}:${claim.repo_id}:${claim.branch}:${claim.path}:${claim.status}:${claim.mode}:${claim.context}:${claim.sprint_id ?? 'no-sprint'}`
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

function summarizeMcpTraces(traces: McpTrace[]): string {
  if (traces.length === 0) {
    return 'none';
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

function normalizeTeamemToolName(toolName: string): string {
  if (toolName.startsWith(pluginScopedToolPrefix)) {
    return toolName.slice(pluginScopedToolPrefix.length);
  }
  if (toolName.startsWith(canonicalTeamemToolPrefix)) {
    return toolName.slice(canonicalTeamemToolPrefix.length);
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

function removeClaimCleanup(
  claims: Array<{ entry: CredentialEntry; claimId: string; label: string }>,
  claimId: string
): void {
  const index = claims.findIndex((claim) => claim.claimId === claimId);
  if (index >= 0) claims.splice(index, 1);
}

function removeSprintCleanup(
  sprints: Array<{
    entry: CredentialEntry;
    sprint: SprintSummary;
    label: string;
  }>,
  sprintId: string
): void {
  const index = sprints.findIndex((item) => item.sprint.sprint_id === sprintId);
  if (index >= 0) sprints.splice(index, 1);
}

async function readOptionalFile(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return '';
  }
}

function formatGateReason(): string {
  return `set TEAMEM_CLAUDE_PLUGIN_E2E=1, TEAMEM_CLAUDE_PLUGIN_INTERACTIVE_E2E=1, TEAMEM_CLAUDE_PLUGIN_STATEFUL_E2E=1, ${TEAMEM_MULTI_PROFILE_E2E_ENV}=1, and CLAUDE_PLUGIN_E2E_ALLOW_UNREDACTED=1 to run L5 Sprint release-cleanup Claude plugin smoke`;
}

function createRunId(): string {
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
