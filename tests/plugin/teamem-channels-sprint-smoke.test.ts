import { describe, expect, it } from 'bun:test';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile
} from 'node:fs/promises';
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
  assertTeamemNegativeRecipientEvidence,
  assertTeamemRecipientReceipt,
  createTeamemChannelsTranscriptCheckpoint,
  expectedTeamemSprintChannelsDeliveryMatrix,
  type TeamemChannelsEvidenceExpectation,
  type TeamemChannelsEvidenceLayer,
  type TeamemChannelsTranscriptCheckpoint
} from './teamem-channels-evidence.js';
import { loadCredentials, pickEntry } from '../../src/bridge/credentials.js';
import { createClaudeChannelNotification } from '../../src/channel/payload.js';

const gate = evaluateGate();
const describeLiveChannelsDirect = gate.enabled ? describe : describe.skip;
const repoRoot = process.cwd();
const teamemPluginDir = join(repoRoot, 'plugin');

const LIVE_CHANNELS_DIRECT_TIMEOUT_MS = 360_000;
const INTERACTIVE_READINESS_TIMEOUT_MS = 30_000;
const INTERACTIVE_WAIT_TIMEOUT_MS = 90_000;
const INTERACTIVE_CLOSE_TIMEOUT_MS = 10_000;
const INTERACTIVE_TYPE_DELAY_MS = 20;
const CHANNEL_READINESS_TIMEOUT_MS = 45_000;
const CHANNEL_RECEIPT_TIMEOUT_MS = 90_000;
const CHANNEL_NEGATIVE_RECIPIENT_WINDOW_MS = 10_000;
const CHANNEL_ASSERTION_POLL_MS = 500;

type DiscussionPostEvidence = {
  message_id: string;
  thread_id: string;
  event_id: string;
  delivery_scope: 'direct' | 'space' | 'sprint';
  sprint_id: string | null;
  recipient_principals: string[];
};

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

type SprintLifecycleEvidence = {
  sprint: SprintSummary | null;
  old_context: SprintContext;
  new_context: SprintContext;
  event_ids: string[];
  idempotent: boolean;
  message: string;
  warnings: string[];
};

type CurrentSprintEvidence = {
  context: SprintContext;
  sprint: SprintSummary | null;
  current_members: string[];
};

