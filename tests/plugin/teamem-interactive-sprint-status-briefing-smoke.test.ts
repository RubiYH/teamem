import { describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  chmod,
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
  normalizeTranscript,
  readHookTraces,
  readMcpTraces,
  type BootResult,
  type HookTrace,
  type InteractiveSession,
  type InteractiveSyntheticEvent,
  type McpTrace,
  type McpTraceMessage,
  type RunArtifacts
} from '../../plugin-e2e-module/src/index.js';
import type { CredentialEntry } from '../../src/bridge/credentials.js';
import {
  assertNoTeamemChannelMcpTrace,
  assertTraceArtifactsExist,
  callLiveRuntimeTool,
  createLiveRuntimeEnv,
  expectOnlyTeamemMcpIsProxied,
  inspectRuntimePrerequisite,
  TEAMEM_MCP_INSTRUMENTATION_OPTIONS,
  withLiveInteractiveSmokeLock
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

type ClaimData = {
  claim_id: string;
  expires_at: string | null;
};

type ListClaimsData = {
  claims: Array<{
    claim_id: string;
    principal: string;
    path: string;
    status: string;
    sprint_id: string | null;
    context: 'space' | 'sprint';
  }>;
};

type BriefingData = {
  current_context: {
    mode: 'space' | 'sprint';
    sprint: (SprintSummary & { current_members: string[] }) | null;
    routing_reasons: string[];
  };
  current_plan: {
    title: string;
    summary: string;
    source_decision_id: string;
  } | null;
  active_claims: Array<{
    principal: string;
    scope: Record<string, unknown>;
    intent: string;
  }>;
  recent_decisions: Array<{
    id: string;
    title: string;
    summary: string;
    kind: string;
  }>;
  active_risks: {
    open_blockers: Array<{
      blocker_id: string;
      summary: string;
      owner_principal: string;
    }>;
    standing_conflicts: unknown[];
  };
  recent_progress: Array<{
    principal: string;
    task_id: string;
    what: string;
  }>;
  recent_findings: Array<{
    finding_id: string;
    kind: 'finding' | 'gotcha';
    summary: string;
    tags: string[];
  }>;
  recent_notifications: Array<Record<string, unknown>>;
  outside_current_context: {
    active_claims: Array<{
      principal: string;
      scope: Record<string, unknown>;
      intent: string;
    }>;
  };
  recent_joins: Array<{
    member_name: string;
  }>;
  meta: {
    cross_context_overlap_awareness?: {
      overlapping_claims: number;
    };
  };
};

type ToolEnvelope<TData> = {
  ok: true;
  data: TData;
};

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

type SeededSprintEvidence = {
  claim: ClaimData;
  claimIntent: string;
  planTitle: string;
  planSummary: string;
  decisionTitle: string;
  blockerSummary: string;
  gotchaSummary: string;
  progressIntent: string;
  targetPath: string;
};

type SeededNonCurrentSprintEvidence = SeededSprintEvidence & {
  sprint: SprintSummary;
  displayName: string;
  goal: string;
};

type StatusCommandEvidence = {
  traces: McpTrace[];
  responsesByTool: Map<string, McpTraceMessage[]>;
};

const liveGateEnabled = process.env.TEAMEM_CLAUDE_PLUGIN_E2E === '1';
const interactiveGateEnabled =
  process.env.TEAMEM_CLAUDE_PLUGIN_INTERACTIVE_E2E === '1';
const statefulGateEnabled =
  process.env.TEAMEM_CLAUDE_PLUGIN_STATEFUL_E2E === '1';
const liveInteractiveStatefulGateEnabled =
  liveGateEnabled && interactiveGateEnabled && statefulGateEnabled;
const unredactedArtifactsEnabled =
  process.env.CLAUDE_PLUGIN_E2E_ALLOW_UNREDACTED === '1';
const interactivePermissionMode = liveInteractiveStatefulGateEnabled
  ? resolveTeamemInteractivePermissionMode(
      process.env,
      DEFAULT_TEAMEM_INTERACTIVE_SCRIPT_PERMISSION_MODE
    )
  : DEFAULT_TEAMEM_INTERACTIVE_PERMISSION_MODE;
const runtimePrerequisite = await inspectRuntimePrerequisite({
  liveGateEnabled: liveInteractiveStatefulGateEnabled,
  gateReason: formatInteractiveStatefulGateReason()
});
const describeLiveInteractiveStateful = liveInteractiveStatefulGateEnabled
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
const canonicalToolPrefix = 'mcp__teamem__teamem_';
const pluginScopedToolPrefix = 'mcp__plugin_teamem_teamem__teamem_';
const sprintToolNames = ['create_sprint', 'leave_sprint'] as const;
const statusToolNames = [
  'whoami',
  'get_current_sprint',
  'list_claims',
  'get_briefing'
] as const;
const allowedTeamemToolNames = [
  ...sprintToolNames,
  ...statusToolNames
] as const;
const briefingSectionKeys = [
  'current_context',
  'current_plan',
  'active_claims',
  'recent_decisions',
  'active_risks',
  'recent_progress',
  'recent_findings',
  'outside_current_context',
  'meta'
] as const;

describeLiveInteractiveStateful(
  `Teamem interactive Sprint status and briefing live smoke${liveInteractiveStatefulGateEnabled ? '' : ` (${formatInteractiveStatefulGateReason()})`}`,
  () => {
    it(
      'proves Sprint and Space status/briefing views through the Claude Code TTY',
      async () => {
        if (!runtimePrerequisite.ok) {
          throw new Error(runtimePrerequisite.reason);
        }
        if (!unredactedArtifactsEnabled) {
          throw new Error(
            'set CLAUDE_PLUGIN_E2E_ALLOW_UNREDACTED=1 to run Sprint status/briefing smoke; this smoke parses MCP response artifacts to prove Sprint and Space context output'
          );
        }

        await withLiveInteractiveSmokeLock(
          'teamem-interactive-sprint-status-briefing-smoke',
          async () => {
            const runId = createRunId();
            const displayName = `Sprint status briefing ${runId}`;
            const goal = `Prove Sprint-aware status and briefing smoke ${runId}`;
            let workspace: DemoRepositoryWorkspace | undefined;
            const artifactsDir = await mkdtemp(
              join(tmpdir(), 'teamem-interactive-sprint-status-artifacts-')
            );
            let session: InteractiveSession | undefined;
            let createdSprint: SprintSummary | undefined;
            let seededEvidence: SeededSprintEvidence | undefined;
            let nonCurrentSprintEvidence:
              | SeededNonCurrentSprintEvidence
              | undefined;
            let remoteCleanupAttempted = false;
            let success = false;

            try {
              workspace = await createDemoRepositoryWorkspace({
                teamemSourceRoot: repoRoot
              });
              const isolatedProfile = await createIsolatedSprintProfile({
                artifactsDir,
                entry: runtimePrerequisite.selectedEntry
              });
              const tester = createClaudePluginTester({
                pluginDir: teamemPluginDir,
                cwd: workspace.demoWorkspaceLaunchCwd,
                artifactsDir,
                cleanup: 'never',
                mcp: TEAMEM_MCP_INSTRUMENTATION_OPTIONS,
                env: createLiveSprintRuntimeEnv({
                  profile: isolatedProfile,
                  spaceId: runtimePrerequisite.selectedEntry.space_id
                }),
                redaction: { mode: 'off' },
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
              await leaveCurrentSprintIfAny(runtimePrerequisite.selectedEntry);

              const prompts = {
                create: await tester.slashCommandPrompt(
                  'sprint',
                  `create ${displayName} -- ${goal}`
                ),
                sprintStatus: await tester.slashCommandPrompt('status'),
                sprintBriefing: await tester.slashCommandPrompt(
                  'briefing',
                  '2200'
                ),
                leave: await tester.slashCommandPrompt('sprint', 'leave'),
                spaceStatus: await tester.slashCommandPrompt('status'),
                spaceBriefing: await tester.slashCommandPrompt(
                  'briefing',
                  '2200'
                )
              };
              expect(prompts.create).toStartWith('/teamem:sprint create ');
              expect(prompts.sprintStatus).toBe('/teamem:status');
              expect(prompts.sprintBriefing).toBe('/teamem:briefing 2200');
              expect(prompts.leave).toBe('/teamem:sprint leave');

              session = await tester.launchInteractive({
                permissionMode: interactivePermissionMode,
                useInstrumentedMcpConfig: true,
                strictMcpConfig: true,
                allowedTools: [
                  'Skill(teamem:sprint)',
                  'Skill(teamem:status)',
                  'Skill(teamem:briefing)',
                  'Bash(${CLAUDE_PLUGIN_ROOT}/bin/teamem-flag:*)',
                  ...allowedTeamemToolNames.map(
                    (toolName) => `${canonicalToolPrefix}${toolName}`
                  ),
                  ...allowedTeamemToolNames.map(
                    (toolName) => `${pluginScopedToolPrefix}${toolName}`
                  )
                ],
                disallowedTools: [
                  'ToolSearch',
                  'mcp__plugin_teamem_channel__*',
                  'mcp__teamem-channel__*',
                  `${pluginScopedToolPrefix}claim_scope`,
                  `${pluginScopedToolPrefix}release_scope`,
                  `${pluginScopedToolPrefix}force_release`,
                  `${pluginScopedToolPrefix}post_message`,
                  `${pluginScopedToolPrefix}record_decision`,
                  `${pluginScopedToolPrefix}share_finding`,
                  `${pluginScopedToolPrefix}raise_blocker`,
                  `${pluginScopedToolPrefix}agent_focus_changed`,
                  `${pluginScopedToolPrefix}list_sprints`,
                  `${pluginScopedToolPrefix}archive_sprint`,
                  `${pluginScopedToolPrefix}reopen_sprint`,
                  `${pluginScopedToolPrefix}get_sprint_history`
                ],
                readiness: isClaudeInteractiveReady,
                readinessTimeoutMs: INTERACTIVE_READINESS_TIMEOUT_MS,
                waitTimeoutMs: INTERACTIVE_WAIT_TIMEOUT_MS,
                closeTimeoutMs: INTERACTIVE_CLOSE_TIMEOUT_MS
              });
              expectInteractiveLaunchArgs({
                args: session.command.args,
                permissionMode: interactivePermissionMode,
                boot,
                artifacts: session.artifacts
              });

              await delay(INTERACTIVE_STARTUP_SETTLE_MS);

              const createResponse =
                await submitAndWaitForToolResponse<SprintLifecycleData>({
                  session,
                  prompt: prompts.create,
                  toolName: 'create_sprint'
                });
              createdSprint = createResponse.sprint ?? undefined;
              if (!createdSprint) {
                throw new Error(
                  `Expected create_sprint response to include created Sprint. ${artifactPaths(session.artifacts, workspace)}`
                );
              }
              expect(createResponse.old_context.mode).toBe('space');
              expect(createResponse.new_context.mode).toBe('sprint');
              expect(createResponse.message).toContain(createdSprint.slug);

              seededEvidence = await seedSprintEvidence({
                sprint: createdSprint,
                runId,
                workspace
              });

              const sprintStatusBefore = countSuccessfulToolResponses(
                await readMcpTraces(session.artifacts.mcpTraceDir, {
                  ignoreTransientErrors: true
                })
              );
              const sprintStatusOutputCheckpoint =
                commandOutputCheckpoint(session);
              await session.submit(prompts.sprintStatus, {
                delayMs: INTERACTIVE_TYPE_DELAY_MS
              });
              const sprintStatusTraces = await waitForStatusEvidence({
                session,
                before: sprintStatusBefore,
                expectedListClaimsResponses: 2
              });
              assertStatusMcpEvidence({
                status: sprintStatusTraces,
                artifactsDir: session.artifacts.dir,
                expectedContext: 'sprint',
                sprint: createdSprint,
                evidence: seededEvidence
              });
              await assertSprintStatusRenderedOutput({
                session,
                checkpoint: sprintStatusOutputCheckpoint,
                sprint: createdSprint,
                evidence: seededEvidence
              });

              nonCurrentSprintEvidence = await seedNonCurrentSprintEvidence({
                currentSprint: createdSprint,
                runId,
                workspace
              });

              const sprintBriefingBefore = countSuccessfulToolResponses(
                await readMcpTraces(session.artifacts.mcpTraceDir, {
                  ignoreTransientErrors: true
                }),
                'get_briefing'
              );
              const sprintBriefingOutputCheckpoint =
                commandOutputCheckpoint(session);
              await session.submit(prompts.sprintBriefing, {
                delayMs: INTERACTIVE_TYPE_DELAY_MS
              });
              const sprintBriefingMessage = await waitForBriefingEvidence({
                session,
                before: sprintBriefingBefore
              });
              const sprintBriefing = parseToolEnvelope<BriefingData>(
                sprintBriefingMessage
              ).data;
              assertSprintBriefing({
                briefing: sprintBriefing,
                sprint: createdSprint,
                evidence: seededEvidence,
                nonCurrentEvidence: nonCurrentSprintEvidence,
                artifactsDir: session.artifacts.dir
              });
              const sprintBriefingOutput = await waitForCommandOutput({
                session,
                checkpoint: sprintBriefingOutputCheckpoint,
                expectedText: [
                  seededEvidence.planTitle,
                  seededEvidence.decisionTitle,
                  seededEvidence.blockerSummary,
                  seededEvidence.progressIntent
                ],
                label: 'Sprint briefing output'
              });
              assertNonCurrentSprintSentinelsExcluded({
                text: sprintBriefingOutput,
                evidence: nonCurrentSprintEvidence,
                label: 'Sprint briefing rendered output'
              });

              const leaveResponse =
                await submitAndWaitForToolResponse<SprintLifecycleData>({
                  session,
                  prompt: prompts.leave,
                  toolName: 'leave_sprint'
                });
              expect(leaveResponse.old_context.mode).toBe('sprint');
              expect(leaveResponse.new_context.mode).toBe('space');
              expect(leaveResponse.message).toContain(createdSprint.slug);

              const spaceStatusBefore = countSuccessfulToolResponses(
                await readMcpTraces(session.artifacts.mcpTraceDir, {
                  ignoreTransientErrors: true
                })
              );
              const spaceStatusOutputCheckpoint =
                commandOutputCheckpoint(session);
              await session.submit(prompts.spaceStatus, {
                delayMs: INTERACTIVE_TYPE_DELAY_MS
              });
              const spaceStatusTraces = await waitForStatusEvidence({
                session,
                before: spaceStatusBefore,
                expectedListClaimsResponses: 1
              });
              assertStatusMcpEvidence({
                status: spaceStatusTraces,
                artifactsDir: session.artifacts.dir,
                expectedContext: 'space',
                sprint: createdSprint,
                evidence: seededEvidence
              });
              await assertSpaceStatusRenderedOutput({
                session,
                checkpoint: spaceStatusOutputCheckpoint
              });

              const spaceBriefingBefore = countSuccessfulToolResponses(
                await readMcpTraces(session.artifacts.mcpTraceDir, {
                  ignoreTransientErrors: true
                }),
                'get_briefing'
              );
              await session.submit(prompts.spaceBriefing, {
                delayMs: INTERACTIVE_TYPE_DELAY_MS
              });
              const spaceBriefingMessage = await waitForBriefingEvidence({
                session,
                before: spaceBriefingBefore
              });
              const spaceBriefing =
                parseToolEnvelope<BriefingData>(spaceBriefingMessage).data;
              assertSpaceBriefing({
                briefing: spaceBriefing,
                sprint: createdSprint,
                evidence: seededEvidence,
                artifactsDir: session.artifacts.dir
              });

              assertLiveInteractiveInputEvidence(session, prompts);
              assertTranscriptOutputEvidence({
                session,
                prompts,
                sprint: createdSprint,
                evidence: seededEvidence
              });
              await session.close();

              await assertInteractiveArtifactsExist(session);
              const [hookTraces, mcpTraces] = await Promise.all([
                readHookTraces(session.artifacts.hookTraceDir),
                readMcpTraces(session.artifacts.mcpTraceDir)
              ]);
              await assertSessionStartEvidence(hookTraces, isolatedProfile);
              assertNoTeamemChannelMcpTrace(mcpTraces);
              assertObservedMcpToolSequence({
                traces: mcpTraces,
                artifactsDir: session.artifacts.dir,
                sprint: createdSprint,
                evidence: seededEvidence,
                nonCurrentEvidence: nonCurrentSprintEvidence
              });
              await assertTeamemMcpTraceEvidence(mcpTraces, isolatedProfile);
              await assertLaunchUsesIsolatedState({
                artifacts: session.artifacts,
                profile: isolatedProfile
              });

              await cleanupRemoteSprint(createdSprint, seededEvidence.claim);
              await cleanupRemoteSprint(
                nonCurrentSprintEvidence.sprint,
                nonCurrentSprintEvidence.claim
              );
              remoteCleanupAttempted = true;
              success = true;
            } catch (err) {
              throw withArtifactError(err, {
                artifactsDir,
                workspace,
                runId
              });
            } finally {
              if (createdSprint && !remoteCleanupAttempted) {
                try {
                  await cleanupRemoteSprint(
                    createdSprint,
                    seededEvidence?.claim
                  );
                  if (nonCurrentSprintEvidence) {
                    await cleanupRemoteSprint(
                      nonCurrentSprintEvidence.sprint,
                      nonCurrentSprintEvidence.claim
                    );
                  }
                } catch (err) {
                  console.error(
                    `Failed to cleanup Sprint ${createdSprint.slug} for run id ${runId}: ${formatError(err)}`
                  );
                }
              }

              if (!success && session) {
                try {
                  await session.close();
                } catch (err) {
                  console.error(
                    `Failed to close failed Sprint status/briefing smoke session for run id ${runId}: ${formatError(err)}`
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
                    `Preserving failed Sprint status/briefing demo workspace at ${cleanup.demoWorkspaceLaunchCwd}${cleanup.artifactPath ? ` (report ${cleanup.artifactPath})` : ''} for run id ${runId}`
                  );
                }
              }

              if (success) {
                await rm(artifactsDir, { recursive: true, force: true });
              } else {
                console.error(
                  `Preserving failed Sprint status/briefing smoke artifacts at ${artifactsDir} for run id ${runId}`
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

  return `set TEAMEM_CLAUDE_PLUGIN_E2E=1, TEAMEM_CLAUDE_PLUGIN_INTERACTIVE_E2E=1, TEAMEM_CLAUDE_PLUGIN_STATEFUL_E2E=1, and CLAUDE_PLUGIN_E2E_ALLOW_UNREDACTED=1 to run stateful interactive Sprint status/briefing smoke${
    missingGates.length > 0 ? `; missing ${missingGates.join(', ')}` : ''
  }`;
}

function createRunId(): string {
  return `${Date.now().toString(36)}${randomUUID().replaceAll('-', '').slice(0, 8)}`;
}

type IsolatedSprintProfile = {
  claudeConfigDir: string;
  pluginCacheDir: string;
  pluginDataDir: string;
  credentialsPath: string;
  reportPath: string;
};

async function createIsolatedSprintProfile(input: {
  artifactsDir: string;
  entry: CredentialEntry;
}): Promise<IsolatedSprintProfile> {
  const profileRoot = join(input.artifactsDir, 'isolated-profile');
  const claudeConfigDir = join(profileRoot, 'claude');
  const pluginCacheDir = join(profileRoot, 'claude-plugin-cache');
  const pluginDataDir = join(profileRoot, 'plugin-data', 'teamem');
  const credentialsPath = join(profileRoot, 'credentials.json');
  const reportPath = join(input.artifactsDir, 'isolated-profile.json');
  await mkdir(pluginDataDir, { recursive: true });
  await mkdir(claudeConfigDir, { recursive: true });
  await mkdir(pluginCacheDir, { recursive: true });
  await writeFile(
    credentialsPath,
    `${JSON.stringify(
      {
        version: 1,
        default_space_id: input.entry.space_id,
        spaces: {
          [input.entry.space_id]: input.entry
        }
      },
      null,
      2
    )}\n`
  );
  await chmod(credentialsPath, 0o600);
  await writeFile(
    reportPath,
    `${JSON.stringify(
      {
        claudeConfigDir,
        pluginCacheDir,
        pluginDataDir,
        credentialsPath,
        spaceId: input.entry.space_id,
        memberName: input.entry.member_name
      },
      null,
      2
    )}\n`
  );

  return {
    claudeConfigDir,
    pluginCacheDir,
    pluginDataDir,
    credentialsPath,
    reportPath
  };
}

function createLiveSprintRuntimeEnv(input: {
  profile: IsolatedSprintProfile;
  spaceId: string;
}): NodeJS.ProcessEnv {
  return {
    ...createLiveRuntimeEnv(),
    CLAUDE_CODE_PLUGIN_CACHE_DIR: input.profile.pluginCacheDir,
    CLAUDE_CODE_MCP_ALLOWLIST_ENV: '1',
    CLAUDE_PLUGIN_DATA: input.profile.pluginDataDir,
    CLAUDE_PLUGIN_ROOT: teamemPluginDir,
    CLAUDE_PLUGIN_OPTION_DEFAULT_SPACE: input.spaceId,
    TEAMEM_CREDENTIALS: input.profile.credentialsPath,
    TEAMEM_DATA: input.profile.pluginDataDir,
    TEAMEM_SPACE: input.spaceId,
    TEAMEM_SPACE_ID: input.spaceId,
    TEAMEM_DEFAULT_SPACE: input.spaceId,
    TEAMEM_CLAUDE_LAUNCH_INTENT: 'activate',
    TEAMEM_CLAUDE_LAUNCH_SPACE: input.spaceId
  };
}

function expectInteractiveLaunchArgs(input: {
  args: string[];
  permissionMode: string;
  boot: BootResult;
  artifacts: RunArtifacts;
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

  const mcpConfigFlagIndex = input.args.indexOf('--mcp-config');
  expect(mcpConfigFlagIndex).toBeGreaterThanOrEqual(0);
  const sourceMcpPath = input.boot.instrumentedPlugin.mcpPath;
  expect(sourceMcpPath).toBeDefined();
  if (!sourceMcpPath) {
    throw new Error('Expected instrumented Teamem MCP config path');
  }
  expect(input.args[mcpConfigFlagIndex + 1]).toBe(
    join(input.artifacts.dir, 'mcp-config.json')
  );
  expect(input.args).toContain('--strict-mcp-config');
}

function isClaudeInteractiveReady(transcript: string): boolean {
  const normalized = normalizeTranscript(transcript);

  return (
    /(^|\n)[^\S\n]*[>›❯][^\S\n]*(?=\n|$)/.test(normalized) ||
    /\btry ["'].*["']/i.test(normalized)
  );
}

async function seedSprintEvidence(input: {
  sprint: SprintSummary;
  runId: string;
  workspace: DemoRepositoryWorkspace;
}): Promise<SeededSprintEvidence> {
  if (!runtimePrerequisite.ok) {
    throw new Error(runtimePrerequisite.reason);
  }

  const targetPath = `src/sprint-status-briefing-proof-${input.runId}.txt`;
  const planTitle = `Sprint proof plan ${input.runId}`;
  const planSummary = `Plan evidence for ${input.sprint.slug} ${input.runId}`;
  const decisionTitle = `Sprint proof decision ${input.runId}`;
  const blockerSummary = `Sprint proof blocker ${input.runId}`;
  const gotchaSummary = `Sprint proof gotcha ${input.runId}`;
  const progressIntent = `Sprint proof progress ${input.runId}`;
  const claimIntent = `active Sprint claim ${input.runId}`;

  const claim = await callLiveRuntimeTool<ClaimData>(
    runtimePrerequisite.selectedEntry,
    'teamem.claim_scope',
    {
      scope: { paths: [targetPath] },
      intent: claimIntent,
      repo_id: input.workspace.demoWorkspaceLaunchCwd,
      branch: 'main',
      auto_release_mode: 'manual_only'
    }
  );
  await callLiveRuntimeTool(
    runtimePrerequisite.selectedEntry,
    'teamem.record_decision',
    {
      decision_id: `plan-${input.runId}`,
      title: planTitle,
      summary: planSummary,
      kind: 'plan'
    }
  );
  await callLiveRuntimeTool(
    runtimePrerequisite.selectedEntry,
    'teamem.record_decision',
    {
      decision_id: `decision-${input.runId}`,
      title: decisionTitle,
      summary: `Decision evidence for ${input.sprint.slug}`,
      kind: 'process'
    }
  );
  await callLiveRuntimeTool(
    runtimePrerequisite.selectedEntry,
    'teamem.raise_blocker',
    {
      summary: blockerSummary
    }
  );
  await callLiveRuntimeTool(
    runtimePrerequisite.selectedEntry,
    'teamem.agent_focus_changed',
    {
      scope: { paths: [targetPath] },
      intent: progressIntent,
      bypass_dedup: true
    }
  );
  await callLiveRuntimeTool(
    runtimePrerequisite.selectedEntry,
    'teamem.share_finding',
    {
      summary: gotchaSummary,
      body: `Gotcha evidence for ${input.sprint.slug}`,
      kind: 'gotcha',
      tags: ['teamem-smoke', `run-${input.runId}`],
      severity: 'info',
      paths: [targetPath]
    }
  );

  return {
    claim: claim.data,
    claimIntent,
    planTitle,
    planSummary,
    decisionTitle,
    blockerSummary,
    gotchaSummary,
    progressIntent,
    targetPath
  };
}

async function seedNonCurrentSprintEvidence(input: {
  currentSprint: SprintSummary;
  runId: string;
  workspace: DemoRepositoryWorkspace;
}): Promise<SeededNonCurrentSprintEvidence> {
  if (!runtimePrerequisite.ok) {
    throw new Error(runtimePrerequisite.reason);
  }

  const displayName = `Noncurrent Sprint proof ${input.runId}`;
  const goal = `Noncurrent Sprint excluded from briefing ${input.runId}`;
  const created = await callLiveRuntimeTool<SprintLifecycleData>(
    runtimePrerequisite.selectedEntry,
    'teamem.create_sprint',
    {
      display_name: displayName,
      goal
    }
  );
  const sprint = created.data.sprint;
  if (!sprint) {
    throw new Error(
      `Expected non-current create_sprint response to include Sprint for run id ${input.runId}`
    );
  }

  const evidence = await seedSprintEvidence({
    sprint,
    runId: `noncurrent-${input.runId}`,
    workspace: input.workspace
  });

  const rejoin = await callLiveRuntimeTool<SprintLifecycleData>(
    runtimePrerequisite.selectedEntry,
    'teamem.join_sprint',
    {
      sprint: input.currentSprint.slug
    }
  );
  expect(rejoin.data.new_context.mode).toBe('sprint');
  expect(rejoin.data.sprint?.slug).toBe(input.currentSprint.slug);

  return {
    ...evidence,
    sprint,
    displayName,
    goal
  };
}

async function submitAndWaitForToolResponse<TData>(input: {
  session: InteractiveSession;
  prompt: string;
  toolName: 'create_sprint' | 'leave_sprint';
}): Promise<TData> {
  const beforeCount = countSuccessfulToolResponses(
    await readMcpTraces(input.session.artifacts.mcpTraceDir, {
      ignoreTransientErrors: true
    }),
    input.toolName
  );

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
    `Timed out waiting for MCP response ${input.toolName} after ${INTERACTIVE_WAIT_TIMEOUT_MS}ms. Last trace summary: ${lastTraceSummary}. Artifacts: ${input.session.artifacts.dir}. Permission mode env: ${TEAMEM_INTERACTIVE_PERMISSION_MODE_ENV}`
  );
}

async function waitForStatusEvidence(input: {
  session: InteractiveSession;
  before: Record<string, number>;
  expectedListClaimsResponses: 1 | 2;
}): Promise<StatusCommandEvidence> {
  const deadline = Date.now() + INTERACTIVE_WAIT_TIMEOUT_MS;
  let lastTraceSummary = 'no MCP traces observed';

  while (Date.now() < deadline) {
    const traces = await readMcpTraces(input.session.artifacts.mcpTraceDir, {
      ignoreTransientErrors: true
    });
    if (
      statusToolNames.every((toolName) => {
        const expectedNewResponses =
          toolName === 'list_claims' ? input.expectedListClaimsResponses : 1;
        return (
          countSuccessfulToolResponses(traces, toolName) >=
          (input.before[toolName] ?? 0) + expectedNewResponses
        );
      })
    ) {
      return {
        traces,
        responsesByTool: statusResponsesAfterCheckpoint({
          traces,
          before: input.before
        })
      };
    }

    lastTraceSummary = summarizeMcpTraces(traces);
    await delay(250);
  }

  throw new Error(
    `Timed out waiting for Sprint status MCP evidence after ${INTERACTIVE_WAIT_TIMEOUT_MS}ms. Last trace summary: ${lastTraceSummary}. Artifacts: ${input.session.artifacts.dir}. Permission mode env: ${TEAMEM_INTERACTIVE_PERMISSION_MODE_ENV}`
  );
}

async function waitForBriefingEvidence(input: {
  session: InteractiveSession;
  before: number;
}): Promise<McpTraceMessage> {
  return waitForNextSuccessfulToolResponse({
    session: input.session,
    toolName: 'get_briefing',
    beforeCount: input.before
  });
}

function countSuccessfulToolResponses(
  traces: McpTrace[],
  expectedToolName: string
): number;
function countSuccessfulToolResponses(
  traces: McpTrace[]
): Record<string, number>;
function countSuccessfulToolResponses(
  traces: McpTrace[],
  expectedToolName?: string
): number | Record<string, number> {
  const counts: Record<string, number> = {};
  for (const message of successfulTeamemToolResponseMessages(
    traces,
    expectedToolName
  )) {
    const toolName = normalizeTeamemToolName(message.metadata?.toolName ?? '');
    counts[toolName] = (counts[toolName] ?? 0) + 1;
  }
  return expectedToolName ? (counts[expectedToolName] ?? 0) : counts;
}

function successfulTeamemToolResponseMessages(
  traces: McpTrace[],
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

      const toolName = normalizeTeamemToolName(message.metadata.toolName);
      return expectedToolName ? toolName === expectedToolName : true;
    });
}

function statusResponsesAfterCheckpoint(input: {
  traces: McpTrace[];
  before: Record<string, number>;
}): Map<string, McpTraceMessage[]> {
  return new Map(
    statusToolNames.map((toolName) => [
      toolName,
      successfulTeamemToolResponseMessages(input.traces, toolName).slice(
        input.before[toolName] ?? 0
      )
    ])
  );
}

function latestStatusData<TData>(
  status: StatusCommandEvidence,
  toolName: (typeof statusToolNames)[number]
): TData {
  const message = status.responsesByTool.get(toolName)?.at(-1);
  if (!message) {
    throw new Error(`Expected post-command ${toolName} MCP response`);
  }
  return parseToolEnvelope<TData>(message).data;
}

function parseToolEnvelope<TData>(
  message: McpTraceMessage
): ToolEnvelope<TData> {
  const json = asRecord(message.json);
  const result = asRecord(json?.result);
  const content = Array.isArray(result?.content) ? result.content : [];
  const textBlock = content.find(
    (item) =>
      asRecord(item)?.type === 'text' &&
      typeof asRecord(item)?.text === 'string'
  );
  const text = asRecord(textBlock)?.text;
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
  return asRecord(value)?.ok === true && 'data' in (asRecord(value) ?? {});
}

function assertStatusMcpEvidence(input: {
  status: StatusCommandEvidence;
  artifactsDir: string;
  expectedContext: 'space' | 'sprint';
  sprint: SprintSummary;
  evidence: SeededSprintEvidence;
}): void {
  const current = latestStatusData<SprintCurrentData>(
    input.status,
    'get_current_sprint'
  );
  const briefing = latestStatusData<BriefingData>(input.status, 'get_briefing');
  const listClaims = (
    input.status.responsesByTool.get('list_claims') ?? []
  ).map((message) => parseToolEnvelope<ListClaimsData>(message).data);

  expect(current.context.mode).toBe(input.expectedContext);
  expect(briefing.current_context.mode).toBe(input.expectedContext);
  if (input.expectedContext === 'sprint') {
    expect(current.sprint?.slug).toBe(input.sprint.slug);
    expect(briefing.current_context.sprint?.slug).toBe(input.sprint.slug);
    expect(listClaims).toHaveLength(2);
    expect(
      listClaims.some((response) =>
        response.claims.some(
          (claim) =>
            claim.claim_id === input.evidence.claim.claim_id &&
            claim.context === 'sprint' &&
            claim.sprint_id === input.sprint.sprint_id
        )
      )
    ).toBe(true);
  } else {
    expect(current.sprint).toBeNull();
    expect(briefing.current_context.sprint).toBeNull();
    expect(listClaims).toHaveLength(1);
    expect(
      listClaims[0]?.claims.every((claim) => claim.context === 'space')
    ).toBe(true);
  }
}

function assertSprintBriefing(input: {
  briefing: BriefingData;
  sprint: SprintSummary;
  evidence: SeededSprintEvidence;
  nonCurrentEvidence?: SeededNonCurrentSprintEvidence;
  artifactsDir: string;
}): void {
  expect(input.briefing.current_context.mode).toBe('sprint');
  expect(input.briefing.current_context.sprint?.slug).toBe(input.sprint.slug);
  expect(input.briefing.current_context.sprint?.goal).toBe(input.sprint.goal);
  expect(input.briefing.current_context.sprint?.current_members).toContain(
    runtimePrerequisite.ok ? runtimePrerequisite.selectedEntry.member_name : ''
  );
  expect(input.briefing.current_context.routing_reasons).toContain(
    `current Sprint ${input.sprint.slug}`
  );
  expect(input.briefing.current_plan?.title).toBe(input.evidence.planTitle);
  expect(input.briefing.current_plan?.summary).toBe(input.evidence.planSummary);
  expect(hasClaim(input.briefing.active_claims, input.evidence)).toBe(true);
  expect(
    input.briefing.recent_decisions.some(
      (decision) => decision.title === input.evidence.decisionTitle
    )
  ).toBe(true);
  expect(
    input.briefing.active_risks.open_blockers.some(
      (blocker) => blocker.summary === input.evidence.blockerSummary
    )
  ).toBe(true);
  expect(
    input.briefing.recent_findings.some(
      (finding) =>
        finding.kind === 'gotcha' &&
        finding.summary === input.evidence.gotchaSummary
    )
  ).toBe(true);
  expect(
    input.briefing.recent_progress.some(
      (progress) => progress.what === input.evidence.progressIntent
    )
  ).toBe(true);
  expect(
    input.briefing.recent_joins.some((joinRecord) =>
      runtimePrerequisite.ok
        ? joinRecord.member_name ===
          runtimePrerequisite.selectedEntry.member_name
        : false
    )
  ).toBe(true);
  if (input.nonCurrentEvidence) {
    assertNonCurrentSprintSentinelsExcluded({
      text: currentContextBriefingText(input.briefing),
      evidence: input.nonCurrentEvidence,
      label: 'Sprint briefing MCP response'
    });
  }
  assertBriefingResponseShape(input.briefing, input.artifactsDir);
}

function currentContextBriefingText(briefing: BriefingData): string {
  return JSON.stringify({
    current_context: briefing.current_context,
    current_plan: briefing.current_plan,
    active_claims: briefing.active_claims,
    recent_decisions: briefing.recent_decisions,
    active_risks: briefing.active_risks,
    recent_progress: briefing.recent_progress,
    recent_findings: briefing.recent_findings
  });
}

function assertSpaceBriefing(input: {
  briefing: BriefingData;
  sprint: SprintSummary;
  evidence: SeededSprintEvidence;
  artifactsDir: string;
}): void {
  expect(input.briefing.current_context.mode).toBe('space');
  expect(input.briefing.current_context.sprint).toBeNull();
  expect(input.briefing.current_context.routing_reasons).not.toContain(
    `current Sprint ${input.sprint.slug}`
  );
  expect(input.briefing.current_plan?.title).not.toBe(input.evidence.planTitle);
  expect(hasClaim(input.briefing.active_claims, input.evidence)).toBe(false);
  expect(
    hasClaim(
      input.briefing.outside_current_context.active_claims,
      input.evidence
    )
  ).toBe(false);
  expect(
    input.briefing.recent_decisions.some(
      (decision) => decision.title === input.evidence.decisionTitle
    )
  ).toBe(false);
  expect(
    input.briefing.active_risks.open_blockers.some(
      (blocker) => blocker.summary === input.evidence.blockerSummary
    )
  ).toBe(false);
  expect(
    input.briefing.recent_findings.some(
      (finding) => finding.summary === input.evidence.gotchaSummary
    )
  ).toBe(false);
  assertBriefingResponseShape(input.briefing, input.artifactsDir);
}

function assertBriefingResponseShape(
  briefing: BriefingData,
  artifactsDir: string
): void {
  const missingSectionKeys = briefingSectionKeys.filter(
    (key) => !(key in briefing)
  );
  if (missingSectionKeys.length > 0) {
    throw new Error(
      `Expected get_briefing response data to include section keys ${briefingSectionKeys.join(', ')}; missing ${missingSectionKeys.join(', ')}. Artifacts: ${artifactsDir}`
    );
  }
}

function hasClaim(
  claims: BriefingData['active_claims'],
  evidence: SeededSprintEvidence
): boolean {
  return claims.some(
    (claim) =>
      claim.principal ===
        (runtimePrerequisite.ok
          ? runtimePrerequisite.selectedEntry.member_name
          : '') &&
      Array.isArray(claim.scope.paths) &&
      claim.scope.paths.includes(evidence.targetPath)
  );
}

function assertObservedMcpToolSequence(input: {
  traces: McpTrace[];
  artifactsDir: string;
  sprint: SprintSummary;
  evidence: SeededSprintEvidence;
  nonCurrentEvidence?: SeededNonCurrentSprintEvidence;
}): void {
  const calls = observedTeamemToolCallsOrThrow(
    input.traces,
    input.artifactsDir
  );
  const observedTools = calls.map((call) => call.toolName);
  const unexpectedTools = observedTools.filter(
    (toolName) =>
      !allowedTeamemToolNames.includes(
        toolName as (typeof allowedTeamemToolNames)[number]
      )
  );
  if (unexpectedTools.length > 0) {
    throw new Error(
      `Expected only Sprint status/briefing MCP tools, observed unexpected ${unexpectedTools.join(', ')}. Artifacts: ${input.artifactsDir}`
    );
  }
  expect(observedTools).toEqual([
    'create_sprint',
    'whoami',
    'get_current_sprint',
    'list_claims',
    'list_claims',
    'get_briefing',
    'get_briefing',
    'leave_sprint',
    'whoami',
    'get_current_sprint',
    'list_claims',
    'get_briefing',
    'get_briefing'
  ]);
  expectToolArguments(calls[0]?.arguments, {
    display_name: input.sprint.display_name,
    goal: input.sprint.goal
  });
  expectToolArguments(calls[3]?.arguments, {
    scope: 'self',
    view: 'current'
  });
  expectToolArguments(calls[4]?.arguments, {
    scope: 'self',
    view: 'outside_current_context'
  });
  expectToolArguments(calls[6]?.arguments, { token_budget: 2200 });
  expectToolArguments(calls[10]?.arguments, {
    scope: 'self',
    view: 'current'
  });
  expectToolArguments(calls[12]?.arguments, { token_budget: 2200 });

  const sprintBriefing = successfulTeamemToolResponseMessages(
    input.traces,
    'get_briefing'
  )
    .map((message) => parseToolEnvelope<BriefingData>(message).data)
    .reverse()
    .find((briefing) => briefing.current_context.mode === 'sprint');
  const spaceBriefing = successfulTeamemToolResponseMessages(
    input.traces,
    'get_briefing'
  )
    .map((message) => parseToolEnvelope<BriefingData>(message).data)
    .reverse()
    .find((briefing) => briefing.current_context.mode === 'space');
  if (!sprintBriefing || !spaceBriefing) {
    throw new Error(
      `Expected both Sprint and Space get_briefing MCP responses. Artifacts: ${input.artifactsDir}`
    );
  }
  assertSprintBriefing({
    briefing: sprintBriefing,
    sprint: input.sprint,
    evidence: input.evidence,
    nonCurrentEvidence: input.nonCurrentEvidence,
    artifactsDir: input.artifactsDir
  });
  assertSpaceBriefing({
    briefing: spaceBriefing,
    sprint: input.sprint,
    evidence: input.evidence,
    artifactsDir: input.artifactsDir
  });
}

function expectToolArguments(
  actualArguments: Record<string, unknown> | undefined,
  expectedArguments: Record<string, unknown>
): void {
  expect(
    normalizeNumericExpectedArguments(actualArguments ?? {}, expectedArguments)
  ).toMatchObject(expectedArguments);
}

function normalizeNumericExpectedArguments(
  actualArguments: Record<string, unknown>,
  expectedArguments: Record<string, unknown>
): Record<string, unknown> {
  const normalizedArguments = { ...actualArguments };
  for (const [key, expectedValue] of Object.entries(expectedArguments)) {
    const actualValue = normalizedArguments[key];
    if (
      typeof expectedValue === 'number' &&
      typeof actualValue === 'string' &&
      actualValue.trim() === String(expectedValue)
    ) {
      normalizedArguments[key] = expectedValue;
    }
  }
  return normalizedArguments;
}

type ObservedToolCall = {
  toolName: string;
  arguments: Record<string, unknown>;
};

function observedTeamemToolCallsOrThrow(
  traces: McpTrace[],
  artifactsDir: string
): ObservedToolCall[] {
  const teamemTrace = traces.find((trace) => trace.serverName === 'teamem');
  if (!teamemTrace) {
    throw new Error(
      `Expected core teamem MCP trace. Artifacts: ${artifactsDir}`
    );
  }

  const observedCalls: ObservedToolCall[] = [];
  for (const [index, message] of teamemTrace.messages.entries()) {
    if (
      message.direction !== 'client-to-server' ||
      message.method !== 'tools/call'
    ) {
      continue;
    }
    const toolName = message.metadata?.toolName;
    if (!toolName) {
      throw new Error(
        `Expected safe Sprint status/briefing MCP tools/call name metadata at index ${index}. Artifacts: ${artifactsDir}`
      );
    }
    observedCalls.push({
      toolName: normalizeTeamemToolName(toolName),
      arguments: readToolCallArguments(message)
    });
  }

  return observedCalls;
}

function readToolCallArguments(
  message: McpTraceMessage
): Record<string, unknown> {
  const json = asRecord(message.json);
  const params = asRecord(json?.params);
  const args = asRecord(params?.arguments);
  return args ?? {};
}

function normalizeTeamemToolName(toolName: string): string {
  if (toolName.startsWith(pluginScopedToolPrefix)) {
    return toolName.slice(pluginScopedToolPrefix.length);
  }
  if (toolName.startsWith('mcp__teamem__teamem_')) {
    return toolName.slice('mcp__teamem__teamem_'.length);
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

function assertLiveInteractiveInputEvidence(
  session: InteractiveSession,
  prompts: Record<string, string>
): void {
  const submittedText = session
    .events()
    .filter((event) => event.type === 'input' && event.source === 'submit')
    .map((event) => ('data' in event ? event.data : ''))
    .join('');

  for (const prompt of Object.values(prompts)) {
    expect(submittedText).toContain(prompt);
  }
}

function commandOutputCheckpoint(session: InteractiveSession): number {
  return session.events().length;
}

async function assertSprintStatusRenderedOutput(input: {
  session: InteractiveSession;
  checkpoint: number;
  sprint: SprintSummary;
  evidence: SeededSprintEvidence;
}): Promise<void> {
  const memberName = runtimePrerequisite.ok
    ? runtimePrerequisite.selectedEntry.member_name
    : '';
  const output = await waitForCommandOutput({
    session: input.session,
    checkpoint: input.checkpoint,
    expectedText: [input.sprint.display_name, input.sprint.slug, memberName],
    expectedAnyText: [
      [
        input.evidence.targetPath,
        input.evidence.claimIntent,
        input.evidence.claim.claim_id
      ]
    ],
    label: 'Sprint /teamem:status output'
  });
  assertVisibleCommandOutputPattern(output, /\bmode\b/i, {
    label: 'Sprint status mode label',
    artifacts: artifactPathsFromRun(input.session.artifacts)
  });
  assertVisibleCommandOutputPattern(output, /\bsprint\b/i, {
    label: 'Sprint status mode value',
    artifacts: artifactPathsFromRun(input.session.artifacts)
  });
}

async function assertSpaceStatusRenderedOutput(input: {
  session: InteractiveSession;
  checkpoint: number;
}): Promise<void> {
  const output = await waitForCommandOutput({
    session: input.session,
    checkpoint: input.checkpoint,
    expectedText: [],
    expectedAnyText: [['Space', 'space']],
    label: 'Space /teamem:status output'
  });
  assertVisibleCommandOutputPattern(output, /\bmode\b/i, {
    label: 'Space status mode label',
    artifacts: artifactPathsFromRun(input.session.artifacts)
  });
  assertVisibleCommandOutputPattern(output, /\bspace\b/i, {
    label: 'Space status mode value',
    artifacts: artifactPathsFromRun(input.session.artifacts)
  });
}

async function waitForCommandOutput(input: {
  session: InteractiveSession;
  checkpoint: number;
  expectedText: string[];
  expectedAnyText?: string[][];
  label: string;
}): Promise<string> {
  const deadline = Date.now() + INTERACTIVE_WAIT_TIMEOUT_MS;
  let output = '';

  while (Date.now() < deadline) {
    output = commandOutputFromCheckpoint(input.session, input.checkpoint);
    const hasExpectedText = input.expectedText.every((text) =>
      outputIncludesTerminalText(output, text)
    );
    const hasExpectedAnyText = (input.expectedAnyText ?? []).every((group) =>
      group.some((text) => outputIncludesTerminalText(output, text))
    );
    if (hasExpectedText && hasExpectedAnyText) {
      return output;
    }
    await delay(250);
  }

  const missing = input.expectedText.filter(
    (text) => !outputIncludesTerminalText(output, text)
  );
  const missingAny = (input.expectedAnyText ?? [])
    .filter(
      (group) => !group.some((text) => outputIncludesTerminalText(output, text))
    )
    .map(
      (group) => `[${group.map((text) => JSON.stringify(text)).join(' or ')}]`
    );
  throw new Error(
    `Timed out waiting for ${input.label} to include ${[
      ...missing.map((text) => JSON.stringify(text)),
      ...missingAny
    ].join(', ')}. ${artifactPathsFromRun(input.session.artifacts)}`
  );
}

function commandOutputFromCheckpoint(
  session: InteractiveSession,
  checkpoint: number
): string {
  return normalizeTranscript(
    session
      .events()
      .slice(checkpoint)
      .filter((event) => event.type === 'output')
      .map((event) => ('data' in event ? event.data : ''))
      .join('')
  );
}

function assertTranscriptOutputEvidence(input: {
  session: InteractiveSession;
  prompts: Record<string, string>;
  sprint: SprintSummary;
  evidence: SeededSprintEvidence;
}): void {
  const visibleOutput = commandOutputWithoutSubmittedPrompts({
    session: input.session,
    prompts: Object.values(input.prompts)
  });
  const artifacts = artifactPathsFromRun(input.session.artifacts);

  for (const text of [
    input.sprint.slug,
    input.sprint.display_name,
    input.sprint.goal,
    input.evidence.planTitle,
    input.evidence.decisionTitle,
    input.evidence.blockerSummary,
    input.evidence.progressIntent
  ]) {
    assertVisibleCommandOutput(visibleOutput, text, {
      label: 'Sprint status/briefing output',
      artifacts
    });
  }

  assertVisibleCommandOutput(visibleOutput, 'Space', {
    label: 'Space-mode fallback output',
    artifacts
  });
}

function commandOutputWithoutSubmittedPrompts(input: {
  session: InteractiveSession;
  prompts: string[];
}): string {
  let output = normalizeTranscript(
    input.session
      .events()
      .filter((event) => event.type === 'output')
      .map((event) => ('data' in event ? event.data : ''))
      .join('')
  );
  for (const prompt of input.prompts) {
    output = output.replaceAll(prompt, '');
  }
  return output;
}

function assertVisibleCommandOutput(
  output: string,
  expectedText: string,
  input: { label: string; artifacts: string }
): void {
  if (!outputIncludesTerminalText(output, expectedText)) {
    throw new Error(
      `Expected /teamem:status or /teamem:briefing output to include ${input.label}: ${JSON.stringify(expectedText)}. ${input.artifacts}`
    );
  }
}

function outputIncludesTerminalText(
  output: string,
  expectedText: string
): boolean {
  return (
    output.includes(expectedText) ||
    compactTerminalText(output).includes(compactTerminalText(expectedText))
  );
}

function compactTerminalText(text: string): string {
  return normalizeTranscript(text).replace(/\s+/g, '');
}

function assertVisibleCommandOutputPattern(
  output: string,
  expectedPattern: RegExp,
  input: { label: string; artifacts: string }
): void {
  if (!expectedPattern.test(output)) {
    throw new Error(
      `Expected /teamem:status output to include ${input.label} matching ${expectedPattern}. ${input.artifacts}`
    );
  }
}

function assertNonCurrentSprintSentinelsExcluded(input: {
  text: string;
  evidence: SeededNonCurrentSprintEvidence;
  label: string;
}): void {
  const sentinels = new Set([
    input.evidence.displayName,
    input.evidence.goal,
    input.evidence.sprint.sprint_id,
    input.evidence.sprint.slug,
    input.evidence.sprint.display_name,
    input.evidence.sprint.goal,
    input.evidence.targetPath,
    input.evidence.claimIntent,
    input.evidence.claim.claim_id,
    input.evidence.planTitle,
    input.evidence.planSummary,
    input.evidence.decisionTitle,
    input.evidence.blockerSummary,
    input.evidence.gotchaSummary,
    input.evidence.progressIntent
  ]);

  for (const sentinel of sentinels) {
    if (outputIncludesTerminalText(input.text, sentinel)) {
      throw new Error(
        `Expected ${input.label} to exclude non-current Sprint sentinel ${JSON.stringify(sentinel)} from ${input.evidence.sprint.slug}`
      );
    }
  }
}

async function cleanupRemoteSprint(
  sprint: SprintSummary,
  claim?: ClaimData
): Promise<void> {
  if (!runtimePrerequisite.ok) {
    throw new Error(runtimePrerequisite.reason);
  }

  if (claim) {
    await callLiveRuntimeTool(
      runtimePrerequisite.selectedEntry,
      'teamem.release_scope',
      {
        claim_id: claim.claim_id
      }
    );
  }
  const current = await callLiveRuntimeTool<SprintCurrentData>(
    runtimePrerequisite.selectedEntry,
    'teamem.get_current_sprint',
    {}
  );
  if (current.data.sprint?.slug === sprint.slug) {
    await callLiveRuntimeTool<SprintLifecycleData>(
      runtimePrerequisite.selectedEntry,
      'teamem.leave_sprint',
      {}
    );
  }
  const latestList = await callLiveRuntimeTool<SprintListData>(
    runtimePrerequisite.selectedEntry,
    'teamem.list_sprints',
    {}
  );
  const latestSprint = latestList.data.sprints.find(
    (candidate) => candidate.slug === sprint.slug
  );
  if (latestSprint?.status === 'active') {
    await callLiveRuntimeTool<SprintArchiveData>(
      runtimePrerequisite.selectedEntry,
      'teamem.archive_sprint',
      { sprint: sprint.slug }
    );
  }
}

async function leaveCurrentSprintIfAny(entry: CredentialEntry): Promise<void> {
  const current = await callLiveRuntimeTool<SprintCurrentData>(
    entry,
    'teamem.get_current_sprint',
    {}
  );
  if (current.data.context.mode === 'space') {
    return;
  }
  const response = await callLiveRuntimeTool<SprintLifecycleData>(
    entry,
    'teamem.leave_sprint',
    {}
  );
  expect(response.data.new_context.mode).toBe('space');
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
}

async function assertSessionStartEvidence(
  traces: HookTrace[],
  profile: IsolatedSprintProfile
): Promise<void> {
  const sessionStart = traces.find((trace) => trace.event === 'SessionStart');
  expect(sessionStart).toBeDefined();

  if (sessionStart) {
    expect(sessionStart.exitCode).toBe(0);
    await assertTraceArtifactsExist(sessionStart);
    assertTraceUsesIsolatedPluginData(sessionStart, profile);
  }
}

async function assertTeamemMcpTraceEvidence(
  traces: McpTrace[],
  profile: IsolatedSprintProfile
): Promise<void> {
  const teamemTrace = traces.find((trace) => trace.serverName === 'teamem');
  expect(teamemTrace).toBeDefined();

  if (teamemTrace) {
    await assertTraceArtifactsExist(teamemTrace);
    assertTraceUsesIsolatedPluginData(teamemTrace, profile);
  }
}

function assertTraceUsesIsolatedPluginData(
  trace: HookTrace | McpTrace,
  profile: IsolatedSprintProfile
): void {
  const observedPluginData = trace.environment?.env.CLAUDE_PLUGIN_DATA;
  const isolatedCacheDataRoot = join(profile.pluginCacheDir, 'data');
  if (
    observedPluginData !== profile.pluginDataDir &&
    !observedPluginData?.startsWith(`${isolatedCacheDataRoot}/`)
  ) {
    throw new Error(
      `Expected trace CLAUDE_PLUGIN_DATA to stay inside the isolated Sprint profile, observed ${JSON.stringify(observedPluginData)}`
    );
  }
}

async function assertLaunchUsesIsolatedState(input: {
  artifacts: RunArtifacts;
  profile: IsolatedSprintProfile;
}): Promise<void> {
  const environment = JSON.parse(
    await readFile(input.artifacts.environmentPath, 'utf8')
  ) as { env?: Record<string, string> };

  await expect(stat(input.profile.reportPath)).resolves.toBeTruthy();
  await expect(stat(input.profile.credentialsPath)).resolves.toBeTruthy();
  await expect(stat(input.profile.claudeConfigDir)).resolves.toBeTruthy();
  await expect(stat(input.profile.pluginCacheDir)).resolves.toBeTruthy();
  await expect(stat(input.profile.pluginDataDir)).resolves.toBeTruthy();
  expect(environment.env?.CLAUDE_PLUGIN_DATA).toBe(input.profile.pluginDataDir);
}

function summarizeMcpTraces(traces: McpTrace[]): string {
  if (traces.length === 0) {
    return 'no MCP traces observed';
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

function withArtifactError(
  err: unknown,
  input: {
    artifactsDir: string;
    workspace?: DemoRepositoryWorkspace;
    runId: string;
  }
): Error {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes('Artifacts:')) {
    return err instanceof Error ? err : new Error(message);
  }
  const workspacePath =
    input.workspace?.demoWorkspaceLaunchCwd ?? '(not yet created)';
  const error = new Error(
    `${message}\nArtifacts: ${input.artifactsDir}\nWorkspace: ${workspacePath}\nRun id: ${input.runId}`
  );
  if (err instanceof Error) {
    error.stack = err.stack;
  }
  return error;
}

function artifactPaths(
  artifacts: RunArtifacts,
  workspace: DemoRepositoryWorkspace
): string {
  return [
    `Artifacts: ${artifacts.dir}`,
    `run-summary: ${artifacts.summaryPath}`,
    `environment: ${artifacts.environmentPath}`,
    `raw transcript: ${artifacts.rawTranscriptPath}`,
    `normalized transcript: ${artifacts.normalizedTranscriptPath}`,
    `interactive events: ${artifacts.interactiveEventsPath}`,
    `hook traces: ${artifacts.hookTraceDir}`,
    `MCP traces: ${artifacts.mcpTraceDir}`,
    `isolated profile: ${join(artifacts.dir, '..', 'isolated-profile.json')}`,
    `workspace: ${workspace.demoWorkspaceLaunchCwd}`
  ].join('; ');
}

function artifactPathsFromRun(artifacts: RunArtifacts): string {
  return [
    `Artifacts: ${artifacts.dir}`,
    `run-summary: ${artifacts.summaryPath}`,
    `environment: ${artifacts.environmentPath}`,
    `raw transcript: ${artifacts.rawTranscriptPath}`,
    `normalized transcript: ${artifacts.normalizedTranscriptPath}`,
    `interactive events: ${artifacts.interactiveEventsPath}`,
    `hook traces: ${artifacts.hookTraceDir}`,
    `MCP traces: ${artifacts.mcpTraceDir}`,
    `isolated profile: ${join(artifacts.dir, '..', 'isolated-profile.json')}`
  ].join('; ');
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
