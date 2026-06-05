import { describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createClaudePluginTester,
  readHookTraces,
  readMcpTraces,
  type BootResult,
  type HookTrace,
  type InteractiveSession,
  type McpTrace
} from '../../plugin-e2e-module/src/index.js';
import {
  loadCredentials,
  pickEntry,
  type CredentialEntry
} from '../../src/bridge/credentials.js';
import {
  callLiveRuntimeTool,
  inspectRuntimePrerequisite,
  TEAMEM_MCP_ENV_PASSTHROUGH_KEYS,
  withLiveInteractiveSmokeLock,
  type RuntimeWhoamiEvidence
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
  assertTeamemChannelsLaunchParity,
  assertTeamemChannelsLivePrerequisites,
  assertTeamemChannelsPrincipals,
  evaluateTeamemChannelsGate,
  finishTeamemChannelsSplitCase,
  inspectTeamemChannelsProfileRuntime,
  planTeamemChannelsSplitCase,
  runTeamemChannelsRecipientReadinessSequence,
  type TeamemChannelsPersona,
  type TeamemChannelsPersonaLaunchPlan,
  type TeamemChannelsProfileRuntime,
  type TeamemChannelsSplitCasePlan
} from './teamem-channels-session-planner.js';
import {
  assertTeamemNoChannelEvidenceForMarker,
  createTeamemChannelsTranscriptCheckpoint,
  type TeamemChannelsNegativeMarkerExpectation,
  type TeamemChannelsTranscriptCheckpoint
} from './teamem-channels-evidence.js';