type PersonaRuntime = TeamemChannelsProfileRuntime & {
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

type ChannelsSmokeCase = {
  readonly caseName: TeamemChannelsSplitCasePlan['splitCase'];
  readonly description: string;
  readonly lockName: string;
  readonly expectedDeliveryScope: DiscussionPostEvidence['delivery_scope'];
  readonly expectedRecipientPrincipals: (
    runtimes: Record<TeamemChannelsPersona, PersonaRuntime>
  ) => string[];
  readonly promptArgs: (input: {
    readonly body: string;
    readonly runtimes: Record<TeamemChannelsPersona, PersonaRuntime>;
  }) => string;
};

const channelsSmokeCases: readonly ChannelsSmokeCase[] = [
  {
    caseName: 'direct',
    description:
      'delivers Alice direct slash-command message across Sprint boundary to Carol through Channels without Alice or Bob echo',
    lockName: 'teamem-channels-sprint-direct',
    expectedDeliveryScope: 'direct',
    expectedRecipientPrincipals: (runtimes) => [
      runtimes.carol.whoami.principal
    ],
    promptArgs: ({ body, runtimes }) =>
      `${runtimes.carol.whoami.principal} -- ${body}`
  },
  {
    caseName: 'star',
    description:
      'delivers Alice * slash-command broadcast to current Sprint member Bob only without Alice or Carol echo',
    lockName: 'teamem-channels-sprint-star',
    expectedDeliveryScope: 'sprint',
    expectedRecipientPrincipals: () => [],
    promptArgs: ({ body }) => `* -- ${body}`
  },
  {
    caseName: 'starstar',
    description:
      'delivers Alice ** slash-command broadcast Space-wide to Bob and Carol without Alice echo',
    lockName: 'teamem-channels-sprint-starstar',
    expectedDeliveryScope: 'space',
    expectedRecipientPrincipals: () => [],
    promptArgs: ({ body }) => `** -- ${body}`
  }
];

describeLiveChannelsDirect(
  `Teamem L5 Sprint Channels live smoke${gate.enabled ? '' : ` (${gate.reason})`}`,
  () => {
    for (const smokeCase of channelsSmokeCases) {
      it(
        smokeCase.description,
        async () => {
          await withLiveInteractiveSmokeLock(smokeCase.lockName, async () => {
            await runChannelsLiveCase(smokeCase);
          });
        },
        LIVE_CHANNELS_DIRECT_TIMEOUT_MS
      );
    }
  }
);

describe('Teamem Sprint Channels smoke evidence waits', () => {
  it('does not accept stale cursor priming before the current session start', () => {
    const expectedStart = 'start session=current-session principal=bob';
    const staleLog = [
      'start session=old-session principal=bob',
      'primed cursor=old-cursor',
      expectedStart
    ].join('\n');

    expect(
      hasChannelReadiness({
        log: staleLog,
        expectedStart,
        phase: 'cursor-primed'
      })
    ).toBeFalse();
  });

  it('accepts cursor priming after the current session start', () => {
    const expectedStart = 'start session=current-session principal=bob';
    const currentLog = [
      'start session=old-session principal=bob',
      'primed cursor=old-cursor',
      expectedStart,
      'primed cursor=current-cursor'
    ].join('\n');

    expect(
      hasChannelReadiness({
        log: currentLog,
        expectedStart,
        phase: 'cursor-primed'
      })
    ).toBeTrue();
  });

  it('accepts a loaded persisted cursor after the current session start', () => {
    const expectedStart = 'start session=current-session principal=bob';
    const currentLog = [
      'start session=old-session principal=bob',
      'loaded cursor=old-cursor',
      expectedStart,
      'loaded cursor=current-cursor'
    ].join('\n');

    expect(
      hasChannelReadiness({
        log: currentLog,
        expectedStart,
        phase: 'cursor-primed'
      })
    ).toBeTrue();
  });

  it('uses channel log offsets so prior default-session starts cannot satisfy readiness', () => {
    const expectedStart = 'start session=default principal=bob';
    const log = [expectedStart, 'primed cursor=old-cursor', expectedStart].join(
      '\n'
    );

    expect(
      hasChannelReadiness({
        log: sliceLogAfterLineOffset(log, 2),
        expectedStart,
        phase: 'cursor-primed'
      })
    ).toBeFalse();
  });

  it('uses the deepest typed recipient receipt layer in timeout messages', () => {
    const expected = fakeReceiptExpectation();
    const lastError = new TeamemChannelsEvidenceError(
      'rendered transcript',
      'expected rendered channel source for bob',
      {
        runId: expected.runId,
        caseName: expected.caseName,
        persona: 'bob',
        marker: expected.marker,
        artifacts: { rawTranscriptPath: '/tmp/bob.raw' }
      }
    );
    const message = formatRecipientReceiptTimeout({
      launchedPersona: fakePersonaSession(),
      expected,
      lastSnapshot: fakeEvidenceSnapshot(),
      lastError
    });

    expect(message.startsWith('rendered transcript: timed out')).toBeTrue();
    expect(message).toContain('channel trace=/tmp/channel-traces.json');
    expect(message).toContain('notification log=/tmp/notifications.log');
    expect(message).toContain('raw transcript=/tmp/raw.txt');
    expect(message).toContain('normalized transcript=/tmp/normalized.txt');
    expect(message).toContain(
      'last error=TeamemChannelsEvidenceError: rendered transcript: expected rendered channel source for bob'
    );
  });

  it('fails fast when Claude reports Channels are unavailable', () => {
    expect(() =>
      assertClaudeChannelsAvailable({
        persona: 'bob',
        transcript: [
          ' --channels ignored (server:teamem-channel)',
          'Channels are not currently available'
        ].join('\n'),
        rawTranscriptPath: '/tmp/bob.raw',
        normalizedTranscriptPath: '/tmp/bob.normalized.txt',
        runSummaryPath: '/tmp/run-summary.json',
        environmentPath: '/tmp/environment.json',
        launcherPlanPath: '/tmp/launcher-plan.txt'
      })
    ).toThrow(
      /Claude Code Channels are not available for bob.*Run summary: \/tmp\/run-summary\.json.*Environment: \/tmp\/environment\.json.*Launcher plan: \/tmp\/launcher-plan\.txt/s
    );
  });

  it('fails fast when Claude reports an unapproved local server Channel entry', () => {
    expect(() =>
      assertClaudeChannelsAvailable({
        persona: 'bob',
        transcript: [
          'Channels (experimental) messages from server:teamem-channel inject directly in this session',
          'server:teamem-channel · server: entries need --dangerously-load-development-channels',
          'server teamem-channel is not on the approved channels allowlist (use --dangerously-load-development-channels)'
        ].join('\n'),
        rawTranscriptPath: '/tmp/bob.raw',
        normalizedTranscriptPath: '/tmp/bob.normalized.txt'
      })
    ).toThrow(/approved Channels allowlist/);
  });

  it('fails fast when Claude says the Channel server is not configured', () => {
    expect(() =>
      assertClaudeChannelsAvailable({
        persona: 'bob',
        transcript:
          'server:teamem-channel · no MCP server configured with that name',
        rawTranscriptPath: '/tmp/bob.raw',
        normalizedTranscriptPath: '/tmp/bob.normalized.txt'
      })
    ).toThrow(/no MCP server was configured for the Channel/);
  });

  it('fails immediately for matched redacted post_message responses', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'teamem-post-evidence-'));
    const traceDir = join(tempRoot, 'mcp-traces');
    const traceRunDir = join(traceDir, 'teamem');
    const body = 'human text marker-run-1-direct-post';
    await mkdir(traceRunDir, { recursive: true });
    await writeFile(
      join(traceRunDir, 'trace.json'),
      `${JSON.stringify(fakePostMessageTrace({ body }))}\n`
    );

    try {
      await expect(
        waitForPostMessageEvidence({
          session: {
            artifacts: {
              dir: tempRoot,
              mcpTraceDir: traceDir,
              runId: 'run-post'
            }
          } as unknown as InteractiveSession,
          body,
          marker: 'marker-run-1-direct-post',
          expectedDeliveryScope: 'direct',
          expectedSprintId: 'sprint-1',
          expectedRecipientPrincipals: ['bob']
        })
      ).rejects.toThrow(
        /command\/MCP post: Expected unredacted post_message response data/
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects Carol-targeted direct Channel evidence leaked to Bob', () => {
    const smokeCase = channelsSmokeCases.find(
      (entry) => entry.caseName === 'direct'
    );
    if (!smokeCase) throw new Error('Missing direct Channels smoke case.');
    const marker = 'teamem-channels-direct-run-1-leaked-carol';
    const post: DiscussionPostEvidence = {
      message_id: 'msg-direct-carol',
      thread_id: 'thr-direct',
      event_id: 'evt-direct-carol',
      delivery_scope: 'direct',
      sprint_id: 'sprint-1',
      recipient_principals: ['carol-principal']
    };
    const expectations = createSprintCaseExpectations({
      runId: 'run-1',
      smokeCase,
      marker,
      post,
      sprint: fakeSprintSummary(),
      senderPrincipal: 'alice-principal',
      alicePrincipal: 'alice-principal',
      bobPrincipal: 'bob-principal',
      carolPrincipal: 'carol-principal'
    });

    expect(expectations.bob.recipientPrincipal).toBe('carol-principal');
    expect(() =>
      assertTeamemNegativeRecipientEvidence({
        persona: 'bob',
        expected: expectations.bob,
        traces: [
          fakeChannelTrace([
            fakeChannelNotificationMessage({
              expected: expectations.bob,
              offsetMs: 25
            })
          ])
        ],
        traceCheckpoint: { offsetMs: 0 }
      })
    ).toThrow(/negative-recipient filtering/);
  });
});

