import { describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createClaudePluginTester,
  readMcpTraces,
  type BootResult,
  type InteractiveSession,
  type McpTrace,
  type McpTraceMessage
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
  TeamemChannelsEvidenceError,
  assertTeamemNoSenderEchoEvidence,
  assertTeamemRecipientReceipt,
  createTeamemChannelsTranscriptCheckpoint,
  type TeamemChannelsEvidenceExpectation,
  type TeamemChannelsEvidenceLayer,
  type TeamemChannelsTranscriptCheckpoint
} from './teamem-channels-evidence.js';

type DecisionMcpEvidence = {
  readonly event_id: string;
  readonly decision_id: string;
  readonly lifecycle_event: string;
  readonly version?: number;
  readonly kind?: string;
  readonly status?: string;
};

type GotchaMcpEvidence = {
  readonly event_id: string;
  readonly finding_id: string;
  readonly kind: string;
  readonly version?: number;
  readonly status?: string;
  readonly severity?: string;
  readonly tags: readonly string[];
  readonly paths: readonly string[];
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
const describeLiveChannelsKnowledge = gate.enabled ? describe : describe.skip;
const repoRoot = process.cwd();
const teamemPluginDir = join(repoRoot, 'plugin');

const LIVE_CHANNELS_KNOWLEDGE_TIMEOUT_MS = 420_000;
const INTERACTIVE_READINESS_TIMEOUT_MS = 30_000;
const INTERACTIVE_WAIT_TIMEOUT_MS = 90_000;
const INTERACTIVE_CLOSE_TIMEOUT_MS = 10_000;
const INTERACTIVE_TYPE_DELAY_MS = 20;
const CHANNEL_READINESS_TIMEOUT_MS = 45_000;
const CHANNEL_RECEIPT_TIMEOUT_MS = 90_000;
const CHANNEL_NEGATIVE_WINDOW_MS = 10_000;
const CHANNEL_ASSERTION_POLL_MS = 500;
const CASE_NAME = 'decision-live';
const GOTCHA_CASE_NAME = 'gotcha-live';
const pluginScopedToolPrefix = 'mcp__plugin_teamem_teamem__teamem_';
const canonicalTeamemToolPrefix = 'mcp__teamem__teamem_';

describeLiveChannelsKnowledge(
  `Teamem L5 Channels live knowledge smoke${gate.enabled ? '' : ` (${gate.reason})`}`,
  () => {
    it(
      "renders Alice's real decision slash command live to passive Bob and Carol without Alice echo",
      async () => {
        await withLiveInteractiveSmokeLock(
          'teamem-channels-decision-live',
          runChannelsDecisionLiveCase
        );
      },
      LIVE_CHANNELS_KNOWLEDGE_TIMEOUT_MS
    );

    it(
      "renders Alice's real gotcha slash command live to passive Bob and Carol as compact notices without Alice echo",
      async () => {
        await withLiveInteractiveSmokeLock(
          'teamem-channels-gotcha-live',
          runChannelsGotchaLiveCase
        );
      },
      LIVE_CHANNELS_KNOWLEDGE_TIMEOUT_MS
    );
  }
);

async function runChannelsDecisionLiveCase(): Promise<void> {
  let workspace: DemoRepositoryWorkspace | undefined;
  let plan: TeamemChannelsSplitCasePlan | undefined;
  const sessions: InteractiveSession[] = [];
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
    plan = await planTeamemChannelsSplitCase({
      runId: `decision-${createRunId()}`,
      splitCase: 'direct',
      teamemRoot: repoRoot,
      workspace,
      artifactsParentDir: tmpdir()
    });

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
          const launchedPersona = await launchPersona({
            personaPlan: persona,
            runtime: requireRuntime(runtimes, persona.persona),
            workspace: workspace!
          });
          launched.set(persona.persona, launchedPersona);
          sessions.push(launchedPersona.session);
          return;
        }
        await waitForChannelReadiness({
          launchedPersona: requireLaunched(launched, persona.persona),
          phase
        });
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

    const checkpoints = {
      alice: await createCheckpoint(alice),
      bob: await createCheckpoint(bob),
      carol: await createCheckpoint(carol)
    };
    const marker = `teamem-channels-${CASE_NAME}-${plan.runId}`;
    const title = `Channels decision title ${marker}`;
    const body = `Channels decision body ${marker} proves full live text`;
    const bodyEvidenceText = decisionBodyEvidenceText(body, marker);
    const decisionArgs = `${title} -- ${body} --kind=process`;
    const decisionPrompt = await createPersonaTester({
      personaPlan: alicePlan,
      workspace
    }).slashCommandPrompt('decide', decisionArgs);

    await alice.session.submit(decisionPrompt, {
      delayMs: INTERACTIVE_TYPE_DELAY_MS
    });
    const decision = await waitForDecisionMcpEvidence({
      session: alice.session,
      title,
      body,
      bodyEvidenceText,
      marker
    });
    expect(decision.lifecycle_event).toBe('decision_published');

    const expectations = {
      alice: createExpectedDecisionReceipt({
        plan,
        marker,
        title,
        body,
        bodyEvidenceText,
        decision,
        senderPrincipal: aliceRuntime.whoami.principal,
        recipientPrincipal: aliceRuntime.whoami.principal
      }),
      bob: createExpectedDecisionReceipt({
        plan,
        marker,
        title,
        body,
        bodyEvidenceText,
        decision,
        senderPrincipal: aliceRuntime.whoami.principal,
        recipientPrincipal: bobRuntime.whoami.principal
      }),
      carol: createExpectedDecisionReceipt({
        plan,
        marker,
        title,
        body,
        bodyEvidenceText,
        decision,
        senderPrincipal: aliceRuntime.whoami.principal,
        recipientPrincipal: carolRuntime.whoami.principal
      })
    };

    await Promise.all([
      waitForRecipientReceipt({
        launchedPersona: bob,
        expected: expectations.bob,
        checkpoint: checkpoints.bob,
        personaPrincipal: bobRuntime.whoami.principal
      }),
      waitForRecipientReceipt({
        launchedPersona: carol,
        expected: expectations.carol,
        checkpoint: checkpoints.carol,
        personaPrincipal: carolRuntime.whoami.principal
      })
    ]);
    await assertNoSenderEcho({
      launchedPersona: alice,
      expected: expectations.alice,
      checkpoint: checkpoints.alice,
      allowedTranscriptMarkerEchoes: [decisionPrompt, decisionArgs, title, body]
    });

    await writeCaseEvidence({
      plan,
      alice,
      bob,
      carol,
      aliceRuntime,
      bobRuntime,
      carolRuntime,
      marker,
      title,
      body,
      prompt: decisionPrompt,
      decision,
      expected: expectations
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
    if (plan) {
      const cleanup = await finishTeamemChannelsSplitCase(plan, {
        success,
        error: failure,
        workspacePath: workspace?.demoWorkspaceLaunchCwd
      });
      if (cleanup.preserved) {
        console.error(
          `Preserving failed Channels decision-live smoke artifacts at ${cleanup.artifactsDir}${cleanup.failurePathsPath ? ` (failure paths ${cleanup.failurePathsPath})` : ''}`
        );
        if (cleanup.failureError) console.error(cleanup.failureError.message);
      }
    }
    if (workspace) {
      const cleanup = await finishDemoRepositoryWorkspace(workspace, {
        success,
        artifactsDir: plan?.multiProfilePlan.artifactsDir
      });
      if (cleanup.preserved) {
        console.error(
          `Preserving failed Channels decision-live demo workspace at ${cleanup.demoWorkspaceLaunchCwd}${cleanup.artifactPath ? ` (report ${cleanup.artifactPath})` : ''}`
        );
      }
    }
  }
}

async function runChannelsGotchaLiveCase(): Promise<void> {
  let workspace: DemoRepositoryWorkspace | undefined;
  let plan: TeamemChannelsSplitCasePlan | undefined;
  const sessions: InteractiveSession[] = [];
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
    plan = await planTeamemChannelsSplitCase({
      runId: `gotcha-${createRunId()}`,
      splitCase: 'starstar',
      teamemRoot: repoRoot,
      workspace,
      artifactsParentDir: tmpdir()
    });

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
          const launchedPersona = await launchPersona({
            personaPlan: persona,
            runtime: requireRuntime(runtimes, persona.persona),
            workspace: workspace!
          });
          launched.set(persona.persona, launchedPersona);
          sessions.push(launchedPersona.session);
          return;
        }
        await waitForChannelReadiness({
          launchedPersona: requireLaunched(launched, persona.persona),
          phase
        });
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

    const checkpoints = {
      alice: await createCheckpoint(alice),
      bob: await createCheckpoint(bob),
      carol: await createCheckpoint(carol)
    };
    const summaryMarker = `teamem-channels-${GOTCHA_CASE_NAME}-summary-${plan.runId}`;
    const tag = `gotcha-${plan.runId
      .replace(/[^a-zA-Z0-9_-]/g, '-')
      .slice(0, 48)
      .toLowerCase()}`;
    const summary = `Channels gotcha compact summary ${summaryMarker}`;
    const gotchaArgs = `${summary} #teamem-smoke #${tag} --severity=warning`;
    const gotchaPrompt = await createPersonaTester({
      personaPlan: alicePlan,
      workspace
    }).slashCommandPrompt('gotcha', gotchaArgs);

    await alice.session.submit(gotchaPrompt, {
      delayMs: INTERACTIVE_TYPE_DELAY_MS
    });
    const gotcha = await waitForGotchaMcpEvidence({
      runtime: aliceRuntime,
      session: alice.session,
      summary,
      summaryMarker,
      tag
    });

    const expectations = {
      alice: createExpectedGotchaReceipt({
        plan,
        summaryMarker,
        summary,
        gotcha,
        senderPrincipal: aliceRuntime.whoami.principal,
        recipientPrincipal: aliceRuntime.whoami.principal
      }),
      bob: createExpectedGotchaReceipt({
        plan,
        summaryMarker,
        summary,
        gotcha,
        senderPrincipal: aliceRuntime.whoami.principal,
        recipientPrincipal: bobRuntime.whoami.principal
      }),
      carol: createExpectedGotchaReceipt({
        plan,
        summaryMarker,
        summary,
        gotcha,
        senderPrincipal: aliceRuntime.whoami.principal,
        recipientPrincipal: carolRuntime.whoami.principal
      })
    };

    await Promise.all([
      waitForRecipientReceipt({
        launchedPersona: bob,
        expected: expectations.bob,
        checkpoint: checkpoints.bob,
        personaPrincipal: bobRuntime.whoami.principal
      }),
      waitForRecipientReceipt({
        launchedPersona: carol,
        expected: expectations.carol,
        checkpoint: checkpoints.carol,
        personaPrincipal: carolRuntime.whoami.principal
      })
    ]);
    await assertNoSenderEcho({
      launchedPersona: alice,
      expected: expectations.alice,
      checkpoint: checkpoints.alice,
      allowedTranscriptMarkerEchoes: [
        gotchaPrompt,
        gotchaArgs,
        summary,
        summaryMarker
      ]
    });

    await writeGotchaCaseEvidence({
      plan,
      alice,
      bob,
      carol,
      aliceRuntime,
      bobRuntime,
      carolRuntime,
      summaryMarker,
      summary,
      prompt: gotchaPrompt,
      gotcha,
      expected: expectations
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
    if (plan) {
      const cleanup = await finishTeamemChannelsSplitCase(plan, {
        success,
        error: failure,
        workspacePath: workspace?.demoWorkspaceLaunchCwd
      });
      if (cleanup.preserved) {
        console.error(
          `Preserving failed Channels gotcha-live smoke artifacts at ${cleanup.artifactsDir}${cleanup.failurePathsPath ? ` (failure paths ${cleanup.failurePathsPath})` : ''}`
        );
        if (cleanup.failureError) console.error(cleanup.failureError.message);
      }
    }
    if (workspace) {
      const cleanup = await finishDemoRepositoryWorkspace(workspace, {
        success,
        artifactsDir: plan?.multiProfilePlan.artifactsDir
      });
      if (cleanup.preserved) {
        console.error(
          `Preserving failed Channels gotcha-live demo workspace at ${cleanup.demoWorkspaceLaunchCwd}${cleanup.artifactPath ? ` (report ${cleanup.artifactPath})` : ''}`
        );
      }
    }
  }
}

function createExpectedDecisionReceipt(input: {
  readonly plan: TeamemChannelsSplitCasePlan;
  readonly marker: string;
  readonly title: string;
  readonly body: string;
  readonly bodyEvidenceText: string;
  readonly decision: DecisionMcpEvidence;
  readonly senderPrincipal: string;
  readonly recipientPrincipal: string;
}): TeamemChannelsEvidenceExpectation {
  const metadata = [
    input.decision.decision_id,
    String(input.decision.version ?? ''),
    input.decision.kind ?? ''
  ].filter(Boolean);
  return {
    runId: input.plan.runId,
    caseName: CASE_NAME,
    marker: input.marker,
    eventType: input.decision.lifecycle_event,
    eventId: input.decision.event_id,
    senderPrincipal: input.senderPrincipal,
    recipientPrincipal: input.recipientPrincipal,
    requiredPayloadText: [
      input.marker,
      input.title,
      input.bodyEvidenceText,
      ...metadata
    ],
    requiredRenderedText: [
      'teamem-channel:',
      'teamem.peer_event',
      input.decision.lifecycle_event,
      input.senderPrincipal,
      input.marker,
      input.title,
      input.bodyEvidenceText,
      ...metadata
    ]
  };
}

function decisionBodyEvidenceText(body: string, marker: string): string {
  const markerIndex = body.indexOf(marker);
  return markerIndex >= 0 ? body.slice(markerIndex) : body;
}

function createExpectedGotchaReceipt(input: {
  readonly plan: TeamemChannelsSplitCasePlan;
  readonly summaryMarker: string;
  readonly summary: string;
  readonly gotcha: GotchaMcpEvidence;
  readonly senderPrincipal: string;
  readonly recipientPrincipal: string;
}): TeamemChannelsEvidenceExpectation {
  const metadata = [
    input.gotcha.finding_id,
    String(input.gotcha.version ?? ''),
    input.gotcha.kind,
    input.gotcha.severity ?? '',
    ...input.gotcha.tags,
    ...input.gotcha.paths
  ].filter(Boolean);
  return {
    runId: input.plan.runId,
    caseName: GOTCHA_CASE_NAME,
    marker: input.summaryMarker,
    eventType: 'finding_shared',
    eventId: input.gotcha.event_id,
    senderPrincipal: input.senderPrincipal,
    recipientPrincipal: input.recipientPrincipal,
    requiredPayloadText: [
      input.summaryMarker,
      input.summary,
      'gotcha',
      'fetch_detail_with_teamem.get_finding',
      ...metadata
    ],
    requiredRenderedText: [
      'teamem-channel:',
      'teamem.peer_event',
      'finding_shared',
      input.senderPrincipal,
      input.summaryMarker,
      input.summary,
      'gotcha',
      ...metadata
    ]
  };
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
  if (!loaded) throw new Error(`Invalid credentials at ${credentialsPath}`);
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
  const tester = createPersonaTester({
    personaPlan: input.personaPlan,
    workspace: input.workspace
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
    allowedTools: [
      'Bash(bash:*)',
      `${pluginScopedToolPrefix}record_decision`,
      `${canonicalTeamemToolPrefix}record_decision`
    ],
    disallowedTools: [
      'mcp__plugin_teamem_channel__*',
      'mcp__teamem-channel__*',
      `${pluginScopedToolPrefix}post_message`,
      `${canonicalTeamemToolPrefix}post_message`,
      `${pluginScopedToolPrefix}get_briefing`,
      `${canonicalTeamemToolPrefix}get_briefing`
    ],
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

function createPersonaTester(input: {
  readonly personaPlan: TeamemChannelsPersonaLaunchPlan;
  readonly workspace: DemoRepositoryWorkspace;
}) {
  return createClaudePluginTester({
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

async function waitForDecisionMcpEvidence(input: {
  readonly session: InteractiveSession;
  readonly title: string;
  readonly body: string;
  readonly bodyEvidenceText: string;
  readonly marker: string;
}): Promise<DecisionMcpEvidence> {
  const deadline = Date.now() + INTERACTIVE_WAIT_TIMEOUT_MS;
  let lastTraceSummary = 'no MCP traces observed';
  let lastError: unknown;

  while (Date.now() < deadline) {
    const traces = await readMcpTraces(input.session.artifacts.mcpTraceDir, {
      ignoreTransientErrors: true
    });
    try {
      return readDecisionMcpEvidence({
        traces,
        artifactsDir: input.session.artifacts.dir,
        title: input.title,
        body: input.body,
        bodyEvidenceText: input.bodyEvidenceText,
        marker: input.marker
      });
    } catch (error) {
      lastError = error;
      if (!(error instanceof DecisionMcpEvidenceError) || !error.transient) {
        throw error;
      }
    }
    lastTraceSummary = summarizeTraces(traces);
    await delay(CHANNEL_ASSERTION_POLL_MS);
  }

  throw new Error(
    `command/MCP: timed out waiting for record_decision evidence (run id=${input.session.artifacts.runId}, marker=${input.marker}, persona=alice, mcp traces=${input.session.artifacts.mcpTraceDir}, last traces=${lastTraceSummary}, last error=${formatError(lastError)})`
  );
}

async function waitForGotchaMcpEvidence(input: {
  readonly runtime: PersonaRuntime;
  readonly session: InteractiveSession;
  readonly summary: string;
  readonly summaryMarker: string;
  readonly tag: string;
}): Promise<GotchaMcpEvidence> {
  const deadline = Date.now() + INTERACTIVE_WAIT_TIMEOUT_MS;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      assertGotchaCommandInvocationEvidence({
        transcript: input.session.rawTranscript(),
        summaryMarker: input.summaryMarker,
        severity: 'warning'
      });
      const updates = await callLiveRuntimeTool<{
        events?: readonly Record<string, unknown>[];
      }>(input.runtime.entry, 'teamem.get_updates', { limit: 500 }, 10_000);
      const gotcha = readGotchaMcpEvidence({
        events: updates.data.events ?? [],
        summary: input.summary,
        summaryMarker: input.summaryMarker,
        tag: input.tag,
        artifactsDir: input.session.artifacts.dir
      });
      return gotcha;
    } catch (error) {
      lastError = error;
      if (!(error instanceof GotchaMcpEvidenceError) || !error.transient) {
        throw error;
      }
      await delay(CHANNEL_ASSERTION_POLL_MS);
    }
  }

  throw new Error(
    `command/MCP: timed out waiting for gotcha share evidence (run id=${input.session.artifacts.runId}, marker=${input.summaryMarker}, persona=alice, artifacts=${input.session.artifacts.dir}, last error=${formatError(lastError)})`
  );
}

function assertGotchaCommandInvocationEvidence(input: {
  readonly transcript: string;
  readonly summaryMarker: string;
  readonly severity: string;
}): void {
  if (
    input.transcript.includes('/teamem:gotcha') &&
    input.transcript.includes(input.summaryMarker) &&
    input.transcript.includes(`--severity=${input.severity}`)
  ) {
    return;
  }
  throw new GotchaMcpEvidenceError(
    `Expected /teamem:gotcha command invocation evidence for marker ${input.summaryMarker} and severity ${input.severity}`,
    { transient: true }
  );
}

function readGotchaMcpEvidence(input: {
  readonly events: readonly Record<string, unknown>[];
  readonly summary: string;
  readonly summaryMarker: string;
  readonly tag: string;
  readonly artifactsDir: string;
}): GotchaMcpEvidence {
  const event = input.events.find((candidate) => {
    if (candidate.event_type !== 'finding_shared') return false;
    const payload = isRecord(candidate.payload) ? candidate.payload : {};
    return (
      payload.kind === 'gotcha' &&
      payload.summary === input.summary &&
      String(payload.summary ?? '').includes(input.summaryMarker)
    );
  });

  if (!event) {
    throw new GotchaMcpEvidenceError(
      `Expected teamem.get_updates gotcha event for "${input.summary}". Artifacts: ${input.artifactsDir}`,
      { transient: true }
    );
  }

  const payload = isRecord(event.payload) ? event.payload : {};
  const tags = readStringArrayField(payload, 'tags', input.artifactsDir);
  if (!tags.includes('teamem-smoke') || !tags.includes(input.tag)) {
    throw new GotchaMcpEvidenceError(
      `Expected gotcha tags teamem-smoke and ${input.tag}. Observed ${JSON.stringify(tags)}. Artifacts: ${input.artifactsDir}`,
      { transient: false }
    );
  }

  return {
    event_id: readStringField(event, 'event_id', input.artifactsDir),
    finding_id: readStringField(payload, 'finding_id', input.artifactsDir),
    kind: readStringField(payload, 'kind', input.artifactsDir),
    version: readOptionalNumberField(payload, 'version', input.artifactsDir),
    status: readOptionalStringField(payload, 'status', input.artifactsDir),
    severity: readOptionalStringField(payload, 'severity', input.artifactsDir),
    tags,
    paths: readStringArrayField(payload, 'paths', input.artifactsDir)
  };
}

class GotchaMcpEvidenceError extends Error {
  readonly transient: boolean;

  constructor(message: string, options: { readonly transient: boolean }) {
    super(`command/MCP: ${message}`);
    this.name = 'GotchaMcpEvidenceError';
    this.transient = options.transient;
  }
}

function readDecisionMcpEvidence(input: {
  readonly traces: readonly McpTrace[];
  readonly artifactsDir: string;
  readonly title: string;
  readonly body: string;
  readonly bodyEvidenceText: string;
  readonly marker: string;
}): DecisionMcpEvidence {
  const messages = successfulToolResponseMessages(
    input.traces,
    'record_decision'
  );
  for (const message of messages) {
    const request = findRequestForResponse(input.traces, message);
    const requestArgs = readRequestArguments(request);
    if (requestArgs.title !== input.title) continue;
    if (
      !matchesDecisionBodyEvidence({
        requestArgs,
        body: input.body,
        bodyEvidenceText: input.bodyEvidenceText,
        marker: input.marker
      })
    ) {
      continue;
    }
    const data = extractToolResponseData(message);
    if (!data) {
      throw new DecisionMcpEvidenceError(
        `Expected unredacted record_decision response data for "${input.title}". Set CLAUDE_PLUGIN_E2E_ALLOW_UNREDACTED=1. Artifacts: ${input.artifactsDir}`,
        { transient: false }
      );
    }
    return {
      event_id: readStringField(data, 'event_id', input.artifactsDir),
      decision_id: readStringField(data, 'decision_id', input.artifactsDir),
      lifecycle_event: readStringField(
        data,
        'lifecycle_event',
        input.artifactsDir
      ),
      version: readOptionalNumberField(data, 'version', input.artifactsDir),
      kind: readOptionalStringField(data, 'kind', input.artifactsDir),
      status: readOptionalStringField(data, 'status', input.artifactsDir)
    };
  }

  throw new DecisionMcpEvidenceError(
    `Expected record_decision MCP evidence for "${input.title}". Artifacts: ${input.artifactsDir}`,
    { transient: true }
  );
}

function matchesDecisionBodyEvidence(input: {
  readonly requestArgs: Record<string, unknown>;
  readonly body: string;
  readonly bodyEvidenceText: string;
  readonly marker: string;
}): boolean {
  return ['summary', 'body'].some((field) => {
    const value = input.requestArgs[field];
    if (typeof value !== 'string') return false;
    return (
      value === input.body ||
      value === input.bodyEvidenceText ||
      (value.includes(input.marker) && value.includes('proves full live text'))
    );
  });
}

class DecisionMcpEvidenceError extends Error {
  readonly transient: boolean;

  constructor(message: string, options: { readonly transient: boolean }) {
    super(`command/MCP: ${message}`);
    this.name = 'DecisionMcpEvidenceError';
    this.transient = options.transient;
  }
}

async function waitForRecipientReceipt(input: {
  readonly launchedPersona: PersonaSession;
  readonly expected: TeamemChannelsEvidenceExpectation;
  readonly checkpoint: TeamemChannelsTranscriptCheckpoint;
  readonly personaPrincipal: string;
}): Promise<void> {
  const deadline = Date.now() + CHANNEL_RECEIPT_TIMEOUT_MS;
  let lastError: unknown;
  let lastSnapshot: EvidenceSnapshot | undefined;

  while (Date.now() < deadline) {
    const snapshot = await writeEvidenceSnapshot(input.launchedPersona);
    lastSnapshot = snapshot;
    try {
      await assertTeamemRecipientReceipt({
        persona: input.launchedPersona.personaPlan.persona,
        personaPrincipal: input.personaPrincipal,
        expected: input.expected,
        tracePath: snapshot.tracePath,
        notificationLogPath: snapshot.notificationLogPath,
        rawTranscriptPath: snapshot.rawTranscriptPath,
        normalizedTranscriptPath: snapshot.normalizedTranscriptPath,
        traceCheckpoint: { offsetMs: input.checkpoint.traceOffsetMs },
        notificationCheckpoint: {
          lineOffset: input.checkpoint.notificationLineOffset
        },
        transcriptCheckpoint: input.checkpoint
      });
      return;
    } catch (error) {
      lastError = error;
      await delay(CHANNEL_ASSERTION_POLL_MS);
    }
  }

  throw new Error(
    formatRecipientReceiptTimeout({
      launchedPersona: input.launchedPersona,
      expected: input.expected,
      lastSnapshot,
      lastError
    })
  );
}

async function assertNoSenderEcho(input: {
  readonly launchedPersona: PersonaSession;
  readonly expected: TeamemChannelsEvidenceExpectation;
  readonly checkpoint: TeamemChannelsTranscriptCheckpoint;
  readonly allowedTranscriptMarkerEchoes?: readonly string[];
}): Promise<void> {
  const deadline = Date.now() + CHANNEL_NEGATIVE_WINDOW_MS;
  while (Date.now() < deadline) {
    const snapshot = await writeEvidenceSnapshot(input.launchedPersona);
    assertTeamemNoSenderEchoEvidence({
      persona: input.launchedPersona.personaPlan.persona,
      expected: input.expected,
      traces: snapshot.traces,
      notificationLog: snapshot.notificationLog,
      rawTranscript: snapshot.rawTranscript,
      normalizedTranscript: snapshot.normalizedTranscript,
      traceCheckpoint: { offsetMs: input.checkpoint.traceOffsetMs },
      notificationCheckpoint: {
        lineOffset: input.checkpoint.notificationLineOffset
      },
      transcriptCheckpoint: input.checkpoint,
      allowedTranscriptMarkerEchoes: input.allowedTranscriptMarkerEchoes,
      artifacts: {
        channelTracePath: snapshot.tracePath,
        notificationLogPath: snapshot.notificationLogPath,
        rawTranscriptPath: snapshot.rawTranscriptPath,
        normalizedTranscriptPath: snapshot.normalizedTranscriptPath
      }
    });
    await delay(CHANNEL_ASSERTION_POLL_MS);
  }
}

async function writeEvidenceSnapshot(
  launchedPersona: PersonaSession
): Promise<EvidenceSnapshot> {
  const dir = join(launchedPersona.personaPlan.artifactDir, 'runtime-evidence');
  const prefix = `${launchedPersona.personaPlan.persona}-channels-knowledge-${launchedPersona.runtime.sessionId}`;
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

async function writeCaseEvidence(input: {
  readonly plan: TeamemChannelsSplitCasePlan;
  readonly alice: PersonaSession;
  readonly bob: PersonaSession;
  readonly carol: PersonaSession;
  readonly aliceRuntime: PersonaRuntime;
  readonly bobRuntime: PersonaRuntime;
  readonly carolRuntime: PersonaRuntime;
  readonly marker: string;
  readonly title: string;
  readonly body: string;
  readonly prompt: string;
  readonly decision: DecisionMcpEvidence;
  readonly expected: Record<
    TeamemChannelsPersona,
    TeamemChannelsEvidenceExpectation
  >;
}): Promise<void> {
  await writeFile(
    join(
      input.plan.multiProfilePlan.artifactsDir,
      'channels-decision-live.json'
    ),
    `${JSON.stringify(
      {
        runId: input.plan.runId,
        caseName: CASE_NAME,
        marker: input.marker,
        title: input.title,
        body: input.body,
        prompt: input.prompt,
        decision: input.decision,
        expected: input.expected,
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

async function writeGotchaCaseEvidence(input: {
  readonly plan: TeamemChannelsSplitCasePlan;
  readonly alice: PersonaSession;
  readonly bob: PersonaSession;
  readonly carol: PersonaSession;
  readonly aliceRuntime: PersonaRuntime;
  readonly bobRuntime: PersonaRuntime;
  readonly carolRuntime: PersonaRuntime;
  readonly summaryMarker: string;
  readonly summary: string;
  readonly prompt: string;
  readonly gotcha: GotchaMcpEvidence;
  readonly expected: Record<
    TeamemChannelsPersona,
    TeamemChannelsEvidenceExpectation
  >;
}): Promise<void> {
  await writeFile(
    join(input.plan.multiProfilePlan.artifactsDir, 'channels-gotcha-live.json'),
    `${JSON.stringify(
      {
        runId: input.plan.runId,
        caseName: GOTCHA_CASE_NAME,
        summaryMarker: input.summaryMarker,
        summary: input.summary,
        prompt: input.prompt,
        gotcha: input.gotcha,
        expected: input.expected,
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

function formatRecipientReceiptTimeout(input: {
  readonly launchedPersona: PersonaSession;
  readonly expected: TeamemChannelsEvidenceExpectation;
  readonly lastSnapshot?: EvidenceSnapshot;
  readonly lastError: unknown;
}): string {
  return `${recipientReceiptTimeoutLayer(input.lastError)}: timed out waiting for decision recipient receipt (run id=${input.expected.runId}, marker=${input.expected.marker}, persona=${input.launchedPersona.personaPlan.persona}, channel trace=${input.lastSnapshot?.tracePath ?? input.launchedPersona.session.artifacts.mcpTraceDir}, notification log=${input.lastSnapshot?.notificationLogPath ?? input.launchedPersona.notificationLogPath}, raw transcript=${input.lastSnapshot?.rawTranscriptPath ?? input.launchedPersona.session.artifacts.rawTranscriptPath}, normalized transcript=${input.lastSnapshot?.normalizedTranscriptPath ?? input.launchedPersona.session.artifacts.normalizedTranscriptPath}, last error=${formatError(input.lastError)})`;
}

function recipientReceiptTimeoutLayer(
  error: unknown
): TeamemChannelsEvidenceLayer {
  return error instanceof TeamemChannelsEvidenceError
    ? error.layer
    : 'channel transport';
}

function successfulToolResponseMessages(
  traces: readonly McpTrace[],
  expectedToolName: string
): McpTraceMessage[] {
  return traces
    .filter((trace) => trace.serverName === 'teamem')
    .flatMap((trace) => trace.messages)
    .filter(
      (message) =>
        message.direction === 'server-to-client' &&
        typeof message.metadata?.toolName === 'string' &&
        message.metadata.response?.ok === true &&
        normalizeToolName(message.metadata.toolName) === expectedToolName
    );
}

function findRequestForResponse(
  traces: readonly McpTrace[],
  response: McpTraceMessage
): McpTraceMessage | undefined {
  if (!isRecord(response.json) || typeof response.json.id === 'undefined') {
    return undefined;
  }
  const responseId = response.json.id;
  return traces
    .filter((trace) => trace.serverName === 'teamem')
    .flatMap((trace) => trace.messages)
    .find(
      (message) =>
        message.direction === 'client-to-server' &&
        message.method === 'tools/call' &&
        isRecord(message.json) &&
        message.json.id === responseId
    );
}

function readRequestArguments(
  message: McpTraceMessage | undefined
): Record<string, unknown> {
  if (!message || !isRecord(message.json)) return {};
  const params = isRecord(message.json.params) ? message.json.params : {};
  return isRecord(params.arguments) ? params.arguments : {};
}

function extractToolResponseData(
  message: McpTraceMessage
): Record<string, unknown> | undefined {
  if (!isRecord(message.json)) return undefined;
  const result = isRecord(message.json.result)
    ? message.json.result
    : undefined;
  const structuredContent = isRecord(result?.structuredContent)
    ? result.structuredContent
    : undefined;
  if (isRecord(structuredContent?.data)) return structuredContent.data;
  if (!Array.isArray(result?.content)) return undefined;
  const textBlock = result.content.find(
    (item) =>
      isRecord(item) && item.type === 'text' && typeof item.text === 'string'
  );
  if (!isRecord(textBlock) || typeof textBlock.text !== 'string') {
    return undefined;
  }
  try {
    const parsed = JSON.parse(textBlock.text) as unknown;
    return isRecord(parsed) && isRecord(parsed.data) ? parsed.data : undefined;
  } catch {
    return undefined;
  }
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

function summarizeTraces(traces: readonly McpTrace[]): string {
  if (traces.length === 0) return 'no MCP traces observed';
  return traces
    .map(
      (trace) =>
        `${trace.serverName}:${
          trace.messages
            .map((message) => message.metadata?.toolName ?? message.method)
            .join(',') || 'no messages'
        }`
    )
    .join('; ');
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
    rawTranscriptPath: launchedPersona.session.artifacts.rawTranscriptPath,
    normalizedTranscriptPath:
      launchedPersona.session.artifacts.normalizedTranscriptPath,
    channelLogPath: launchedPersona.channelLogPath,
    channelLogLineOffset: launchedPersona.channelLogLineOffset,
    notificationLogPath: launchedPersona.notificationLogPath
  };
}

function readStringField(
  data: Record<string, unknown>,
  key: string,
  artifactsDir: string
): string {
  const value = data[key];
  if (typeof value !== 'string') {
    throw new Error(
      `command/MCP: expected response field ${key} to be a string. Observed ${JSON.stringify(data)}. Artifacts: ${artifactsDir}`
    );
  }
  return value;
}

function readOptionalStringField(
  data: Record<string, unknown>,
  key: string,
  artifactsDir: string
): string | undefined {
  const value = data[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new Error(
      `command/MCP: expected optional response field ${key} to be a string. Observed ${JSON.stringify(data)}. Artifacts: ${artifactsDir}`
    );
  }
  return value;
}

function readOptionalNumberField(
  data: Record<string, unknown>,
  key: string,
  artifactsDir: string
): number | undefined {
  const value = data[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number') {
    throw new Error(
      `command/MCP: expected optional response field ${key} to be a number. Observed ${JSON.stringify(data)}. Artifacts: ${artifactsDir}`
    );
  }
  return value;
}

function readStringArrayField(
  data: Record<string, unknown>,
  key: string,
  artifactsDir: string
): string[] {
  const value = data[key];
  if (
    !Array.isArray(value) ||
    !value.every((entry): entry is string => typeof entry === 'string')
  ) {
    throw new Error(
      `command/MCP: expected response field ${key} to be a string array. Observed ${JSON.stringify(data)}. Artifacts: ${artifactsDir}`
    );
  }
  return value;
}

function normalizeToolName(toolName: string): string {
  return toolName.replace(/^teamem\./, '');
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
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
