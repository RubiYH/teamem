import { describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

type SprintContext =
  | { mode: 'space'; sprint: null }
  | { mode: 'sprint'; sprint: SprintSummary };

type SprintLifecycleData = {
  sprint: SprintSummary | null;
  old_context: SprintContext;
  new_context: SprintContext;
  event_ids: string[];
  idempotent: boolean;
  message: string;
  warnings: string[];
};

type SprintCurrentData = {
  context: SprintContext;
  sprint: SprintSummary | null;
  current_members: string[];
};

type SprintListData = {
  sprints: Array<
    SprintSummary & {
      current_members: string[];
      last_activity_at: string | null;
    }
  >;
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

type RuntimeBriefing = {
  current_context: {
    mode: 'space' | 'sprint';
    sprint: (SprintSummary & { current_members: string[] }) | null;
  };
  active_claims: Array<{
    claim_id?: string;
    principal?: string;
    path?: string;
    scope?: {
      paths?: string[];
    };
    intent?: string;
    blocking_principals?: Array<{
      principal?: string;
      intent?: string;
      paths?: string[];
    }>;
  }>;
  outside_current_context: {
    active_claims: Array<{
      principal?: string;
      path?: string;
      scope?: {
        paths?: string[];
      };
      intent?: string;
    }>;
  };
  meta: {
    cross_context_overlap_awareness?: {
      overlapping_claims: number;
    };
  };
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
  readonly env: NodeJS.ProcessEnv;
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
const liveSprintClaimConflictGateEnabled =
  liveGateEnabled &&
  interactiveGateEnabled &&
  statefulGateEnabled &&
  multiProfileGateEnabled &&
  unredactedTraceGateEnabled;
const describeLiveSprintClaimConflict = liveSprintClaimConflictGateEnabled
  ? describe
  : describe.skip;
const interactivePermissionMode = liveSprintClaimConflictGateEnabled
  ? resolveTeamemInteractivePermissionMode(
      process.env,
      DEFAULT_TEAMEM_INTERACTIVE_SCRIPT_PERMISSION_MODE
    )
  : DEFAULT_TEAMEM_INTERACTIVE_PERMISSION_MODE;

const repoRoot = process.cwd();
const teamemPluginDir = join(repoRoot, 'plugin');
const LIVE_SPRINT_CLAIM_CONFLICT_TIMEOUT_MS = 540_000;
const INTERACTIVE_READINESS_TIMEOUT_MS = 30_000;
const INTERACTIVE_WAIT_TIMEOUT_MS = 90_000;
const INTERACTIVE_CLOSE_TIMEOUT_MS = 10_000;
const INTERACTIVE_STARTUP_SETTLE_MS = 2_000;
const INTERACTIVE_TYPE_DELAY_MS = 20;
const LIVE_RUNTIME_POLL_TIMEOUT_MS = 45_000;
const FILE_POLL_TIMEOUT_MS = 60_000;
const pluginScopedToolPrefix = 'mcp__plugin_teamem_teamem__teamem_';
const canonicalTeamemToolPrefix = 'mcp__teamem__teamem_';

describeLiveSprintClaimConflict(
  `Teamem L5 Sprint claim conflict live smoke${liveSprintClaimConflictGateEnabled ? '' : ` (${formatGateReason()})`}`,
  () => {
    it(
      'proves same-Sprint conflicts queue while cross-Sprint and Space overlaps stay non-blocking',
      async () => {
        await withLiveInteractiveSmokeLock(
          'teamem-interactive-sprint-claim-conflict-smoke',
          runSprintClaimConflictCase
        );
      },
      LIVE_SPRINT_CLAIM_CONFLICT_TIMEOUT_MS
    );
  }
);

async function runSprintClaimConflictCase(): Promise<void> {
  let workspace: DemoRepositoryWorkspace | undefined;
  let plan: MultiProfileRunPlan | undefined;
  const sessions: InteractiveSession[] = [];
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
    const marker = `teamem-sprint-claim-conflict-${runId}`;
    const targetPath = `src/features/${marker}.ts`;
    const aliceMarker = `// alice same-sprint ${marker}`;
    const bobDeniedMarker = `// bob same-sprint denied ${marker}`;
    const bobCrossSprintMarker = `// bob cross-sprint allowed ${marker}`;
    const carolSpaceMarker = `// carol space allowed ${marker}`;
    const expectedRepoId = await realpath(workspace.demoWorkspaceLaunchCwd);

    plan = await planTeamemDevClaudeMultiProfileRun({
      runId,
      personas: sprintClaimConflictPersonas(),
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

    const sprintA = await createSprint({
      entry: aliceRuntime.entry,
      displayName: `Sprint claim conflict A ${runId}`,
      goal: `Same-Sprint conflict proof ${runId}`
    });
    sprintsToArchive.push({
      entry: aliceRuntime.entry,
      sprint: sprintA,
      label: 'sprint-a'
    });
    await joinSprint({
      entry: bobRuntime.entry,
      sprint: sprintA,
      expectedOldContext: 'space'
    });
    await leaveCurrentSprintIfAny(carolRuntime.entry);

    const alice = await launchPersona({
      personaPlan: alicePlan,
      runtime: aliceRuntime,
      workspace
    });
    sessions.push(alice.session);
    const alicePrompt = [
      `Write ${targetPath}.`,
      `Create the file with exactly these two lines: ${aliceMarker} and export const sprintClaimConflictMarker = ${JSON.stringify(marker)};`,
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
      targetPath,
      expectedPrincipal: aliceRuntime.whoami.principal,
      expectedSprintId: sprintA.sprint_id,
      expectedContext: 'sprint',
      runId,
      view: 'current'
    });
    claimsToRelease.push({
      entry: aliceRuntime.entry,
      claimId: aliceClaim.claim_id,
      label: 'alice-sprint-a'
    });
    await waitForCopiedWorkspaceMarker({
      workspaceRoot: workspace.demoWorkspaceLaunchCwd,
      targetPath,
      marker: aliceMarker,
      runId
    });
    assertLiveInteractiveInputEvidence(alice.session, alicePrompt, marker);
    await alice.session.close();
    await assertPersonaArtifacts(alice);
    assertPreToolUseAllowEvidence({
      traces: await readHookTraces(alice.session.artifacts.hookTraceDir),
      targetPath,
      artifactsDir: alice.session.artifacts.dir
    });

    await leaveCurrentSprintIfAny(aliceRuntime.entry);
    const sprintC = await createSprint({
      entry: aliceRuntime.entry,
      displayName: `Sprint claim conflict C ${runId}`,
      goal: `Claim stability proof ${runId}`
    });
    sprintsToArchive.push({
      entry: aliceRuntime.entry,
      sprint: sprintC,
      label: 'sprint-c'
    });
    await assertClaimContextStableAfterSprintSwitch({
      entry: aliceRuntime.entry,
      expectedClaim: aliceClaim,
      newSprint: sprintC,
      runId
    });

    const bob = await launchPersona({
      personaPlan: bobPlan,
      runtime: bobRuntime,
      workspace
    });
    sessions.push(bob.session);
    await assertRuntimeClaimVisibleInCurrentContext({
      entry: bobRuntime.entry,
      expectedClaim: aliceClaim,
      expectedSprintId: sprintA.sprint_id,
      runId
    });
    const bobDeniedPrompt = [
      `Attempt to write ${targetPath}.`,
      `Replace the file with exactly these two lines: ${bobDeniedMarker} and export const deniedSprintConflictMarker = ${JSON.stringify(marker)};`,
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
      targetPath,
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
      targetPath,
      runId
    });
    await assertCopiedWorkspaceDoesNotContainMarker({
      workspaceRoot: workspace.demoWorkspaceLaunchCwd,
      targetPath,
      marker: bobDeniedMarker,
      runId
    });
    assertLiveInteractiveInputEvidence(
      bob.session,
      bobDeniedPrompt,
      bobDeniedMarker
    );

    const sprintB = await createSprint({
      entry: bobRuntime.entry,
      displayName: `Sprint claim conflict B ${runId}`,
      goal: `Cross-Sprint non-blocking proof ${runId}`
    });
    sprintsToArchive.push({
      entry: bobRuntime.entry,
      sprint: sprintB,
      label: 'sprint-b'
    });
    const beforeBobCrossSprintHooks = (
      await readHookTraces(bob.session.artifacts.hookTraceDir)
    ).length;
    const bobCrossSprintPrompt = [
      `Write ${targetPath}.`,
      `Replace the file with exactly these two lines: ${bobCrossSprintMarker} and export const crossSprintClaimConflictMarker = ${JSON.stringify(marker)};`,
      'Use Write, Edit, or MultiEdit for the change before reading, searching, or summarizing the file.',
      'Do not use Teamem MCP tools. After the edit, stop.'
    ].join(' ');
    await bob.session.submit(bobCrossSprintPrompt, {
      delayMs: INTERACTIVE_TYPE_DELAY_MS
    });
    const bobClaim = await waitForRuntimeClaim({
      entry: bobRuntime.entry,
      repoId: expectedRepoId,
      targetPath,
      expectedPrincipal: bobRuntime.whoami.principal,
      expectedSprintId: sprintB.sprint_id,
      expectedContext: 'sprint',
      runId,
      view: 'current'
    });
    claimsToRelease.push({
      entry: bobRuntime.entry,
      claimId: bobClaim.claim_id,
      label: 'bob-sprint-b'
    });
    await waitForCopiedWorkspaceMarker({
      workspaceRoot: workspace.demoWorkspaceLaunchCwd,
      targetPath,
      marker: bobCrossSprintMarker,
      runId
    });
    await assertNoDenyHookAfter({
      session: bob.session,
      targetPath,
      afterCount: beforeBobCrossSprintHooks,
      runId,
      label: 'cross-Sprint overlap'
    });
    assertLiveInteractiveInputEvidence(
      bob.session,
      bobCrossSprintPrompt,
      bobCrossSprintMarker
    );

    const carol = await launchPersona({
      personaPlan: carolPlan,
      runtime: carolRuntime,
      workspace
    });
    sessions.push(carol.session);
    const carolPrompt = [
      `Write ${targetPath}.`,
      `Replace the file with exactly these two lines: ${carolSpaceMarker} and export const spaceSprintClaimConflictMarker = ${JSON.stringify(marker)};`,
      'Use Write, Edit, or MultiEdit for the change before reading, searching, or summarizing the file.',
      'Do not use Teamem MCP tools. After the edit, stop.'
    ].join(' ');
    await delay(INTERACTIVE_STARTUP_SETTLE_MS);
    await carol.session.submit(carolPrompt, {
      delayMs: INTERACTIVE_TYPE_DELAY_MS
    });
    const carolClaim = await waitForRuntimeClaim({
      entry: carolRuntime.entry,
      repoId: expectedRepoId,
      targetPath,
      expectedPrincipal: carolRuntime.whoami.principal,
      expectedSprintId: null,
      expectedContext: 'space',
      runId,
      view: 'current'
    });
    claimsToRelease.push({
      entry: carolRuntime.entry,
      claimId: carolClaim.claim_id,
      label: 'carol-space'
    });
    await waitForCopiedWorkspaceMarker({
      workspaceRoot: workspace.demoWorkspaceLaunchCwd,
      targetPath,
      marker: carolSpaceMarker,
      runId
    });
    await assertNoDenyHookAfter({
      session: carol.session,
      targetPath,
      afterCount: 0,
      runId,
      label: 'Sprint-vs-Space overlap'
    });
    assertLiveInteractiveInputEvidence(carol.session, carolPrompt, marker);

    const bobBriefing = await assertLowPriorityCrossContextAwareness({
      entry: bobRuntime.entry,
      currentClaim: bobClaim,
      outsideClaims: [aliceClaim, carolClaim],
      targetPath,
      runId
    });

    await writeSprintClaimConflictEvidence({
      plan,
      workspace,
      runId,
      targetPath,
      sprints: { sprintA, sprintB, sprintC },
      prompts: {
        alice: alicePrompt,
        bobDenied: bobDeniedPrompt,
        bobCrossSprint: bobCrossSprintPrompt,
        carol: carolPrompt
      },
      claims: {
        alice: aliceClaim,
        bob: bobClaim,
        carol: carolClaim
      },
      bobDenyHook,
      bobBriefing,
      personas: { alice, bob, carol }
    });

    await Promise.all([bob.session.close(), carol.session.close()]);
    await Promise.all([
      assertPersonaArtifacts(bob),
      assertPersonaArtifacts(carol)
    ]);
    await Promise.all([
      assertPersonaMcpAndHookArtifacts(alice),
      assertPersonaMcpAndHookArtifacts(bob),
      assertPersonaMcpAndHookArtifacts(carol)
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
      console.error(`Failed to release Sprint claim-conflict claims: ${err}`);
    });
    await archiveSprints(sprintsToArchive).catch((err) => {
      console.error(`Failed to archive Sprint claim-conflict Sprints: ${err}`);
    });
    if (plan) {
      const cleanup = await finishMultiProfileRun(plan, { success });
      if (cleanup.preserved) {
        console.error(
          `Preserving failed Sprint claim-conflict smoke artifacts at ${cleanup.artifactsDir}`
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
          `Preserving failed Sprint claim-conflict demo workspace at ${cleanup.demoWorkspaceLaunchCwd}${cleanup.artifactPath ? ` (report ${cleanup.artifactPath})` : ''}`
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
  const env = createProfileRuntimeEnv(
    input.personaPlan.profile,
    teamemPluginDir
  );
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
    allowedTools: ['Edit', 'MultiEdit', 'Write'],
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
    env
  };
}

function createProfileRuntimeEnv(
  profile: MultiProfilePersonaPlan['profile'],
  pluginRoot: string
): NodeJS.ProcessEnv {
  return {
    ...createLiveRuntimeEnv(),
    CLAUDE_CONFIG_DIR: profile.claudeConfigDir,
    CLAUDE_CODE_PLUGIN_CACHE_DIR: profile.pluginCacheDir,
    CLAUDE_CODE_MCP_ALLOWLIST_ENV: '1',
    CLAUDE_PLUGIN_DATA: profile.pluginDataDir,
    CLAUDE_PLUGIN_ROOT: pluginRoot,
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

async function assertRuntimeClaimVisibleInCurrentContext(input: {
  entry: CredentialEntry;
  expectedClaim: RuntimeClaim;
  expectedSprintId: string | null;
  runId: string;
}): Promise<void> {
  const response = await callLiveRuntimeTool<RuntimeClaims>(
    input.entry,
    'teamem.list_claims',
    { scope: 'space', view: 'current' }
  );
  const claim = response.data.claims.find(
    (candidate) => candidate.claim_id === input.expectedClaim.claim_id
  );
  if (!claim) {
    throw new Error(
      `Expected runtime claim ${input.expectedClaim.claim_id} visible in current context for run id ${input.runId}. Observed: ${summarizeClaims(response.data.claims)}`
    );
  }
  expect(claim).toMatchObject({
    principal: input.expectedClaim.principal,
    repo_id: input.expectedClaim.repo_id,
    branch: input.expectedClaim.branch,
    path: input.expectedClaim.path,
    mode: 'on_commit',
    status: 'active',
    sprint_id: input.expectedSprintId,
    context: input.expectedSprintId === null ? 'space' : 'sprint'
  });
}

async function assertClaimContextStableAfterSprintSwitch(input: {
  entry: CredentialEntry;
  expectedClaim: RuntimeClaim;
  newSprint: SprintSummary;
  runId: string;
}): Promise<void> {
  const current = await callLiveRuntimeTool<SprintCurrentData>(
    input.entry,
    'teamem.get_current_sprint',
    {}
  );
  expect(current.data.context.mode).toBe('sprint');
  expect(current.data.sprint?.sprint_id).toBe(input.newSprint.sprint_id);
  const stableClaim = await waitForRuntimeClaim({
    entry: input.entry,
    repoId: input.expectedClaim.repo_id,
    targetPath: input.expectedClaim.path,
    expectedPrincipal: input.expectedClaim.principal,
    expectedSprintId: input.expectedClaim.sprint_id,
    expectedContext: 'sprint',
    runId: input.runId,
    view: 'outside_current_context'
  });
  expect(stableClaim.claim_id).toBe(input.expectedClaim.claim_id);
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

async function assertLowPriorityCrossContextAwareness(input: {
  entry: CredentialEntry;
  currentClaim: RuntimeClaim;
  outsideClaims: readonly RuntimeClaim[];
  targetPath: string;
  runId: string;
}): Promise<RuntimeBriefing> {
  const response = await callLiveRuntimeTool<RuntimeBriefing>(
    input.entry,
    'teamem.get_briefing',
    {}
  );
  const briefing = response.data;
  expect(briefing.current_context.mode).toBe('sprint');
  expect(
    briefing.active_claims.some(
      (claim) =>
        claim.principal === input.currentClaim.principal &&
        claimContainsPath(claim, input.targetPath)
    )
  ).toBe(true);
  for (const outsideClaim of input.outsideClaims) {
    expect(
      briefing.outside_current_context.active_claims.some(
        (claim) =>
          claim.principal === outsideClaim.principal &&
          claimContainsPath(claim, input.targetPath)
      ),
      `Expected low-priority outside-context claim ${outsideClaim.claim_id} for run id ${input.runId}`
    ).toBe(true);
  }
  expect(
    briefing.meta.cross_context_overlap_awareness?.overlapping_claims ?? 0
  ).toBeGreaterThanOrEqual(input.outsideClaims.length);
  const currentClaim = briefing.active_claims.find(
    (claim) =>
      claim.principal === input.currentClaim.principal &&
      claimContainsPath(claim, input.targetPath)
  );
  expect(currentClaim?.blocking_principals ?? []).toEqual([]);
  return briefing;
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

async function assertNoDenyHookAfter(input: {
  session: InteractiveSession;
  targetPath: string;
  afterCount: number;
  runId: string;
  label: string;
}): Promise<void> {
  const deadline = Date.now() + FILE_POLL_TIMEOUT_MS;
  let traces: HookTrace[] = [];
  while (Date.now() < deadline) {
    traces = await readHookTracesIfStable(input.session.artifacts.hookTraceDir);
    if (
      traces
        .slice(input.afterCount)
        .some((trace) => isEditTraceForTarget(trace, input.targetPath))
    ) {
      break;
    }
    await delay(250);
  }
  const editTraces = traces
    .slice(input.afterCount)
    .filter((trace) => isEditTraceForTarget(trace, input.targetPath));
  if (editTraces.length === 0) {
    throw new Error(
      `Expected ${input.label} edit-like hook evidence for ${input.targetPath} for run id ${input.runId}. Observed: ${summarizeHookTraces(traces)}. Artifacts: ${input.session.artifacts.dir}`
    );
  }
  expect(
    editTraces.some((trace) =>
      trace.stdout.includes('"permissionDecision":"deny"')
    ),
    `${input.label} should not produce a hard conflict for run id ${input.runId}`
  ).toBe(false);
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

async function readHookTracesIfStable(traceDir: string): Promise<HookTrace[]> {
  try {
    return await readHookTraces(traceDir);
  } catch {
    await delay(100);
    return readHookTraces(traceDir);
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

async function writeSprintClaimConflictEvidence(input: {
  plan: MultiProfileRunPlan;
  workspace: DemoRepositoryWorkspace;
  runId: string;
  targetPath: string;
  sprints: {
    sprintA: SprintSummary;
    sprintB: SprintSummary;
    sprintC: SprintSummary;
  };
  prompts: {
    alice: string;
    bobDenied: string;
    bobCrossSprint: string;
    carol: string;
  };
  claims: {
    alice: RuntimeClaim;
    bob: RuntimeClaim;
    carol: RuntimeClaim;
  };
  bobDenyHook: HookTrace;
  bobBriefing: RuntimeBriefing;
  personas: {
    alice: PersonaSession;
    bob: PersonaSession;
    carol: PersonaSession;
  };
}): Promise<void> {
  await writeFile(
    join(input.plan.artifactsDir, `sprint-claim-conflict-${input.runId}.json`),
    `${JSON.stringify(
      {
        runId: input.runId,
        artifactsDir: input.plan.artifactsDir,
        workspace: input.workspace.demoWorkspaceLaunchCwd,
        targetPath: input.targetPath,
        sprints: input.sprints,
        prompts: input.prompts,
        claims: input.claims,
        bobDenyHook: {
          event: input.bobDenyHook.event,
          exitCode: input.bobDenyHook.exitCode,
          stdout: input.bobDenyHook.stdout,
          stderr: input.bobDenyHook.stderr,
          artifacts: input.bobDenyHook.artifacts
        },
        bobBriefing: input.bobBriefing,
        personas: {
          alice: personaEvidence(input.personas.alice),
          bob: personaEvidence(input.personas.bob),
          carol: personaEvidence(input.personas.carol)
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
    const latest = await callLiveRuntimeTool<SprintListData>(
      item.entry,
      'teamem.list_sprints',
      {}
    );
    const sprint = latest.data.sprints.find(
      (candidate) => candidate.sprint_id === item.sprint.sprint_id
    );
    if (sprint?.status === 'active') {
      const archived = await callLiveRuntimeTool<SprintArchiveData>(
        item.entry,
        'teamem.archive_sprint',
        { sprint: item.sprint.slug }
      );
      expect(archived.data.sprint.status).toBe('archived');
    }
  }
}

function sprintClaimConflictPersonas(): readonly MultiProfilePersona[] {
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

async function readOptionalFile(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return '';
  }
}

function formatGateReason(): string {
  return `set TEAMEM_CLAUDE_PLUGIN_E2E=1, TEAMEM_CLAUDE_PLUGIN_INTERACTIVE_E2E=1, TEAMEM_CLAUDE_PLUGIN_STATEFUL_E2E=1, ${TEAMEM_MULTI_PROFILE_E2E_ENV}=1, and CLAUDE_PLUGIN_E2E_ALLOW_UNREDACTED=1 to run L5 Sprint claim-conflict Claude plugin smoke`;
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