async function runChannelsLiveCase(
  smokeCase: ChannelsSmokeCase
): Promise<void> {
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
        {
          persona: 'alice',
          profileName: profileName('alice'),
          ownership: 'developer'
        },
        {
          persona: 'bob',
          profileName: profileName('bob'),
          ownership: 'developer'
        },
        {
          persona: 'carol',
          profileName: profileName('carol'),
          ownership: 'developer'
        }
      ]
    });

    workspace = await createDemoRepositoryWorkspace({
      teamemSourceRoot: repoRoot
    });
    const activeWorkspace = workspace;
    const baseRunId = createRunId();
    plan = await planTeamemChannelsSplitCase({
      runId: baseRunId,
      splitCase: smokeCase.caseName,
      teamemRoot: repoRoot,
      workspace: activeWorkspace,
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
    const runtimeByPersona = {
      alice: aliceRuntime,
      bob: bobRuntime,
      carol: carolRuntime
    };
    const launched = new Map<TeamemChannelsPersona, PersonaSession>();

    await runTeamemChannelsRecipientReadinessSequence({
      plan,
      runner: async ({ persona, phase }) => {
        if (phase === 'launch') {
          const runtime = requireRuntime(runtimes, persona.persona);
          const launchedPersona = await launchPersona({
            personaPlan: persona,
            runtime,
            workspace: activeWorkspace
          });
          launched.set(persona.persona, launchedPersona);
          sessions.push(launchedPersona.session);
          return;
        }

        const launchedPersona = launched.get(persona.persona);
        if (!launchedPersona) {
          throw new Error(
            `Missing launched ${persona.persona} session for ${phase}.`
          );
        }
        await waitForChannelReadiness({
          launchedPersona,
          phase
        });
      }
    });

    const bob = requireLaunched(launched, 'bob');
    const carol = requireLaunched(launched, 'carol');
    const alice = requireLaunched(launched, 'alice');
    await waitForChannelReadiness({
      launchedPersona: alice,
      phase: 'channel-ready'
    });
    await waitForChannelReadiness({
      launchedPersona: alice,
      phase: 'cursor-primed'
    });

    const sprint = await positionSprintContexts({
      plan,
      alice,
      bob,
      carol,
      workspace: activeWorkspace
    });

    const checkpoints = {
      bob: await createCheckpoint(bob),
      carol: await createCheckpoint(carol),
      alice: await createCheckpoint(alice)
    };
    const marker = `teamem-channels-${smokeCase.caseName}-${plan.runId}-${Date.now()}`;
    const body = `human text ${marker}`;
    const promptArgs = smokeCase.promptArgs({
      body,
      runtimes: runtimeByPersona
    });
    const directPrompt = await createPersonaTester({
      personaPlan: alicePlan,
      env: alice.personaPlan.profileEnv,
      workspace: activeWorkspace
    }).slashCommandPrompt('teamem-discuss', promptArgs);

    await alice.session.submit(directPrompt, {
      delayMs: INTERACTIVE_TYPE_DELAY_MS
    });
    const post = await waitForPostMessageEvidence({
      session: alice.session,
      body,
      marker,
      expectedDeliveryScope: smokeCase.expectedDeliveryScope,
      expectedSprintId:
        smokeCase.expectedDeliveryScope === 'space' ? null : sprint.sprint_id,
      expectedRecipientPrincipals:
        smokeCase.expectedRecipientPrincipals(runtimeByPersona)
    });
    assertNoReadThreadCall({
      traces: post.traces,
      artifactsDir: alice.session.artifacts.dir
    });
    expect(post.evidence.delivery_scope).toBe(smokeCase.expectedDeliveryScope);
    expect(post.evidence.sprint_id).toBe(
      smokeCase.expectedDeliveryScope === 'space' ? null : sprint.sprint_id
    );
    expect(post.evidence.recipient_principals).toEqual(
      smokeCase.expectedRecipientPrincipals(runtimeByPersona)
    );

    const deliveryMatrix = expectedTeamemSprintChannelsDeliveryMatrix(
      smokeCase.caseName
    );
    const expectations = createSprintCaseExpectations({
      runId: plan.runId,
      smokeCase,
      marker,
      post: post.evidence,
      sprint,
      senderPrincipal: aliceRuntime.whoami.principal,
      alicePrincipal: aliceRuntime.whoami.principal,
      bobPrincipal: bobRuntime.whoami.principal,
      carolPrincipal: carolRuntime.whoami.principal
    });

    await Promise.all(
      (['bob', 'carol'] as const).map((persona) =>
        deliveryMatrix[persona]
          ? waitForRecipientReceipt({
              launchedPersona: requireLaunched(launched, persona),
              expected: expectations[persona],
              checkpoint: checkpoints[persona],
              personaPrincipal: runtimeByPersona[persona].whoami.principal
            })
          : assertNegativeRecipient({
              launchedPersona: requireLaunched(launched, persona),
              expected: expectations[persona],
              checkpoint: checkpoints[persona]
            })
      )
    );
    await assertNegativeRecipient({
      launchedPersona: alice,
      expected: expectations.alice,
      checkpoint: checkpoints.alice,
      allowedTranscriptMarkerEchoes: [directPrompt, body]
    });

    await writeCaseEvidence({
      plan,
      alice,
      bob,
      carol,
      aliceRuntime,
      bobRuntime,
      carolRuntime,
      sprint,
      marker,
      body,
      prompt: directPrompt,
      post: post.evidence,
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
          `Preserving failed Channels ${smokeCase.caseName} smoke artifacts at ${cleanup.artifactsDir}${cleanup.failurePathsPath ? ` (failure paths ${cleanup.failurePathsPath})` : ''}`
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
          `Preserving failed Channels ${smokeCase.caseName} demo workspace at ${cleanup.demoWorkspaceLaunchCwd}${cleanup.artifactPath ? ` (report ${cleanup.artifactPath})` : ''}`
        );
      }
    }
  }
}

function createSprintCaseExpectations(input: {
  readonly runId: string;
  readonly smokeCase: ChannelsSmokeCase;
  readonly marker: string;
  readonly post: DiscussionPostEvidence;
  readonly sprint: SprintSummary;
  readonly senderPrincipal: string;
  readonly alicePrincipal: string;
  readonly bobPrincipal: string;
  readonly carolPrincipal: string;
}): Record<TeamemChannelsPersona, TeamemChannelsEvidenceExpectation> {
  return {
    alice: createExpectedReceipt({
      runId: input.runId,
      smokeCase: input.smokeCase,
      marker: input.marker,
      post: input.post,
      sprint: input.sprint,
      senderPrincipal: input.senderPrincipal,
      recipientPrincipal:
        input.smokeCase.caseName === 'direct'
          ? input.carolPrincipal
          : input.alicePrincipal
    }),
    bob: createExpectedReceipt({
      runId: input.runId,
      smokeCase: input.smokeCase,
      marker: input.marker,
      post: input.post,
      sprint: input.sprint,
      senderPrincipal: input.senderPrincipal,
      recipientPrincipal:
        input.smokeCase.caseName === 'direct'
          ? input.carolPrincipal
          : input.bobPrincipal
    }),
    carol: createExpectedReceipt({
      runId: input.runId,
      smokeCase: input.smokeCase,
      marker: input.marker,
      post: input.post,
      sprint: input.sprint,
      senderPrincipal: input.senderPrincipal,
      recipientPrincipal: input.carolPrincipal
    })
  };
}