type RuntimeClaim = {
  claim_id: string;
  principal: string;
  repo_id: string;
  branch: string;
  path: string;
  mode: string;
  status: string;
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
  active_claims?: Array<{
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
};

type PersonaRuntime = TeamemChannelsProfileRuntime & {
  readonly entry: CredentialEntry;
  readonly sessionId: string;
  readonly channelSessionId: string;
};

type PersonaSession = {
  readonly personaPlan: TeamemChannelsPersonaLaunchPlan;
  readonly runtime: PersonaRuntime;
  readonly boot: BootResult;
  readonly session: InteractiveSession;
  readonly notificationLogPath: string;
  readonly channelLogPath: string;
  readonly channelLogLineOffset: number;
};

type EvidenceSnapshot = {
  readonly tracePath: string;
  readonly notificationLogPath: string;
  readonly rawTranscriptPath: string;
  readonly normalizedTranscriptPath: string;
  readonly traces: readonly McpTrace[];
  readonly notificationLog: string;
  readonly rawTranscript: string;
  readonly normalizedTranscript: string;
};

const gate = evaluateTeamemChannelsGate(process.env);
const describeLiveChannelsClaimConflict = gate.enabled
  ? describe
  : describe.skip;
const repoRoot = process.cwd();
const teamemPluginDir = join(repoRoot, 'plugin');

const LIVE_CHANNELS_CLAIM_CONFLICT_TIMEOUT_MS = 420_000;
const INTERACTIVE_READINESS_TIMEOUT_MS = 30_000;
const INTERACTIVE_WAIT_TIMEOUT_MS = 90_000;
const INTERACTIVE_CLOSE_TIMEOUT_MS = 10_000;
const INTERACTIVE_TYPE_DELAY_MS = 20;
const INTERACTIVE_STARTUP_SETTLE_MS = 2_000;
const CHANNEL_READINESS_TIMEOUT_MS = 45_000;
const CHANNEL_NEGATIVE_WINDOW_MS = 10_000;
const CHANNEL_ASSERTION_POLL_MS = 500;
const LIVE_RUNTIME_POLL_TIMEOUT_MS = 45_000;
const FILE_POLL_TIMEOUT_MS = 60_000;
const CASE_NAME = 'claim-conflict';
const QUIET_EVENT_TYPES = [
  'scope_claimed',
  'conflict_queued',
  'permission_requested'
] as const;

describeLiveChannelsClaimConflict(
  `Teamem L5 Channels quiet file-claim conflict smoke${gate.enabled ? '' : ` (${gate.reason})`}`,
  () => {
    it(
      'keeps normal Space-mode file claim conflicts queue-first and Channel-quiet',
      async () => {
        await withLiveInteractiveSmokeLock(
          'teamem-channels-claim-conflict',
          runChannelsClaimConflictCase
        );
      },
      LIVE_CHANNELS_CLAIM_CONFLICT_TIMEOUT_MS
    );
  }
);

async function runChannelsClaimConflictCase(): Promise<void> {
  let workspace: DemoRepositoryWorkspace | undefined;
  let plan: TeamemChannelsSplitCasePlan | undefined;
  const sessions: InteractiveSession[] = [];
  let aliceClaim: RuntimeClaim | undefined;
  let releaseSucceeded = false;
  let success = false;
  let failure: unknown;

  try {
    const runtimePrerequisite = await inspectRuntimePrerequisite({
      liveGateEnabled: gate.enabled,
      gateReason: gate.reason
    });
    await assertTeamemChannelsLivePrerequisites({
      gate,
      runtimePrerequisite,
      personas: [
        profilePersona('alice'),
        profilePersona('bob'),
        profilePersona('carol')
      ]
    });

    workspace = await createDemoRepositoryWorkspace({
      teamemSourceRoot: repoRoot
    });
    const runId = createRunId();
    plan = await planTeamemChannelsSplitCase({
      runId,
      splitCase: 'direct',
      teamemRoot: repoRoot,
      workspace,
      artifactsParentDir: tmpdir()
    });
    const marker = `teamem-channels-${CASE_NAME}-${plan.runId}`;
    const targetPath = `src/features/${marker}.ts`;
    const aliceMarker = `// alice ${marker}`;
    const bobMarker = `// bob ${marker}`;
    const quietExpectation: TeamemChannelsNegativeMarkerExpectation = {
      runId: plan.runId,
      caseName: CASE_NAME,
      marker,
      eventTypes: QUIET_EVENT_TYPES
    };

    const bobPlan = requirePersonaPlan(plan, 'bob');
    const carolPlan = requirePersonaPlan(plan, 'carol');
    const alicePlan = requirePersonaPlan(plan, 'alice');
    const runtimes = await Promise.all(
      [alicePlan, bobPlan, carolPlan].map((personaPlan) =>
        inspectRuntime(personaPlan, plan!)
      )
    );
    assertTeamemChannelsPrincipals(runtimes);
    const aliceRuntime = requireRuntime(runtimes, 'alice');
    const bobRuntime = requireRuntime(runtimes, 'bob');
    const carolRuntime = requireRuntime(runtimes, 'carol');
    const launched = new Map<TeamemChannelsPersona, PersonaSession>();

    await runTeamemChannelsRecipientReadinessSequence({
      plan,
      runner: async ({ persona, phase }) => {
        if (phase === 'launch') {
          const runtime = requireRuntime(runtimes, persona.persona);
          const launchedPersona = await launchPersona({
            personaPlan: persona,
            runtime,
            workspace: workspace!
          });
          launched.set(persona.persona, launchedPersona);
          sessions.push(launchedPersona.session);
          return;
        }

        const launchedPersona = requireLaunched(launched, persona.persona);
        await waitForChannelReadiness({ launchedPersona, phase });
      }
    });

    const alice = requireLaunched(launched, 'alice');
    const bob = requireLaunched(launched, 'bob');
    const carol = requireLaunched(launched, 'carol');
    await waitForChannelReadiness({
      launchedPersona: alice,
      phase: 'channel-ready'
    });
    await waitForChannelReadiness({
      launchedPersona: alice,
      phase: 'cursor-primed'
    });

    const preConflictCheckpoints = {
      alice: await createCheckpoint(alice),
      bob: await createCheckpoint(bob),
      carol: await createCheckpoint(carol)
    };
    const alicePrompt = [
      `Write ${targetPath}.`,
      `Create the file with exactly these two lines: ${aliceMarker} and export const quietClaimConflictMarker = ${JSON.stringify(marker)};`,
      'Use the Write tool for the change.',
      'Do not use Teamem MCP tools. After the edit, stop.'
    ].join(' ');
    await delay(INTERACTIVE_STARTUP_SETTLE_MS);
    await alice.session.submit(alicePrompt, {
      delayMs: INTERACTIVE_TYPE_DELAY_MS
    });

    const expectedRepoId = await realpath(workspace.demoWorkspaceLaunchCwd);
    aliceClaim = await waitForRuntimeClaim({
      entry: aliceRuntime.entry,
      repoId: expectedRepoId,
      targetPath,
      expectedPrincipal: aliceRuntime.whoami.principal,
      runId
    });
    await waitForCopiedWorkspaceMarker({
      workspaceRoot: workspace.demoWorkspaceLaunchCwd,
      targetPath,
      marker: aliceMarker,
      runId
    });
    assertLiveInteractiveInputEvidence(alice.session, alicePrompt, marker);

    await assertQuietForAllPersonas({
      launched,
      expected: quietExpectation,
      checkpoints: preConflictCheckpoints,
      allowedTranscriptMarkerEchoes: { alice: [alicePrompt] }
    });

    await assertRuntimeSpaceClaimVisible({
      entry: bobRuntime.entry,
      expectedClaim: aliceClaim,
      runId
    });

    const bobPrompt = [
      `Attempt to edit ${targetPath}.`,
      `Replace the line ${JSON.stringify(aliceMarker)} with ${JSON.stringify(bobMarker)}.`,
      'Use Edit, Write, or MultiEdit for the change before reading, searching, or summarizing the file.',
      'Do not use Teamem MCP tools and do not call teamem.request_edit_permission.',
      'If the Teamem hook denies the edit because another teammate holds the scope claim, stop immediately.'
    ].join(' ');
    await bob.session.submit(bobPrompt, {
      delayMs: INTERACTIVE_TYPE_DELAY_MS
    });
    const bobDenyEvidence = await waitForClaimConflictDenialEvidence({
      session: bob.session,
      targetPath,
      incumbentClaim: aliceClaim,
      incumbentPrincipal: aliceRuntime.whoami.principal,
      runId
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
      marker: bobMarker,
      runId
    });
    assertNoPermissionRequestRegression({
      traces: await readMcpTraces(bob.session.artifacts.mcpTraceDir, {
        ignoreTransientErrors: true
      }),
      hookTraces: await readHookTraces(bob.session.artifacts.hookTraceDir),
      artifactsDir: bob.session.artifacts.dir,
      runId
    });
    assertLiveInteractiveInputEvidence(bob.session, bobPrompt, marker);

    await assertQuietForAllPersonas({
      launched,
      expected: quietExpectation,
      checkpoints: preConflictCheckpoints,
      allowedTranscriptMarkerEchoes: {
        alice: [alicePrompt],
        bob: [bobPrompt]
      }
    });

    await writeCaseEvidence({
      plan,
      alice,
      bob,
      carol,
      aliceRuntime,
      bobRuntime,
      carolRuntime,
      runId,
      marker,
      targetPath,
      alicePrompt,
      bobPrompt,
      aliceClaim,
      bobDenyEvidence
    });
    await Promise.all([
      alice.session.close(),
      bob.session.close(),
      carol.session.close()
    ]);
    await Promise.all([
      assertPersonaArtifacts(alice),
      assertPersonaArtifacts(bob),
      assertPersonaArtifacts(carol)
    ]);

    await releaseRuntimeClaim(aliceRuntime.entry, aliceClaim.claim_id);
    releaseSucceeded = true;
    await waitForRuntimeClaimRelease({
      entry: aliceRuntime.entry,
      claimId: aliceClaim.claim_id,
      runId
    });
    success = true;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    for (const session of sessions) {
      try {
        await session.close();
      } catch {
        // Preserve the original failure and artifact paths.
      }
    }
    if (aliceClaim && !releaseSucceeded && plan) {
      try {
        const alicePlan = requirePersonaPlan(plan, 'alice');
        const runtime = await inspectRuntime(alicePlan, plan);
        await releaseRuntimeClaim(runtime.entry, aliceClaim.claim_id);
      } catch (error) {
        console.error(
          `Failed to release Channels claim-conflict claim ${aliceClaim.claim_id}: ${formatError(error)}`
        );
      }
    }
    if (plan) {
      const cleanup = await finishTeamemChannelsSplitCase(plan, {
        success,
        error: failure,
        workspacePath: workspace?.demoWorkspaceLaunchCwd
      });
      if (cleanup.preserved) {
        console.error(
          `Preserving failed Channels claim-conflict smoke artifacts at ${cleanup.artifactsDir}${cleanup.failurePathsPath ? ` (failure paths ${cleanup.failurePathsPath})` : ''}`
        );
        if (cleanup.failureError) {
          console.error(cleanup.failureError.message);
        }
      }
    }
    if (workspace) {
      const cleanup = await finishDemoRepositoryWorkspace(workspace, {
        success,
        artifactsDir: plan?.multiProfilePlan.artifactsDir
      });
      if (cleanup.preserved) {
        console.error(
          `Preserving failed Channels claim-conflict demo workspace at ${cleanup.demoWorkspaceLaunchCwd}${cleanup.artifactPath ? ` (report ${cleanup.artifactPath})` : ''}`
        );
      }
    }
  }
}

function profilePersona(persona: TeamemChannelsPersona) {
  return {
    persona,
    profileName:
      persona === 'alice'
        ? (process.env.TEAMEM_ALICE_PROFILE ?? 'alice')
        : persona === 'bob'
          ? (process.env.TEAMEM_BOB_PROFILE ?? 'bob')
          : (process.env.TEAMEM_CAROL_PROFILE ?? 'carol'),
    ownership: 'developer' as const
  };
}

async function inspectRuntime(
  personaPlan: TeamemChannelsPersonaLaunchPlan,
  plan: TeamemChannelsSplitCasePlan
): Promise<PersonaRuntime> {
  const credentialsPath = requiredEnv(
    personaPlan.profileEnv,
    'TEAMEM_CREDENTIALS'
  );
  const loaded = await loadCredentials(credentialsPath);
  if (!loaded) {
    throw new Error(`Invalid credentials at ${credentialsPath}`);
  }
  const entry = pickEntry({ creds: loaded });
  const runtime = await inspectTeamemChannelsProfileRuntime({
    persona: personaPlan.persona,
    profileName: personaPlan.profileName,
    credentialsPath,
    whoami: async () =>
      (await callLiveRuntimeTool<RuntimeWhoamiEvidence>(entry, 'teamem.whoami'))
        .data
  });
  return {
    ...runtime,
    entry,
    sessionId: `${plan.runId}-${personaPlan.persona}`,
    channelSessionId: 'default'
  };
}

async function launchPersona(input: {
  readonly personaPlan: TeamemChannelsPersonaLaunchPlan;
  readonly runtime: PersonaRuntime;
  readonly workspace: DemoRepositoryWorkspace;
}): Promise<PersonaSession> {
  const activeChannelLogPath = channelLogPath(input.personaPlan.profileEnv);
  const channelLogLineOffset = countNonEmptyLines(
    await readOptionalFile(activeChannelLogPath)
  );
  await materializeLaunchWorkspaceMcpConfig({
    personaPlan: input.personaPlan,
    workspace: input.workspace
  });
  const tester = createClaudePluginTester({
    pluginDir: teamemPluginDir,
    claudeBin: input.personaPlan.claudeBin,
    cwd: input.workspace.demoWorkspaceLaunchCwd,
    artifactsDir: input.personaPlan.artifactDir,
    cleanup: 'never',
    mcp: {
      include: ['teamem', 'teamem-channel'],
      mode: 'disable-non-included',
      envPassthroughKeys: [
        ...TEAMEM_MCP_ENV_PASSTHROUGH_KEYS,
        'TEAMEM_CHANNEL_POLL_MS'
      ]
    },
    env: input.personaPlan.profileEnv,
    redaction: { mode: 'off' },
    timeouts: {
      interactiveReadinessMs: INTERACTIVE_READINESS_TIMEOUT_MS,
      interactiveWaitMs: INTERACTIVE_WAIT_TIMEOUT_MS,
      interactiveCloseMs: INTERACTIVE_CLOSE_TIMEOUT_MS
    }
  });
  const boot = await tester.boot();
  const session = await tester.launchInteractive({
    useSourcePluginDir: input.personaPlan.launchOptions.useSourcePluginDir,
    sessionName: input.personaPlan.launchOptions.sessionName,
    includePermissionMode:
      input.personaPlan.launchOptions.includePermissionMode,
    includeRunInstrumentationEnv:
      input.personaPlan.launchOptions.includeRunInstrumentationEnv,
    useInstrumentedMcpConfig:
      input.personaPlan.launchOptions.useInstrumentedMcpConfig,
    strictMcpConfig: input.personaPlan.launchOptions.strictMcpConfig,
    developmentChannels: [
      ...input.personaPlan.launchOptions.developmentChannels
    ],
    channels: [...input.personaPlan.launchOptions.channels],
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
    assertClaudeChannelsAvailable({
      persona: input.personaPlan.persona,
      transcript: session.rawTranscript(),
      rawTranscriptPath: session.artifacts.rawTranscriptPath,
      normalizedTranscriptPath: session.artifacts.normalizedTranscriptPath,
      runSummaryPath: session.artifacts.summaryPath,
      environmentPath: session.artifacts.environmentPath,
      launcherPlanPath: input.personaPlan.launcherPlanPath
    });
    assertTeamemChannelsLaunchParity({
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
    notificationLogPath: notificationLogPath(
      input.personaPlan.profileEnv,
      input.runtime.channelSessionId
    ),
    channelLogPath: activeChannelLogPath,
    channelLogLineOffset
  };
}

async function waitForChannelReadiness(input: {
  readonly launchedPersona: PersonaSession;
  readonly phase: 'channel-ready' | 'cursor-primed';
}): Promise<void> {
  const deadline = Date.now() + CHANNEL_READINESS_TIMEOUT_MS;
  const expectedStart = `start session=${input.launchedPersona.runtime.channelSessionId} principal=${input.launchedPersona.runtime.whoami.principal}`;
  while (Date.now() < deadline) {
    assertClaudeChannelsAvailable({
      persona: input.launchedPersona.personaPlan.persona,
      transcript: input.launchedPersona.session.rawTranscript(),
      rawTranscriptPath:
        input.launchedPersona.session.artifacts.rawTranscriptPath,
      normalizedTranscriptPath:
        input.launchedPersona.session.artifacts.normalizedTranscriptPath,
      runSummaryPath: input.launchedPersona.session.artifacts.summaryPath,
      environmentPath: input.launchedPersona.session.artifacts.environmentPath,
      launcherPlanPath: input.launchedPersona.personaPlan.launcherPlanPath
    });
    const log = sliceLogAfterLineOffset(
      await readOptionalFile(input.launchedPersona.channelLogPath),
      input.launchedPersona.channelLogLineOffset
    );
    if (hasChannelReadiness({ log, expectedStart, phase: input.phase })) {
      return;
    }
    await delay(CHANNEL_ASSERTION_POLL_MS);
  }

  throw new Error(
    `launch/readiness: timed out waiting for ${input.phase} for ${input.launchedPersona.personaPlan.persona} (run id=${input.launchedPersona.session.artifacts.runId}, channel log=${input.launchedPersona.channelLogPath})`
  );
}

async function createCheckpoint(
  launchedPersona: PersonaSession
): Promise<TeamemChannelsTranscriptCheckpoint> {
  const traces = await readMcpTraces(
    launchedPersona.session.artifacts.mcpTraceDir,
    { ignoreTransientErrors: true }
  );
  const notificationLog = await readOptionalFile(
    launchedPersona.notificationLogPath
  );
  return createTeamemChannelsTranscriptCheckpoint({
    rawTranscript: launchedPersona.session.rawTranscript(),
    normalizedTranscript: launchedPersona.session.normalizedTranscript(),
    capturedAt: new Date().toISOString(),
    traceOffsetMs: latestTraceOffsetMs(traces),
    notificationLineOffset: countNonEmptyLines(notificationLog)
  });
}

async function assertQuietForAllPersonas(input: {
  readonly launched: ReadonlyMap<TeamemChannelsPersona, PersonaSession>;
  readonly expected: TeamemChannelsNegativeMarkerExpectation;
  readonly checkpoints: Record<
    TeamemChannelsPersona,
    TeamemChannelsTranscriptCheckpoint
  >;
  readonly allowedTranscriptMarkerEchoes?: Partial<
    Record<TeamemChannelsPersona, readonly string[]>
  >;
}): Promise<void> {
  const deadline = Date.now() + CHANNEL_NEGATIVE_WINDOW_MS;
  while (Date.now() < deadline) {
    for (const persona of ['alice', 'bob', 'carol'] as const) {
      const launchedPersona = requireLaunched(input.launched, persona);
      const snapshot = await writeEvidenceSnapshot(launchedPersona);
      assertTeamemNoChannelEvidenceForMarker({
        persona,
        expected: input.expected,
        traces: snapshot.traces,
        notificationLog: snapshot.notificationLog,
        rawTranscript: snapshot.rawTranscript,
        normalizedTranscript: snapshot.normalizedTranscript,
        traceCheckpoint: { offsetMs: input.checkpoints[persona].traceOffsetMs },
        notificationCheckpoint: {
          lineOffset: input.checkpoints[persona].notificationLineOffset
        },
        transcriptCheckpoint: input.checkpoints[persona],
        allowedTranscriptMarkerEchoes:
          input.allowedTranscriptMarkerEchoes?.[persona],
        artifacts: {
          channelTracePath: snapshot.tracePath,
          notificationLogPath: snapshot.notificationLogPath,
          rawTranscriptPath: snapshot.rawTranscriptPath,
          normalizedTranscriptPath: snapshot.normalizedTranscriptPath
        }
      });
    }
    await delay(CHANNEL_ASSERTION_POLL_MS);
  }
}

async function writeEvidenceSnapshot(
  launchedPersona: PersonaSession
): Promise<EvidenceSnapshot> {
  const dir = join(launchedPersona.personaPlan.artifactDir, 'runtime-evidence');
  const prefix = `${launchedPersona.personaPlan.persona}-channels-claim-conflict-${launchedPersona.runtime.sessionId}`;
  const traces = await readMcpTraces(
    launchedPersona.session.artifacts.mcpTraceDir,
    { ignoreTransientErrors: true }
  );
  const notificationLog = await readOptionalFile(
    launchedPersona.notificationLogPath
  );
  const rawTranscript = launchedPersona.session.rawTranscript();
  const normalizedTranscript = launchedPersona.session.normalizedTranscript();
  const tracePath = join(dir, `${prefix}-channel-traces.json`);
  const notificationLogPath = join(dir, `${prefix}-notifications.log`);
  const rawTranscriptPath = join(dir, `${prefix}-transcript.raw`);
  const normalizedTranscriptPath = join(
    dir,
    `${prefix}-transcript.normalized.txt`
  );

  await mkdir(dir, { recursive: true });
  await Promise.all([
    writeFile(tracePath, `${JSON.stringify(traces, null, 2)}\n`),
    writeFile(notificationLogPath, notificationLog),
    writeFile(rawTranscriptPath, rawTranscript),
    writeFile(normalizedTranscriptPath, normalizedTranscript)
  ]);

  return {
    tracePath,
    notificationLogPath,
    rawTranscriptPath,
    normalizedTranscriptPath,
    traces,
    notificationLog,
    rawTranscript,
    normalizedTranscript
  };
}

async function waitForRuntimeClaim(input: {
  readonly entry: CredentialEntry;
  readonly repoId: string;
  readonly targetPath: string;
  readonly expectedPrincipal: string;
  readonly runId: string;
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
    `hook/queue failure: timed out waiting for Alice runtime claim on ${input.targetPath} for run id ${input.runId}. Last claims summary: ${lastSummary}`
  );
}

async function assertRuntimePendingEditQueued(input: {
  readonly entry: CredentialEntry;
  readonly claimId: string;
  readonly incumbentPrincipal: string;
  readonly bobPrincipal: string;
  readonly targetPath: string;
  readonly runId: string;
}): Promise<void> {
  const deadline = Date.now() + LIVE_RUNTIME_POLL_TIMEOUT_MS;
  let lastBriefing = 'no briefing observed';
  while (Date.now() < deadline) {
    const response = await callLiveRuntimeTool<RuntimeBriefing>(
      input.entry,
      'teamem.get_briefing',
      {}
    );
    const activeClaim = response.data.active_claims?.find(
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

    lastBriefing = JSON.stringify(response.data.active_claims ?? []);
    await delay(500);
  }

  throw new Error(
    `hook/queue failure: Bob denial did not create pending queued edit for claim ${input.claimId} on ${input.targetPath} for run id ${input.runId}. Last active_claims: ${lastBriefing}`
  );
}

function claimContainsPath(
  claim: NonNullable<RuntimeBriefing['active_claims']>[number],
  targetPath: string
): boolean {
  if (claim.path === targetPath) return true;
  return (claim.scope?.paths ?? []).includes(targetPath);
}

async function assertRuntimeSpaceClaimVisible(input: {
  readonly entry: CredentialEntry;
  readonly expectedClaim: RuntimeClaim;
  readonly runId: string;
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
      `hook/queue failure: expected runtime Space claim ${input.expectedClaim.claim_id} visible for run id ${input.runId}. Observed: ${summarizeClaims(response.data.claims)}`
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

type ClaimConflictDenialEvidence =
  | {
      readonly kind: 'hook';
      readonly hook: HookTrace;
    }
  | {
      readonly kind: 'transcript';
      readonly excerpt: string;
      readonly rawTranscriptPath: string;
      readonly normalizedTranscriptPath: string;
    };

async function waitForClaimConflictDenialEvidence(input: {
  readonly session: InteractiveSession;
  readonly targetPath: string;
  readonly incumbentClaim: RuntimeClaim;
  readonly incumbentPrincipal: string;
  readonly runId: string;
}): Promise<ClaimConflictDenialEvidence> {
  const deadline = Date.now() + INTERACTIVE_WAIT_TIMEOUT_MS;
  let lastSummary = 'no hook traces observed';
  while (Date.now() < deadline) {
    const traces = await readHookTraces(input.session.artifacts.hookTraceDir);
    const denyTrace = traces.find(
      (trace) =>
        trace.event === 'PreToolUse' &&
        trace.exitCode === 0 &&
        isEditTraceForTarget(trace, input.targetPath) &&
        trace.stdout.includes('"permissionDecision":"deny"') &&
        trace.stdout.includes(input.incumbentClaim.claim_id) &&
        trace.stdout.includes(input.incumbentPrincipal) &&
        trace.stdout.includes('your intent was queued')
    );
    if (denyTrace) return { kind: 'hook', hook: denyTrace };

    const transcriptEvidence = findTranscriptClaimDenialEvidence(input);
    if (transcriptEvidence) return transcriptEvidence;

    lastSummary = summarizeHookTraces(traces);
    await delay(250);
  }

  throw new Error(
    `hook/queue failure: timed out waiting for Bob queued denial evidence on ${input.targetPath} for run id ${input.runId}. Last hook summary: ${lastSummary}. Artifacts: ${input.session.artifacts.dir}`
  );
}

function findTranscriptClaimDenialEvidence(input: {
  readonly session: InteractiveSession;
  readonly targetPath: string;
  readonly incumbentClaim: RuntimeClaim;
  readonly incumbentPrincipal: string;
}): ClaimConflictDenialEvidence | null {
  const normalizedTranscript = input.session.normalizedTranscript();
  const compact = normalizedTranscript.replace(/\s+/g, '').toLowerCase();
  if (
    !compact.includes(input.targetPath.toLowerCase()) ||
    !compact.includes(input.incumbentClaim.claim_id.toLowerCase()) ||
    !compact.includes(`${input.incumbentPrincipal.toLowerCase()}holds`) ||
    !compact.includes('yourintentwasqueued')
  ) {
    return null;
  }

  return {
    kind: 'transcript',
    excerpt: excerptAround(normalizedTranscript, input.incumbentClaim.claim_id),
    rawTranscriptPath: input.session.artifacts.rawTranscriptPath,
    normalizedTranscriptPath: input.session.artifacts.normalizedTranscriptPath
  };
}

function assertNoPermissionRequestRegression(input: {
  readonly traces: readonly McpTrace[];
  readonly hookTraces: readonly HookTrace[];
  readonly artifactsDir: string;
  readonly runId: string;
}): void {
  if (
    hasPermissionRequestMcpCall(input.traces) ||
    hasPermissionRequestedChannelNotification(input.traces) ||
    hasPermissionRequestHookOutput(input.hookTraces)
  ) {
    throw new Error(
      `permission-request regression: normal claim conflict used or accepted permission request behavior for run id ${input.runId}. Artifacts: ${input.artifactsDir}`
    );
  }
}

function hasPermissionRequestMcpCall(traces: readonly McpTrace[]): boolean {
  return traces.some((trace) =>
    trace.messages.some((message) => {
      if (message.direction !== 'client-to-server') return false;
      if (message.method !== 'tools/call') return false;
      return (
        getMcpToolCallName(message.json) === 'teamem.request_edit_permission'
      );
    })
  );
}

function hasPermissionRequestedChannelNotification(
  traces: readonly McpTrace[]
): boolean {
  return traces.some((trace) =>
    trace.messages.some((message) => {
      if (message.method !== 'notifications/claude/channel') return false;
      return message.raw.includes('"event_type":"permission_requested"');
    })
  );
}

function hasPermissionRequestHookOutput(traces: readonly HookTrace[]): boolean {
  return traces.some(
    (trace) =>
      trace.stdout.includes('"request_action":"pending"') ||
      trace.stdout.includes('permission_requested') ||
      trace.stderr.includes('"request_action":"pending"') ||
      trace.stderr.includes('permission_requested')
  );
}

function getMcpToolCallName(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const params = value.params;
  if (!isRecord(params)) return null;
  return typeof params.name === 'string' ? params.name : null;
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
  readonly entry: CredentialEntry;
  readonly claimId: string;
  readonly runId: string;
}): Promise<void> {
  const deadline = Date.now() + LIVE_RUNTIME_POLL_TIMEOUT_MS;
  let lastSummary = 'no runtime claims observed';
  while (Date.now() < deadline) {
    const response = await callLiveRuntimeTool<RuntimeClaims>(
      input.entry,
      'teamem.list_claims',
      { scope: 'self', view: 'space' }
    );
    if (
      !response.data.claims.some((claim) => claim.claim_id === input.claimId)
    ) {
      return;
    }
    lastSummary = summarizeClaims(response.data.claims);
    await delay(500);
  }
  throw new Error(
    `hook/queue failure: timed out waiting for runtime claim release ${input.claimId} for run id ${input.runId}. Last claims summary: ${lastSummary}`
  );
}

async function waitForCopiedWorkspaceMarker(input: {
  readonly workspaceRoot: string;
  readonly targetPath: string;
  readonly marker: string;
  readonly runId: string;
}): Promise<void> {
  const targetFile = join(input.workspaceRoot, input.targetPath);
  const deadline = Date.now() + FILE_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const content = await readOptionalFile(targetFile);
    if (content.includes(input.marker)) return;
    await delay(500);
  }
  throw new Error(
    `hook/queue failure: timed out waiting for copied workspace marker for run id ${input.runId} at ${input.targetPath}`
  );
}

async function assertCopiedWorkspaceDoesNotContainMarker(input: {
  readonly workspaceRoot: string;
  readonly targetPath: string;
  readonly marker: string;
  readonly runId: string;
}): Promise<void> {
  const content = await readFile(
    join(input.workspaceRoot, input.targetPath),
    'utf8'
  );
  expect(
    content,
    `hook/queue failure: unexpected Bob marker for ${input.runId}`
  ).not.toContain(input.marker);
}

async function writeCaseEvidence(input: {
  readonly plan: TeamemChannelsSplitCasePlan;
  readonly alice: PersonaSession;
  readonly bob: PersonaSession;
  readonly carol: PersonaSession;
  readonly aliceRuntime: PersonaRuntime;
  readonly bobRuntime: PersonaRuntime;
  readonly carolRuntime: PersonaRuntime;
  readonly runId: string;
  readonly marker: string;
  readonly targetPath: string;
  readonly alicePrompt: string;
  readonly bobPrompt: string;
  readonly aliceClaim: RuntimeClaim;
  readonly bobDenyEvidence: ClaimConflictDenialEvidence;
}): Promise<void> {
  await writeFile(
    join(
      input.plan.multiProfilePlan.artifactsDir,
      `claim-conflict-${input.runId}.json`
    ),
    `${JSON.stringify(
      {
        runId: input.runId,
        marker: input.marker,
        targetPath: input.targetPath,
        alicePrompt: input.alicePrompt,
        bobPrompt: input.bobPrompt,
        aliceClaim: input.aliceClaim,
        bobDenyEvidence: serializeDenialEvidence(input.bobDenyEvidence),
        personas: {
          alice: personaEvidence(input.alice, input.aliceRuntime),
          bob: personaEvidence(input.bob, input.bobRuntime),
          carol: personaEvidence(input.carol, input.carolRuntime)
        }
      },
      null,
      2
    )}\n`
  );
}

function serializeDenialEvidence(
  evidence: ClaimConflictDenialEvidence
): Record<string, unknown> {
  if (evidence.kind === 'hook') {
    return {
      kind: evidence.kind,
      event: evidence.hook.event,
      exitCode: evidence.hook.exitCode,
      stdout: evidence.hook.stdout,
      stderr: evidence.hook.stderr,
      artifacts: evidence.hook.artifacts
    };
  }
  return evidence;
}

function excerptAround(text: string, needle: string): string {
  const index = text.indexOf(needle);
  if (index < 0) return text.slice(0, 512);
  const start = Math.max(0, index - 256);
  const end = Math.min(text.length, index + needle.length + 256);
  return text.slice(start, end);
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
}

async function materializeLaunchWorkspaceMcpConfig(input: {
  readonly personaPlan: TeamemChannelsPersonaLaunchPlan;
  readonly workspace: DemoRepositoryWorkspace;
}): Promise<void> {
  await writeFile(
    join(input.workspace.demoWorkspaceLaunchCwd, '.mcp.json'),
    await readFile(input.personaPlan.profileMcpConfigPath, 'utf8')
  );
}

function assertClaudeChannelsAvailable(input: {
  readonly persona: TeamemChannelsPersona;
  readonly transcript: string;
  readonly rawTranscriptPath: string;
  readonly normalizedTranscriptPath: string;
  readonly runSummaryPath?: string;
  readonly environmentPath?: string;
  readonly launcherPlanPath?: string;
}): void {
  const compactTranscript = input.transcript.replace(/\s+/g, '').toLowerCase();
  if (
    !compactTranscript.includes('channelsarenotcurrentlyavailable') &&
    !compactTranscript.includes('--channelsignored') &&
    !compactTranscript.includes('channelsignored(') &&
    !compactTranscript.includes(
      'server:entriesneed--dangerously-load-development-channels'
    ) &&
    !compactTranscript.includes('approvedchannelsallowlist') &&
    !compactTranscript.includes('nomcpserverconfiguredwiththatname')
  ) {
    return;
  }
  throw new Error(
    `launch/readiness: Claude Code Channels are not available for ${input.persona}. Run summary: ${input.runSummaryPath ?? '(not captured)'}. Environment: ${input.environmentPath ?? '(not captured)'}. Launcher plan: ${input.launcherPlanPath ?? '(not captured)'}. Raw transcript: ${input.rawTranscriptPath}. Normalized transcript: ${input.normalizedTranscriptPath}`
  );
}

function disallowedTeamemToolsForEditSmoke(): string[] {
  return [
    'Bash(*)',
    'NotebookEdit',
    'mcp__plugin_teamem_channel__*',
    'mcp__teamem-channel__*',
    'mcp__teamem__teamem_request_edit_permission',
    'mcp__plugin_teamem_teamem__teamem_request_edit_permission',
    'mcp__teamem__teamem_post_message',
    'mcp__plugin_teamem_teamem__teamem_post_message',
    'mcp__teamem__teamem_claim_scope',
    'mcp__plugin_teamem_teamem__teamem_claim_scope',
    'mcp__teamem__teamem_release_scope',
    'mcp__plugin_teamem_teamem__teamem_release_scope',
    'mcp__teamem__teamem_list_claims',
    'mcp__plugin_teamem_teamem__teamem_list_claims'
  ];
}

function requirePersonaPlan(
  plan: TeamemChannelsSplitCasePlan,
  persona: TeamemChannelsPersona
): TeamemChannelsPersonaLaunchPlan {
  const found = plan.personas.find((entry) => entry.persona === persona);
  if (!found) throw new Error(`Missing Channels plan for ${persona}.`);
  return found;
}

function requireRuntime(
  runtimes: readonly PersonaRuntime[],
  persona: TeamemChannelsPersona
): PersonaRuntime {
  const found = runtimes.find((runtime) => runtime.persona === persona);
  if (!found) throw new Error(`Missing runtime for ${persona}.`);
  return found;
}

function requireLaunched(
  launched: ReadonlyMap<TeamemChannelsPersona, PersonaSession>,
  persona: TeamemChannelsPersona
): PersonaSession {
  const found = launched.get(persona);
  if (!found) throw new Error(`Missing launched session for ${persona}.`);
  return found;
}

function matchesTargetClaim(
  claim: RuntimeClaim,
  input: { readonly repoId: string; readonly targetPath: string }
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
  if (!isRecord(trace.stdinJson)) return false;
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

function hasChannelReadiness(input: {
  readonly log: string;
  readonly expectedStart: string;
  readonly phase: 'channel-ready' | 'cursor-primed';
}): boolean {
  const startIndex = input.log.indexOf(input.expectedStart);
  if (startIndex === -1) return false;
  if (input.phase === 'channel-ready') return true;
  const currentSessionLog = input.log.slice(
    startIndex + input.expectedStart.length
  );
  return (
    currentSessionLog.includes('primed cursor=') ||
    currentSessionLog.includes('loaded cursor=')
  );
}

function notificationLogPath(
  env: NodeJS.ProcessEnv,
  sessionId: string
): string {
  return join(
    requiredEnv(env, 'CLAUDE_PLUGIN_DATA'),
    'sessions',
    sessionId,
    'notifications.log'
  );
}

function channelLogPath(env: NodeJS.ProcessEnv): string {
  return join(requiredEnv(env, 'CLAUDE_PLUGIN_DATA'), 'channel.log');
}

function sliceLogAfterLineOffset(log: string, lineOffset: number): string {
  if (lineOffset <= 0) return log;
  return log.split(/\r?\n/).slice(lineOffset).join('\n');
}

function latestTraceOffsetMs(traces: readonly McpTrace[]): number {
  return Math.max(
    0,
    ...traces.flatMap((trace) =>
      trace.messages.map((message) => message.offsetMs)
    )
  );
}

function countNonEmptyLines(value: string): number {
  return value.split(/\r?\n/).filter((line) => line.trim()).length;
}

function summarizeClaims(claims: readonly RuntimeClaim[]): string {
  if (claims.length === 0) return 'none';
  return claims
    .map(
      (claim) =>
        `${claim.claim_id}:${claim.principal}:${claim.repo_id}:${claim.branch}:${claim.path}:${claim.status}:${claim.mode}:${claim.context}:${claim.sprint_id ?? 'no-sprint'}`
    )
    .join(', ');
}

function summarizeHookTraces(traces: readonly HookTrace[]): string {
  if (traces.length === 0) return 'none';
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

function personaEvidence(
  launchedPersona: PersonaSession,
  runtime: PersonaRuntime
): Record<string, unknown> {
  return {
    persona: launchedPersona.personaPlan.persona,
    profileName: launchedPersona.personaPlan.profileName,
    principal: runtime.whoami.principal,
    spaceId: runtime.whoami.space_id,
    sessionId: runtime.sessionId,
    channelSessionId: runtime.channelSessionId,
    artifactDir: launchedPersona.personaPlan.artifactDir,
    runArtifactDir: launchedPersona.session.artifacts.dir,
    mcpTraceDir: launchedPersona.session.artifacts.mcpTraceDir,
    hookTraceDir: launchedPersona.session.artifacts.hookTraceDir,
    rawTranscriptPath: launchedPersona.session.artifacts.rawTranscriptPath,
    normalizedTranscriptPath:
      launchedPersona.session.artifacts.normalizedTranscriptPath,
    channelLogPath: launchedPersona.channelLogPath,
    channelLogLineOffset: launchedPersona.channelLogLineOffset,
    notificationLogPath: launchedPersona.notificationLogPath
  };
}

function requiredEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`Missing required env ${key}`);
  return value;
}

function createRunId(): string {
  return `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()
    .replaceAll('-', '')
    .slice(0, 8)}`;
}

async function readOptionalFile(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return '';
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
