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

type RuntimeReleaseScope = {
  released: boolean;
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
const liveMultiProfileScopeClaimsGateEnabled =
  liveGateEnabled &&
  interactiveGateEnabled &&
  statefulGateEnabled &&
  multiProfileGateEnabled &&
  unredactedTraceGateEnabled;
const describeLiveMultiProfileScopeClaims =
  liveMultiProfileScopeClaimsGateEnabled ? describe : describe.skip;
const interactivePermissionMode = liveMultiProfileScopeClaimsGateEnabled
  ? resolveTeamemInteractivePermissionMode(
      process.env,
      DEFAULT_TEAMEM_INTERACTIVE_SCRIPT_PERMISSION_MODE
    )
  : DEFAULT_TEAMEM_INTERACTIVE_PERMISSION_MODE;

const repoRoot = process.cwd();
const teamemPluginDir = join(repoRoot, 'plugin');
const LIVE_MULTI_PROFILE_SCOPE_CLAIMS_TIMEOUT_MS = 360_000;
const INTERACTIVE_READINESS_TIMEOUT_MS = 30_000;
const INTERACTIVE_WAIT_TIMEOUT_MS = 90_000;
const INTERACTIVE_CLOSE_TIMEOUT_MS = 10_000;
const INTERACTIVE_STARTUP_SETTLE_MS = 2_000;
const INTERACTIVE_TYPE_DELAY_MS = 20;
const LIVE_RUNTIME_POLL_TIMEOUT_MS = 45_000;
const FILE_POLL_TIMEOUT_MS = 60_000;
const TARGET_PATH = 'src/features/collaboration-board.ts';
const pluginScopedToolPrefix = 'mcp__plugin_teamem_teamem__teamem_';
const canonicalTeamemToolPrefix = 'mcp__teamem__teamem_';

describeLiveMultiProfileScopeClaims(
  `Teamem L5 multi-profile Scope claims smoke${liveMultiProfileScopeClaimsGateEnabled ? '' : ` (${formatGateReason()})`}`,
  () => {
    it(
      'proves Alice auto-claims a copied demo file and Bob is denied overlapping Space-mode work by hook evidence',
      async () => {
        let workspace: DemoRepositoryWorkspace | undefined;
        let plan: MultiProfileRunPlan | undefined;
        const sessions: InteractiveSession[] = [];
        let aliceClaim: RuntimeClaim | undefined;
        let releaseSucceeded = false;
        let success = false;

        try {
          workspace = await createDemoRepositoryWorkspace({
            teamemSourceRoot: repoRoot
          });
          const runId = createScopeClaimsRunId();
          const aliceMarker = `// teamem-l5-overlap-fixture-a: ${runId}`;
          const bobMarker = `// teamem-l5-overlap-fixture-b: ${runId}`;
          const sourceFixtureBefore = await readFile(
            join(
              repoRoot,
              'tests/fixtures/demo-repository-template',
              TARGET_PATH
            ),
            'utf8'
          );

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

          const aliceSession = await aliceTester.launchInteractive({
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
          sessions.push(aliceSession);
          await acceptClaudeStartupPromptsIfPresent(
            aliceSession,
            INTERACTIVE_READINESS_TIMEOUT_MS
          );
          assertInteractiveLaunchParity({
            personaPlan: alicePlan,
            boot: aliceBoot,
            session: aliceSession,
            launchCwd: workspace.demoWorkspaceLaunchCwd
          });

          const alicePrompt = [
            `Edit ${TARGET_PATH}.`,
            `Add this exact line immediately above "export const demoBoard": ${aliceMarker}`,
            'Use the Edit tool for the change.',
            'Do not modify any other file. After the edit, stop.'
          ].join(' ');
          await delay(INTERACTIVE_STARTUP_SETTLE_MS);
          await aliceSession.submit(alicePrompt, {
            delayMs: INTERACTIVE_TYPE_DELAY_MS
          });

          const expectedRepoId = await realpath(
            workspace.demoWorkspaceLaunchCwd
          );
          aliceClaim = await waitForRuntimeClaim({
            entry: aliceRuntime.entry,
            repoId: expectedRepoId,
            targetPath: TARGET_PATH,
            expectedPrincipal: aliceRuntime.whoami.principal,
            runId
          });
          await waitForCopiedWorkspaceMarker({
            workspaceRoot: workspace.demoWorkspaceLaunchCwd,
            marker: aliceMarker,
            runId
          });
          assertLiveInteractiveInputEvidence(
            aliceSession,
            alicePrompt,
            aliceMarker
          );
          await aliceSession.close();
          const aliceHookTraces = await readHookTraces(
            aliceSession.artifacts.hookTraceDir
          );
          const aliceMcpTraces = await readMcpTraces(
            aliceSession.artifacts.mcpTraceDir
          );
          assertPreToolUseClaimHookAllowEvidence({
            traces: aliceHookTraces,
            artifactsDir: aliceSession.artifacts.dir,
            targetPath: TARGET_PATH
          });
          assertNoTeamemChannelMcpTrace(aliceMcpTraces);

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
          await assertRuntimeSpaceClaimVisible({
            entry: bobRuntime.entry,
            expectedClaim: aliceClaim,
            runId
          });

          const bobSession = await bobTester.launchInteractive({
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
          sessions.push(bobSession);
          await acceptClaudeStartupPromptsIfPresent(
            bobSession,
            INTERACTIVE_READINESS_TIMEOUT_MS
          );
          assertInteractiveLaunchParity({
            personaPlan: bobPlan,
            boot: bobBoot,
            session: bobSession,
            launchCwd: workspace.demoWorkspaceLaunchCwd
          });

          const bobPrompt = [
            `Attempt to edit ${TARGET_PATH}.`,
            `Add this exact line immediately above "export const demoBoard": ${bobMarker}`,
            'Use the Edit tool for the change before reading, searching, or summarizing the file.',
            'Existing fixture markers in the file are not coordination evidence.',
            'The only valid outcome is to attempt the edit and let the Teamem hook allow or deny it.',
            'If the Teamem hook denies the edit because another teammate holds the scope claim, stop immediately.'
          ].join(' ');
          await delay(INTERACTIVE_STARTUP_SETTLE_MS);
          await bobSession.submit(bobPrompt, {
            delayMs: INTERACTIVE_TYPE_DELAY_MS
          });
          const bobDenyHook = await waitForClaimConflictHookEvidence({
            session: bobSession,
            targetPath: TARGET_PATH,
            incumbentClaim: aliceClaim,
            incumbentPrincipal: aliceRuntime.whoami.principal,
            runId
          });
          await assertCopiedWorkspaceDoesNotContainMarker({
            workspaceRoot: workspace.demoWorkspaceLaunchCwd,
            marker: bobMarker,
            runId
          });
          assertLiveInteractiveInputEvidence(bobSession, bobPrompt, bobMarker);
          await bobSession.close();
          await assertCopiedWorkspaceDoesNotContainMarker({
            workspaceRoot: workspace.demoWorkspaceLaunchCwd,
            marker: bobMarker,
            runId
          });
          const bobMcpTraces = await readMcpTraces(
            bobSession.artifacts.mcpTraceDir
          );
          assertNoTeamemChannelMcpTrace(bobMcpTraces);
          await assertRuntimeSpaceClaimVisible({
            entry: bobRuntime.entry,
            expectedClaim: aliceClaim,
            runId
          });

          await writeScopeClaimArtifacts({
            plan,
            alicePlan,
            bobPlan,
            aliceSession,
            bobSession,
            runId,
            alicePrompt,
            bobPrompt,
            aliceMarker,
            bobMarker,
            targetPath: TARGET_PATH,
            aliceWhoami: aliceRuntime.whoami,
            bobWhoami: bobRuntime.whoami,
            aliceClaim,
            bobDenyHook
          });
          await assertPersonaArtifacts(aliceSession, aliceEnv);
          await assertPersonaArtifacts(bobSession, bobEnv);
          await assertSourceFixtureUnchanged(sourceFixtureBefore);

          await releaseRuntimeClaim(aliceRuntime.entry, aliceClaim.claim_id);
          releaseSucceeded = true;
          await waitForRuntimeClaimRelease({
            entry: aliceRuntime.entry,
            claimId: aliceClaim.claim_id,
            runId
          });

          success = true;
        } finally {
          for (const session of sessions) {
            try {
              await session.close();
            } catch {
              // Preserve the original failure and artifact paths.
            }
          }
          if (aliceClaim && !releaseSucceeded && plan) {
            const alicePlan = plan.personaPlans.find(
              (candidate) => candidate.persona === 'alice'
            );
            if (alicePlan) {
              try {
                const aliceRuntime = await inspectProfileRuntime(
                  alicePlan.profile.credentialsPath
                );
                await releaseRuntimeClaim(
                  aliceRuntime.entry,
                  aliceClaim.claim_id
                );
              } catch (err) {
                console.error(
                  `Failed to release multi-profile scope claim ${aliceClaim.claim_id}: ${formatError(err)}`
                );
              }
            }
          }
          if (plan) {
            const cleanup = await finishMultiProfileRun(plan, { success });
            if (cleanup.preserved) {
              console.error(
                `Preserving failed multi-profile Scope claims smoke artifacts at ${cleanup.artifactsDir}`
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
                `Preserving failed multi-profile Scope claims demo workspace at ${cleanup.demoWorkspaceLaunchCwd}${cleanup.artifactPath ? ` (report ${cleanup.artifactPath})` : ''}`
              );
            }
          }
        }
      },
      LIVE_MULTI_PROFILE_SCOPE_CLAIMS_TIMEOUT_MS
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

async function waitForRuntimeClaim(input: {
  entry: CredentialEntry;
  repoId: string;
  targetPath: string;
  expectedPrincipal: string;
  runId: string;
}): Promise<RuntimeClaim> {
  const deadline = Date.now() + LIVE_RUNTIME_POLL_TIMEOUT_MS;
  let lastSummary = 'no runtime claims observed';

  while (Date.now() < deadline) {
    const response = await callLiveRuntimeTool<RuntimeClaims>(
      input.entry,
      'teamem.list_claims',
      { scope: 'self', view: 'space' }
    );
    const claim = response.data.claims.find((item) =>
      matchesTargetClaim(item, input)
    );
    if (claim) {
      expect(claim.principal).toBe(input.expectedPrincipal);
      expect(claim.sprint_id).toBeNull();
      expect(claim.context).toBe('space');
      return claim;
    }

    lastSummary = summarizeClaims(response.data.claims);
    await delay(500);
  }

  throw new Error(
    `Timed out waiting for Alice runtime claim on ${input.targetPath} for run id ${input.runId}. Last claims summary: ${lastSummary}`
  );
}

async function assertRuntimeSpaceClaimVisible(input: {
  entry: CredentialEntry;
  expectedClaim: RuntimeClaim;
  runId: string;
}): Promise<void> {
  const response = await callLiveRuntimeTool<RuntimeClaims>(
    input.entry,
    'teamem.list_claims',
    { scope: 'space', view: 'space' }
  );
  const claim = response.data.claims.find(
    (candidate) => candidate.claim_id === input.expectedClaim.claim_id
  );
  if (!claim) {
    throw new Error(
      `Expected runtime Space claim ${input.expectedClaim.claim_id} to be visible for run id ${input.runId}. Observed: ${summarizeClaims(response.data.claims)}`
    );
  }
  expect(claim).toMatchObject({
    principal: input.expectedClaim.principal,
    repo_id: input.expectedClaim.repo_id,
    branch: input.expectedClaim.branch,
    path: input.expectedClaim.path,
    mode: 'on_commit',
    status: 'active',
    sprint_id: null,
    context: 'space'
  });
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

async function assertCopiedWorkspaceDoesNotContainMarker(input: {
  workspaceRoot: string;
  marker: string;
  runId: string;
}): Promise<void> {
  const content = await readFile(
    join(input.workspaceRoot, TARGET_PATH),
    'utf8'
  );
  expect(content).not.toContain(input.marker);
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
      `Expected Alice PreToolUse hook allow evidence for ${input.targetPath}. Observed hooks: ${summarizeHookTraces(input.traces)}. Artifacts: ${input.artifactsDir}`
    );
  }
}

async function waitForClaimConflictHookEvidence(input: {
  session: InteractiveSession;
  targetPath: string;
  incumbentClaim: RuntimeClaim;
  incumbentPrincipal: string;
  runId: string;
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
    const denyTrace = traces.find((trace) => {
      if (trace.event !== 'PreToolUse' || trace.exitCode !== 0) {
        return false;
      }
      if (!isEditTraceForTarget(trace, input.targetPath)) {
        return false;
      }
      return (
        trace.stdout.includes('"permissionDecision":"deny"') &&
        trace.stdout.includes(input.incumbentClaim.claim_id) &&
        trace.stdout.includes(input.incumbentPrincipal)
      );
    });
    if (denyTrace) {
      return denyTrace;
    }

    lastSummary = summarizeHookTraces(traces);
    await delay(250);
  }

  throw new Error(
    `Timed out waiting for Bob PreToolUse denial on ${input.targetPath} for run id ${input.runId}. Last hook summary: ${lastSummary}.${lastReadError ? ` Last hook read error: ${lastReadError}.` : ''} Artifacts: ${input.session.artifacts.dir}`
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

async function writeScopeClaimArtifacts(input: {
  plan: MultiProfileRunPlan;
  alicePlan: MultiProfilePersonaPlan;
  bobPlan: MultiProfilePersonaPlan;
  aliceSession: InteractiveSession;
  bobSession: InteractiveSession;
  runId: string;
  alicePrompt: string;
  bobPrompt: string;
  aliceMarker: string;
  bobMarker: string;
  targetPath: string;
  aliceWhoami: RuntimeWhoamiEvidence;
  bobWhoami: RuntimeWhoamiEvidence;
  aliceClaim: RuntimeClaim;
  bobDenyHook: HookTrace;
}): Promise<void> {
  await writeFile(
    join(
      input.alicePlan.runtimeEvidenceDir,
      `${input.alicePlan.persona}-scope-claim-${input.runId}.json`
    ),
    `${JSON.stringify(
      {
        runId: input.runId,
        persona: input.alicePlan.persona,
        profileName: input.alicePlan.profile.profileName,
        profileCredentialsPath: input.alicePlan.profile.credentialsPath,
        targetPath: input.targetPath,
        prompt: input.alicePrompt,
        marker: input.aliceMarker,
        whoami: input.aliceWhoami,
        claim: input.aliceClaim,
        artifactRunDir: input.aliceSession.artifacts.dir,
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
      `${input.bobPlan.persona}-scope-claim-denial-${input.runId}.json`
    ),
    `${JSON.stringify(
      {
        runId: input.runId,
        persona: input.bobPlan.persona,
        profileName: input.bobPlan.profile.profileName,
        profileCredentialsPath: input.bobPlan.profile.credentialsPath,
        targetPath: input.targetPath,
        prompt: input.bobPrompt,
        marker: input.bobMarker,
        whoami: input.bobWhoami,
        incumbentClaim: input.aliceClaim,
        denyHook: {
          event: input.bobDenyHook.event,
          exitCode: input.bobDenyHook.exitCode,
          stdout: input.bobDenyHook.stdout,
          stderr: input.bobDenyHook.stderr,
          artifacts: input.bobDenyHook.artifacts
        },
        artifactRunDir: input.bobSession.artifacts.dir,
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
    join(input.plan.artifactsDir, `scope-claims-run-${input.runId}.json`),
    `${JSON.stringify(
      {
        runId: input.runId,
        artifactsDir: input.plan.artifactsDir,
        demoWorkspaceLaunchCwd: input.plan.demoWorkspaceLaunchCwd,
        targetPath: input.targetPath,
        claimId: input.aliceClaim.claim_id,
        aliceArtifactDir: input.alicePlan.artifactDir,
        bobArtifactDir: input.bobPlan.artifactDir
      },
      null,
      2
    )}\n`
  );
}

async function assertPersonaArtifacts(
  session: InteractiveSession,
  profileEnv: NodeJS.ProcessEnv
): Promise<void> {
  await expect(stat(session.artifacts.summaryPath)).resolves.toBeTruthy();
  await expect(stat(session.artifacts.environmentPath)).resolves.toBeTruthy();
  await expect(stat(session.artifacts.rawTranscriptPath)).resolves.toBeTruthy();
  await expect(
    stat(session.artifacts.normalizedTranscriptPath)
  ).resolves.toBeTruthy();
  const environment = JSON.parse(
    await readFile(session.artifacts.environmentPath, 'utf8')
  ) as { env?: Record<string, string> };
  const summary = JSON.parse(
    await readFile(session.artifacts.summaryPath, 'utf8')
  ) as {
    kind?: string;
    exitStatus?: {
      errorCode?: string;
    };
  };
  expect(summary.kind).toBe('interactive');
  expect(summary.exitStatus?.errorCode).toBeUndefined();
  expect(environment.env ?? {}).toMatchObject({
    CLAUDE_PLUGIN_DATA: profileEnv.CLAUDE_PLUGIN_DATA,
    CLAUDE_PLUGIN_ROOT: profileEnv.CLAUDE_PLUGIN_ROOT
  });
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

function formatGateReason(): string {
  return `set TEAMEM_CLAUDE_PLUGIN_E2E=1, TEAMEM_CLAUDE_PLUGIN_INTERACTIVE_E2E=1, TEAMEM_CLAUDE_PLUGIN_STATEFUL_E2E=1, ${TEAMEM_MULTI_PROFILE_E2E_ENV}=1, and CLAUDE_PLUGIN_E2E_ALLOW_UNREDACTED=1 to run L5 multi-profile Scope claims Claude plugin smoke`;
}

function createScopeClaimsRunId(): string {
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