function createExpectedReceipt(input: {
  readonly runId: string;
  readonly smokeCase: ChannelsSmokeCase;
  readonly marker: string;
  readonly post: DiscussionPostEvidence;
  readonly sprint: SprintSummary;
  readonly senderPrincipal: string;
  readonly recipientPrincipal: string;
}): TeamemChannelsEvidenceExpectation {
  const requiredPayloadText = [
    input.senderPrincipal,
    ...(input.smokeCase.expectedDeliveryScope === 'space'
      ? ['"broadcast_marker":"**"']
      : [input.sprint.sprint_id])
  ];
  const requiredRenderedText =
    input.smokeCase.expectedDeliveryScope === 'space' ? ['-> space'] : [];
  return {
    runId: input.runId,
    caseName: input.smokeCase.caseName,
    marker: input.marker,
    eventId: input.post.event_id,
    threadId: input.post.thread_id,
    messageId: input.post.message_id,
    senderPrincipal: input.senderPrincipal,
    recipientPrincipal: input.recipientPrincipal,
    deliveryScope: input.smokeCase.expectedDeliveryScope,
    requiredPayloadText,
    requiredRenderedText
  };
}

function fakeSprintSummary(): SprintSummary {
  return {
    sprint_id: 'sprint-1',
    slug: 'sprint-one',
    display_name: 'Sprint One',
    goal: 'Prove direct delivery',
    status: 'active'
  };
}

function fakeChannelTrace(messages: readonly McpTraceMessage[]): McpTrace {
  return {
    serverName: 'teamem-channel',
    command: 'teamem-channel',
    args: [],
    startedAt: new Date(0).toISOString(),
    endedAt: new Date(100).toISOString(),
    durationMs: 100,
    exitCode: null,
    signal: null,
    partial: false,
    terminationReason: 'running',
    stdin: '',
    stdout: '',
    stderr: '',
    messages: [...messages],
    artifacts: traceArtifacts('/tmp/teamem-channel-trace.json'),
    placeholderExpansion: {
      supportedPattern: '${VAR}',
      unsupportedShellExpansion: true
    }
  };
}

function fakeChannelNotificationMessage(input: {
  readonly expected: TeamemChannelsEvidenceExpectation;
  readonly offsetMs: number;
}): McpTraceMessage {
  const json = createClaudeChannelNotification({
    event_id: input.expected.eventId,
    event_type: 'discussion_posted',
    principal: input.expected.senderPrincipal,
    delivery_scope: input.expected.deliveryScope,
    recipient_principals: [input.expected.recipientPrincipal],
    payload: {
      thread_id: input.expected.threadId,
      message_id: input.expected.messageId,
      sprint_id: 'sprint-1',
      recipient_principal:
        input.expected.deliveryScope === 'direct'
          ? input.expected.recipientPrincipal
          : null,
      body: `body ${input.expected.marker}`
    }
  });
  return {
    serverName: 'teamem-channel',
    direction: 'server-to-client',
    raw: JSON.stringify(json),
    json,
    method: 'notifications/claude/channel',
    metadata: {
      notification: { method: 'notifications/claude/channel' }
    },
    timestamp: new Date(input.offsetMs).toISOString(),
    offsetMs: input.offsetMs,
    artifacts: traceArtifacts('/tmp/teamem-channel-trace.json')
  };
}

async function positionSprintContexts(input: {
  readonly plan: TeamemChannelsSplitCasePlan;
  readonly alice: PersonaSession;
  readonly bob: PersonaSession;
  readonly carol: PersonaSession;
  readonly workspace: DemoRepositoryWorkspace;
}): Promise<SprintSummary> {
  const displayName = `Sprint Channels ${input.plan.runId}`;
  const goal = `Prove Sprint Channels delivery matrix ${input.plan.runId}`;
  const aliceTester = createPersonaTester({
    personaPlan: input.alice.personaPlan,
    env: input.alice.personaPlan.profileEnv,
    workspace: input.workspace
  });
  const bobTester = createPersonaTester({
    personaPlan: input.bob.personaPlan,
    env: input.bob.personaPlan.profileEnv,
    workspace: input.workspace
  });
  const carolTester = createPersonaTester({
    personaPlan: input.carol.personaPlan,
    env: input.carol.personaPlan.profileEnv,
    workspace: input.workspace
  });

  const createPrompt = await aliceTester.slashCommandPrompt(
    'teamem-sprint',
    `create ${displayName} -- ${goal}`
  );
  const createCheckpoint = await currentMcpTraceOffset(input.alice.session);
  await input.alice.session.submit(createPrompt, {
    delayMs: INTERACTIVE_TYPE_DELAY_MS
  });
  const created = await waitForSprintToolEvidence<SprintLifecycleEvidence>({
    session: input.alice.session,
    toolName: 'create_sprint',
    marker: input.plan.runId,
    traceOffsetMs: createCheckpoint,
    requestMatches: (args) => args.display_name === displayName
  });
  const sprint = requireSprintSummary(
    created.sprint,
    `Expected Alice create_sprint to return created Sprint. Artifacts: ${input.alice.session.artifacts.dir}`
  );
  expect(created.new_context.mode).toBe('sprint');
  expect(created.new_context.sprint?.sprint_id).toBe(sprint.sprint_id);

  const joinPrompt = await bobTester.slashCommandPrompt(
    'teamem-sprint',
    `join ${sprint.slug}`
  );
  const joinCheckpoint = await currentMcpTraceOffset(input.bob.session);
  await input.bob.session.submit(joinPrompt, {
    delayMs: INTERACTIVE_TYPE_DELAY_MS
  });
  const joined = await waitForSprintToolEvidence<SprintLifecycleEvidence>({
    session: input.bob.session,
    toolName: 'join_sprint',
    marker: input.plan.runId,
    traceOffsetMs: joinCheckpoint,
    requestMatches: (args) => args.sprint === sprint.slug
  });
  expect(joined.new_context.mode).toBe('sprint');
  expect(joined.new_context.sprint?.sprint_id).toBe(sprint.sprint_id);

  const leavePrompt = await carolTester.slashCommandPrompt(
    'teamem-sprint',
    'leave'
  );
  const leaveCheckpoint = await currentMcpTraceOffset(input.carol.session);
  await input.carol.session.submit(leavePrompt, {
    delayMs: INTERACTIVE_TYPE_DELAY_MS
  });
  const left = await waitForSprintToolEvidence<SprintLifecycleEvidence>({
    session: input.carol.session,
    toolName: 'leave_sprint',
    marker: input.plan.runId,
    traceOffsetMs: leaveCheckpoint
  });
  expect(left.new_context.mode).toBe('space');

  const aliceCurrent = await readCurrentSprintThroughPlugin({
    tester: aliceTester,
    session: input.alice.session,
    marker: input.plan.runId
  });
  const bobCurrent = await readCurrentSprintThroughPlugin({
    tester: bobTester,
    session: input.bob.session,
    marker: input.plan.runId
  });
  const carolCurrent = await readCurrentSprintThroughPlugin({
    tester: carolTester,
    session: input.carol.session,
    marker: input.plan.runId
  });

  expect(aliceCurrent.context.mode).toBe('sprint');
  expect(aliceCurrent.sprint?.sprint_id).toBe(sprint.sprint_id);
  expect(bobCurrent.context.mode).toBe('sprint');
  expect(bobCurrent.sprint?.sprint_id).toBe(sprint.sprint_id);
  expect(carolCurrent.context.mode).toBe('space');
  expect(carolCurrent.sprint).toBeNull();
  expect(aliceCurrent.current_members).toContain(
    input.alice.runtime.whoami.principal
  );
  expect(aliceCurrent.current_members).toContain(
    input.bob.runtime.whoami.principal
  );
  expect(aliceCurrent.current_members).not.toContain(
    input.carol.runtime.whoami.principal
  );
  expect(bobCurrent.current_members).toEqual(aliceCurrent.current_members);

  return sprint;
}

async function readCurrentSprintThroughPlugin(input: {
  readonly tester: ReturnType<typeof createPersonaTester>;
  readonly session: InteractiveSession;
  readonly marker: string;
}): Promise<CurrentSprintEvidence> {
  const prompt = await input.tester.slashCommandPrompt(
    'teamem-sprint',
    'current'
  );
  const checkpoint = await currentMcpTraceOffset(input.session);
  await input.session.submit(prompt, { delayMs: INTERACTIVE_TYPE_DELAY_MS });
  return waitForSprintToolEvidence<CurrentSprintEvidence>({
    session: input.session,
    toolName: 'get_current_sprint',
    marker: input.marker,
    traceOffsetMs: checkpoint
  });
}

async function waitForSprintToolEvidence<TData>(input: {
  readonly session: InteractiveSession;
  readonly toolName: string;
  readonly marker: string;
  readonly traceOffsetMs: number;
  readonly requestMatches?: (args: Record<string, unknown>) => boolean;
}): Promise<TData> {
  const deadline = Date.now() + INTERACTIVE_WAIT_TIMEOUT_MS;
  let lastTraceSummary = 'no MCP traces observed';
  let matchedRequestWithoutData = false;

  while (Date.now() < deadline) {
    const traces = await readMcpTraces(input.session.artifacts.mcpTraceDir, {
      ignoreTransientErrors: true
    });
    for (const message of successfulToolResponseMessages(
      traces,
      input.toolName
    )) {
      if (message.offsetMs < input.traceOffsetMs) continue;
      const request = findRequestForResponse(traces, message);
      const requestArgs = readRequestArguments(request);
      if (input.requestMatches && !input.requestMatches(requestArgs)) {
        continue;
      }
      const data = extractToolResponseData(message);
      if (data) return data as TData;
      matchedRequestWithoutData = true;
    }
    lastTraceSummary = summarizeTraces(traces);
    await delay(CHANNEL_ASSERTION_POLL_MS);
  }

  throw new Error(
    `command/MCP sprint: timed out waiting for ${input.toolName} response evidence (run id=${input.session.artifacts.runId}, marker=${input.marker}, mcp traces=${input.session.artifacts.mcpTraceDir}, checkpoint offset=${input.traceOffsetMs}, last traces=${lastTraceSummary}${matchedRequestWithoutData ? ', matched request had redacted/missing response data; set CLAUDE_PLUGIN_E2E_ALLOW_UNREDACTED=1' : ''})`
  );
}

async function currentMcpTraceOffset(
  session: InteractiveSession
): Promise<number> {
  return latestTraceOffsetMs(
    await readMcpTraces(session.artifacts.mcpTraceDir, {
      ignoreTransientErrors: true
    })
  );
}

function requireSprintSummary(
  value: SprintSummary | null,
  message: string
): SprintSummary {
  if (!value) throw new Error(message);
  return value;
}

function evaluateGate() {
  return evaluateTeamemChannelsGate(process.env);
}

function profileName(persona: TeamemChannelsPersona): string {
  if (persona === 'alice') return process.env.TEAMEM_ALICE_PROFILE ?? 'alice';
  if (persona === 'bob') return process.env.TEAMEM_BOB_PROFILE ?? 'bob';
  return process.env.TEAMEM_CAROL_PROFILE ?? 'carol';
}

async function inspectRuntime(
  personaPlan: TeamemChannelsPersonaLaunchPlan,
  plan: TeamemChannelsSplitCasePlan
): Promise<PersonaRuntime> {
  const sessionId = `${plan.runId}-${personaPlan.persona}`;
  const runtime = await inspectTeamemChannelsProfileRuntime({
    persona: personaPlan.persona,
    profileName: personaPlan.profileName,
    credentialsPath: requiredEnv(personaPlan.profileEnv, 'TEAMEM_CREDENTIALS'),
    whoami: async (credentialsPath) => {
      const loaded = await loadCredentials(credentialsPath);
      if (!loaded) {
        throw new Error(`Invalid credentials at ${credentialsPath}`);
      }
      const entry = pickEntry({ creds: loaded });
      return (
        await callLiveRuntimeTool<RuntimeWhoamiEvidence>(entry, 'teamem.whoami')
      ).data;
    }
  });
  return { ...runtime, sessionId, channelSessionId: 'default' };
}

async function launchPersona(input: {
  readonly personaPlan: TeamemChannelsPersonaLaunchPlan;
  readonly runtime: PersonaRuntime;
  readonly workspace: DemoRepositoryWorkspace;
}): Promise<PersonaSession> {
  const env = input.personaPlan.profileEnv;
  const personaPlan = { ...input.personaPlan, profileEnv: env };
  const activeChannelLogPath = channelLogPath(env);
  const channelLogLineOffset = countNonEmptyLines(
    await readOptionalFile(activeChannelLogPath)
  );
  await materializeLaunchWorkspaceMcpConfig({
    personaPlan,
    workspace: input.workspace
  });
  const tester = createPersonaTester({
    personaPlan,
    env,
    workspace: input.workspace
  });
  const boot = await tester.boot();
  const session = await tester.launchInteractive({
    useSourcePluginDir: personaPlan.launchOptions.useSourcePluginDir,
    sessionName: personaPlan.launchOptions.sessionName,
    includePermissionMode: personaPlan.launchOptions.includePermissionMode,
    includeRunInstrumentationEnv:
      personaPlan.launchOptions.includeRunInstrumentationEnv,
    useInstrumentedMcpConfig:
      personaPlan.launchOptions.useInstrumentedMcpConfig,
    strictMcpConfig: personaPlan.launchOptions.strictMcpConfig,
    developmentChannels: [...personaPlan.launchOptions.developmentChannels],
    channels: [...personaPlan.launchOptions.channels],
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
      persona: personaPlan.persona,
      transcript: session.rawTranscript(),
      rawTranscriptPath: session.artifacts.rawTranscriptPath,
      normalizedTranscriptPath: session.artifacts.normalizedTranscriptPath,
      runSummaryPath: session.artifacts.summaryPath,
      environmentPath: session.artifacts.environmentPath,
      launcherPlanPath: personaPlan.launcherPlanPath
    });
    assertTeamemChannelsLaunchParity({
      personaPlan,
      boot,
      session,
      launchCwd: input.workspace.demoWorkspaceLaunchCwd
    });
  } catch (error) {
    try {
      await session.close();
    } catch {
      // Preserve the startup/readiness failure; close writes best-effort artifacts.
    }
    throw error;
  }

  return {
    personaPlan,
    runtime: input.runtime,
    boot,
    session,
    notificationLogPath: notificationLogPath(
      env,
      input.runtime.channelSessionId
    ),
    channelLogPath: activeChannelLogPath,
    channelLogLineOffset
  };
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
      '--dangerously-load-development-channelsignored'
    ) &&
    !compactTranscript.includes(
      'server:entriesneed--dangerously-load-development-channels'
    ) &&
    !compactTranscript.includes('approvedchannelsallowlist') &&
    !compactTranscript.includes('nomcpserverconfiguredwiththatname')
  ) {
    return;
  }

  throw new Error(
    `Claude Code Channels are not available for ${input.persona}; live rendered Channels smoke cannot continue. ` +
      `Claude printed that --channels was ignored, the local server entry was not on the approved Channels allowlist, the development-channel authorization was missing or ignored, no MCP server was configured for the Channel, or Channels are not currently available. ` +
      `The current supported local server launch path is --dangerously-load-development-channels server:teamem-channel with --mcp-config and --strict-mcp-config; do not also pass --channels server:teamem-channel for this local source path. ` +
      `Check Claude Code version, account/org policy, managed settings such as channelsEnabled, and Channels preview access for the exact CLAUDE_CONFIG_DIR profile. ` +
      `Run summary: ${input.runSummaryPath ?? '(not captured)'}. ` +
      `Environment: ${input.environmentPath ?? '(not captured)'}. ` +
      `Launcher plan: ${input.launcherPlanPath ?? '(not captured)'}. ` +
      `Raw transcript: ${input.rawTranscriptPath}. Normalized transcript: ${input.normalizedTranscriptPath}`
  );
}

function createPersonaTester(input: {
  readonly personaPlan: TeamemChannelsPersonaLaunchPlan;
  readonly env: NodeJS.ProcessEnv;
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
    env: input.env,
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
    if (
      hasChannelReadiness({
        log,
        expectedStart,
        phase: input.phase
      })
    ) {
      return;
    }
    await delay(CHANNEL_ASSERTION_POLL_MS);
  }

  throw new Error(
    `launch/readiness: timed out waiting for ${input.phase} for ${input.launchedPersona.personaPlan.persona} (run id=${input.launchedPersona.session.artifacts.runId}, marker=n/a, persona=${input.launchedPersona.personaPlan.persona}, channel log=${input.launchedPersona.channelLogPath}, channel log line offset=${input.launchedPersona.channelLogLineOffset})`
  );
}

function hasChannelReadiness(input: {
  readonly log: string;
  readonly expectedStart: string;
  readonly phase: 'channel-ready' | 'cursor-primed';
}): boolean {
  const startIndex = input.log.indexOf(input.expectedStart);
  if (startIndex === -1) {
    return false;
  }
  if (input.phase === 'channel-ready') {
    return true;
  }

  const currentSessionLog = input.log.slice(
    startIndex + input.expectedStart.length
  );
  return (
    currentSessionLog.includes('primed cursor=') ||
    currentSessionLog.includes('loaded cursor=')
  );
}

async function createCheckpoint(
  launchedPersona: PersonaSession
): Promise<TeamemChannelsTranscriptCheckpoint> {
  const traces = await readMcpTraces(
    launchedPersona.session.artifacts.mcpTraceDir,
    {
      ignoreTransientErrors: true
    }
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

async function waitForPostMessageEvidence(input: {
  readonly session: InteractiveSession;
  readonly body: string;
  readonly marker: string;
  readonly expectedDeliveryScope: DiscussionPostEvidence['delivery_scope'];
  readonly expectedSprintId: string | null;
  readonly expectedRecipientPrincipals: readonly string[];
}): Promise<{
  readonly traces: McpTrace[];
  readonly evidence: DiscussionPostEvidence;
}> {
  const deadline = Date.now() + INTERACTIVE_WAIT_TIMEOUT_MS;
  let lastTraceSummary = 'no MCP traces observed';
  let lastError: unknown;

  while (Date.now() < deadline) {
    const traces = await readMcpTraces(input.session.artifacts.mcpTraceDir, {
      ignoreTransientErrors: true
    });
    try {
      const evidence = readPostMessageEvidence({
        traces,
        artifactsDir: input.session.artifacts.dir,
        body: input.body
      });
      if (
        evidence.delivery_scope === input.expectedDeliveryScope &&
        evidence.sprint_id === input.expectedSprintId &&
        arraysEqual(
          evidence.recipient_principals,
          input.expectedRecipientPrincipals
        )
      ) {
        return { traces, evidence };
      }
      throw new PostMessageEvidenceError(
        `matched post_message response for marker ${input.marker} but delivery route did not match expected scope=${input.expectedDeliveryScope} sprint_id=${input.expectedSprintId ?? 'null'} recipients=${JSON.stringify(input.expectedRecipientPrincipals)}. Observed scope=${evidence.delivery_scope} sprint_id=${evidence.sprint_id ?? 'null'} recipients=${JSON.stringify(evidence.recipient_principals)}. Artifacts: ${input.session.artifacts.dir}`,
        { transient: false }
      );
    } catch (error) {
      lastError = error;
      if (!(error instanceof PostMessageEvidenceError) || !error.transient) {
        throw error;
      }
      // Keep polling until Claude has completed the slash command MCP call.
    }
    lastTraceSummary = summarizeTraces(traces);
    await delay(CHANNEL_ASSERTION_POLL_MS);
  }

  throw new Error(
    `command/MCP post: timed out waiting for post_message evidence (run id=${input.session.artifacts.runId}, marker=${input.marker}, persona=alice, mcp traces=${input.session.artifacts.mcpTraceDir}, last traces=${lastTraceSummary}, last error=${formatErrorForMessage(lastError)})`
  );
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
    assertClaudeChannelsAvailable({
      persona: input.launchedPersona.personaPlan.persona,
      transcript: snapshot.normalizedTranscript,
      rawTranscriptPath: snapshot.rawTranscriptPath,
      normalizedTranscriptPath: snapshot.normalizedTranscriptPath,
      runSummaryPath: input.launchedPersona.session.artifacts.summaryPath,
      environmentPath: input.launchedPersona.session.artifacts.environmentPath,
      launcherPlanPath: input.launchedPersona.personaPlan.launcherPlanPath
    });
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

async function assertNegativeRecipient(input: {
  readonly launchedPersona: PersonaSession;
  readonly expected: TeamemChannelsEvidenceExpectation;
  readonly checkpoint: TeamemChannelsTranscriptCheckpoint;
  readonly includeRenderedTranscript?: boolean;
  readonly allowedTranscriptMarkerEchoes?: readonly string[];
}): Promise<void> {
  const deadline = Date.now() + CHANNEL_NEGATIVE_RECIPIENT_WINDOW_MS;

  while (Date.now() < deadline) {
    const snapshot = await writeEvidenceSnapshot(input.launchedPersona);
    const includeRenderedTranscript = input.includeRenderedTranscript !== false;
    assertTeamemNegativeRecipientEvidence({
      persona: input.launchedPersona.personaPlan.persona,
      expected: input.expected,
      traces: snapshot.traces,
      notificationLog: snapshot.notificationLog,
      traceCheckpoint: { offsetMs: input.checkpoint.traceOffsetMs },
      notificationCheckpoint: {
        lineOffset: input.checkpoint.notificationLineOffset
      },
      artifacts: {
        channelTracePath: snapshot.tracePath,
        notificationLogPath: snapshot.notificationLogPath,
        rawTranscriptPath: snapshot.rawTranscriptPath,
        normalizedTranscriptPath: snapshot.normalizedTranscriptPath
      },
      ...(includeRenderedTranscript
        ? {
            rawTranscript: snapshot.rawTranscript,
            normalizedTranscript: snapshot.normalizedTranscript,
            transcriptCheckpoint: input.checkpoint,
            allowedTranscriptMarkerEchoes: input.allowedTranscriptMarkerEchoes
          }
        : {})
    });
    await delay(CHANNEL_ASSERTION_POLL_MS);
  }
}

async function writeEvidenceSnapshot(
  launchedPersona: PersonaSession
): Promise<EvidenceSnapshot> {
  const dir = join(launchedPersona.personaPlan.artifactDir, 'runtime-evidence');
  const prefix = `${launchedPersona.personaPlan.persona}-channels-sprint-${launchedPersona.runtime.sessionId}`;
  const traces = await readMcpTraces(
    launchedPersona.session.artifacts.mcpTraceDir,
    {
      ignoreTransientErrors: true
    }
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

function readPostMessageEvidence(input: {
  readonly traces: readonly McpTrace[];
  readonly artifactsDir: string;
  readonly body: string;
}): DiscussionPostEvidence {
  const messages = successfulToolResponseMessages(input.traces, 'post_message');
  for (const message of messages) {
    const request = findRequestForResponse(input.traces, message);
    const requestArgs = readRequestArguments(request);
    if (requestArgs.body !== input.body) continue;
    const data = extractToolResponseData(message);
    if (!data) {
      throw new PostMessageEvidenceError(
        `Expected unredacted post_message response data for marker body "${input.body}". Set CLAUDE_PLUGIN_E2E_ALLOW_UNREDACTED=1. Artifacts: ${input.artifactsDir}`,
        { transient: false }
      );
    }
    try {
      return {
        message_id: readStringField(data, 'message_id', input.artifactsDir),
        thread_id: readStringField(data, 'thread_id', input.artifactsDir),
        event_id: readStringField(data, 'event_id', input.artifactsDir),
        delivery_scope: readDeliveryScope(data, input.artifactsDir),
        sprint_id: readNullableStringField(
          data,
          'sprint_id',
          input.artifactsDir
        ),
        recipient_principals: readStringArrayField(
          data,
          'recipient_principals',
          input.artifactsDir
        )
      };
    } catch (error) {
      throw new PostMessageEvidenceError(formatErrorForMessage(error), {
        transient: false
      });
    }
  }

  throw new PostMessageEvidenceError(
    `Expected post_message MCP evidence for body "${input.body}". Artifacts: ${input.artifactsDir}`,
    { transient: true }
  );
}

class PostMessageEvidenceError extends Error {
  readonly transient: boolean;

  constructor(
    message: string,
    options: {
      readonly transient: boolean;
    }
  ) {
    super(`command/MCP post: ${message}`);
    this.name = 'PostMessageEvidenceError';
    this.transient = options.transient;
  }
}

function formatRecipientReceiptTimeout(input: {
  readonly launchedPersona: PersonaSession;
  readonly expected: TeamemChannelsEvidenceExpectation;
  readonly lastSnapshot?: EvidenceSnapshot;
  readonly lastError: unknown;
}): string {
  return `${recipientReceiptTimeoutLayer(input.lastError)}: timed out waiting for recipient receipt (run id=${input.expected.runId}, marker=${input.expected.marker}, persona=${input.launchedPersona.personaPlan.persona}, channel trace=${input.lastSnapshot?.tracePath ?? input.launchedPersona.session.artifacts.mcpTraceDir}, notification log=${input.lastSnapshot?.notificationLogPath ?? input.launchedPersona.notificationLogPath}, raw transcript=${input.lastSnapshot?.rawTranscriptPath ?? input.launchedPersona.session.artifacts.rawTranscriptPath}, normalized transcript=${input.lastSnapshot?.normalizedTranscriptPath ?? input.launchedPersona.session.artifacts.normalizedTranscriptPath}, last error=${formatErrorForMessage(input.lastError)})`;
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
  expectedToolName?: string
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

      return expectedToolName
        ? normalizeToolName(message.metadata.toolName) === expectedToolName
        : true;
    });
}

function assertNoReadThreadCall(input: {
  readonly traces: readonly McpTrace[];
  readonly artifactsDir: string;
}): void {
  const readThreadCall = input.traces
    .filter((trace) => trace.serverName === 'teamem')
    .flatMap((trace) => trace.messages)
    .find(
      (message) =>
        message.direction === 'client-to-server' &&
        message.method === 'tools/call' &&
        normalizeToolName(String(message.metadata?.toolName ?? '')) ===
          'read_thread'
    );
  if (readThreadCall) {
    throw new Error(
      `command/MCP post: read_thread must not be used by Channels Sprint smoke. Artifacts: ${input.artifactsDir}`
    );
  }
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
  if (isRecord(structuredContent?.data)) {
    return structuredContent.data;
  }

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

async function writeCaseEvidence(input: {
  readonly plan: TeamemChannelsSplitCasePlan;
  readonly alice: PersonaSession;
  readonly bob: PersonaSession;
  readonly carol: PersonaSession;
  readonly aliceRuntime: PersonaRuntime;
  readonly bobRuntime: PersonaRuntime;
  readonly carolRuntime: PersonaRuntime;
  readonly sprint: SprintSummary;
  readonly marker: string;
  readonly body: string;
  readonly prompt: string;
  readonly post: DiscussionPostEvidence;
  readonly expected: Record<
    TeamemChannelsPersona,
    TeamemChannelsEvidenceExpectation
  >;
}): Promise<void> {
  await writeFile(
    join(input.plan.multiProfilePlan.artifactsDir, 'channels-live-run.json'),
    `${JSON.stringify(
      {
        runId: input.plan.runId,
        caseName: input.plan.splitCase,
        marker: input.marker,
        body: input.body,
        prompt: input.prompt,
        sprint: input.sprint,
        post: input.post,
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

async function assertPersonaArtifacts(input: PersonaSession): Promise<void> {
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

function arraysEqual(
  left: readonly string[],
  right: readonly string[]
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function fakeReceiptExpectation(): TeamemChannelsEvidenceExpectation {
  return {
    runId: 'run-1',
    caseName: 'direct',
    marker: 'marker-run-1-direct',
    eventId: 'evt-1',
    threadId: 'thr-1',
    messageId: 'msg-1',
    senderPrincipal: 'alice',
    recipientPrincipal: 'bob',
    deliveryScope: 'direct'
  };
}

function fakePersonaSession(): PersonaSession {
  return {
    personaPlan: { persona: 'bob' },
    runtime: { sessionId: 'run-1-bob', channelSessionId: 'default' },
    session: {
      artifacts: {
        mcpTraceDir: '/tmp/mcp-traces',
        rawTranscriptPath: '/tmp/session.raw',
        normalizedTranscriptPath: '/tmp/session.normalized.txt'
      }
    },
    notificationLogPath: '/tmp/session-notifications.log',
    channelLogLineOffset: 0
  } as unknown as PersonaSession;
}

function fakeEvidenceSnapshot(): EvidenceSnapshot {
  return {
    tracePath: '/tmp/channel-traces.json',
    notificationLogPath: '/tmp/notifications.log',
    rawTranscriptPath: '/tmp/raw.txt',
    normalizedTranscriptPath: '/tmp/normalized.txt',
    traces: [],
    notificationLog: '',
    rawTranscript: '',
    normalizedTranscript: ''
  };
}

function fakePostMessageTrace(input: { readonly body: string }): McpTrace {
  const tracePath = '/tmp/teamem-post-message/trace.json';
  const request = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'teamem.post_message',
      arguments: { body: input.body }
    }
  };
  const response = {
    jsonrpc: '2.0',
    id: 1,
    result: {
      content: [{ type: 'text', text: '[redacted]' }]
    }
  };
  return {
    serverName: 'teamem',
    command: 'bun',
    args: ['run', 'src/bridge/index.ts'],
    startedAt: '2026-06-04T00:00:00.000Z',
    endedAt: '2026-06-04T00:00:01.000Z',
    durationMs: 1000,
    exitCode: null,
    signal: null,
    partial: false,
    terminationReason: 'test',
    stdin: '',
    stdout: '',
    stderr: '',
    messages: [
      {
        serverName: 'teamem',
        direction: 'client-to-server',
        raw: JSON.stringify(request),
        json: request,
        method: 'tools/call',
        metadata: { toolName: 'teamem.post_message' },
        timestamp: '2026-06-04T00:00:00.100Z',
        offsetMs: 100,
        artifacts: traceArtifacts(tracePath)
      },
      {
        serverName: 'teamem',
        direction: 'server-to-client',
        raw: JSON.stringify(response),
        json: response,
        metadata: {
          toolName: 'teamem.post_message',
          response: {
            ok: true,
            hasResult: true,
            hasError: false,
            isError: false,
            resultKeys: ['content'],
            structuredContentKeys: [],
            contentTextJsonKeys: [],
            contentTextJsonDataKeys: [],
            errorKeys: []
          }
        },
        timestamp: '2026-06-04T00:00:00.200Z',
        offsetMs: 200,
        artifacts: traceArtifacts(tracePath)
      }
    ],
    artifacts: traceArtifacts(tracePath),
    placeholderExpansion: {
      supportedPattern: '${VAR}',
      unsupportedShellExpansion: true
    }
  };
}

function traceArtifacts(tracePath: string) {
  return {
    tracePath,
    stdinPath: `${tracePath}.stdin`,
    stdoutPath: `${tracePath}.stdout`,
    stderrPath: `${tracePath}.stderr`
  };
}

async function readOptionalFile(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return '';
  }
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

function readStringField(
  data: Record<string, unknown>,
  key: string,
  artifactsDir: string
): string {
  const value = data[key];
  if (typeof value !== 'string') {
    throw new Error(
      `Expected response field ${key} to be a string. Observed ${JSON.stringify(data)}. Artifacts: ${artifactsDir}`
    );
  }
  return value;
}

function readNullableStringField(
  data: Record<string, unknown>,
  key: string,
  artifactsDir: string
): string | null {
  const value = data[key];
  if (value !== null && typeof value !== 'string') {
    throw new Error(
      `Expected response field ${key} to be a string or null. Observed ${JSON.stringify(data)}. Artifacts: ${artifactsDir}`
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
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(
      `Expected response field ${key} to be a string array. Observed ${JSON.stringify(data)}. Artifacts: ${artifactsDir}`
    );
  }
  return value;
}

function readDeliveryScope(
  data: Record<string, unknown>,
  artifactsDir: string
): DiscussionPostEvidence['delivery_scope'] {
  const value = data.delivery_scope;
  if (value !== 'direct' && value !== 'sprint' && value !== 'space') {
    throw new Error(
      `Expected delivery_scope to be direct, sprint, or space. Observed ${JSON.stringify(data)}. Artifacts: ${artifactsDir}`
    );
  }
  return value;
}

function normalizeToolName(toolName: string): string {
  return toolName.replace(/^teamem\./, '');
}

function requiredEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`Expected ${key} for Channels live smoke.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function formatErrorForMessage(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

function createRunId(): string {
  return `channels-live-${new Date().toISOString().replace(/[:.]/g, '-')}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
