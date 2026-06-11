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
const sprintToolNames = [
  'create_sprint',
  'get_current_sprint',
  'list_sprints',
  'get_sprint_history',
  'leave_sprint',
  'join_sprint',
  'archive_sprint',
  'reopen_sprint'
] as const;
const expectedToolSequence = [
  'create_sprint',
  'get_current_sprint',
  'list_sprints',
  'get_sprint_history',
  'leave_sprint',
  'join_sprint',
  'get_current_sprint',
  'leave_sprint',
  'archive_sprint',
  'reopen_sprint',
  'get_current_sprint',
  'get_sprint_history'
] as const;

describeLiveInteractiveStateful(
  `Teamem interactive Sprint lifecycle live smoke${liveInteractiveStatefulGateEnabled ? '' : ` (${formatInteractiveStatefulGateReason()})`}`,
  () => {
    it(
      'drives create/current/list/history/join/leave/archive/reopen through /teamem:sprint',
      async () => {
        if (!runtimePrerequisite.ok) {
          throw new Error(runtimePrerequisite.reason);
        }
        if (!unredactedArtifactsEnabled) {
          throw new Error(
            'set CLAUDE_PLUGIN_E2E_ALLOW_UNREDACTED=1 to run Sprint lifecycle smoke; this smoke parses MCP response artifacts to prove old/new context output and durable state'
          );
        }

        await withLiveInteractiveSmokeLock(
          'teamem-interactive-sprint-lifecycle-smoke',
          async () => {
            const runId = createRunId();
            const displayName = `Sprint lifecycle ${runId}`;
            const goal = `Prove /teamem:sprint lifecycle smoke ${runId}`;
            let workspace: DemoRepositoryWorkspace | undefined;
            const artifactsDir = await mkdtemp(
              join(tmpdir(), 'teamem-interactive-sprint-lifecycle-artifacts-')
            );
            let session: InteractiveSession | undefined;
            let createdSprint: SprintSummary | undefined;
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
                current: await tester.slashCommandPrompt('sprint', 'current'),
                list: await tester.slashCommandPrompt('sprint', 'list'),
                leave: await tester.slashCommandPrompt('sprint', 'leave')
              };
              expect(prompts.create).toStartWith('/teamem:sprint create ');

              session = await tester.launchInteractive({
                permissionMode: interactivePermissionMode,
                useInstrumentedMcpConfig: true,
                strictMcpConfig: true,
                allowedTools: [
                  'Skill(teamem:sprint)',
                  'Bash(${CLAUDE_PLUGIN_ROOT}/bin/teamem-flag:*)',
                  ...sprintToolNames.map(
                    (toolName) => `${canonicalToolPrefix}${toolName}`
                  ),
                  ...sprintToolNames.map(
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
                  `${pluginScopedToolPrefix}get_finding`,
                  `${pluginScopedToolPrefix}acknowledge_finding`,
                  `${pluginScopedToolPrefix}get_briefing`
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
              const createNewContext = expectSprintContext(
                createResponse.new_context,
                session.artifacts
              );
              expect(createNewContext.sprint.slug).toBe(createdSprint.slug);
              expect(createResponse.message).toContain(createdSprint.slug);
              expect(createResponse.idempotent).toBe(false);

              const currentAfterCreate =
                await submitAndWaitForToolResponse<SprintCurrentData>({
                  session,
                  prompt: prompts.current,
                  toolName: 'get_current_sprint'
                });
              expect(currentAfterCreate.context.mode).toBe('sprint');
              expect(currentAfterCreate.sprint?.slug).toBe(createdSprint.slug);
              expect(currentAfterCreate.current_members).toContain(
                runtimePrerequisite.selectedEntry.member_name
              );

              const listResponse =
                await submitAndWaitForToolResponse<SprintListData>({
                  session,
                  prompt: prompts.list,
                  toolName: 'list_sprints'
                });
              expect(
                listResponse.sprints.some(
                  (sprint) =>
                    sprint.slug === createdSprint?.slug &&
                    sprint.status === 'active' &&
                    sprint.current_members.includes(
                      runtimePrerequisite.selectedEntry.member_name
                    )
                )
              ).toBe(true);

              const historyPrompt = await tester.slashCommandPrompt(
                'sprint',
                `history ${createdSprint.slug} --limit 10`
              );
              const initialHistory =
                await submitAndWaitForToolResponse<SprintHistoryData>({
                  session,
                  prompt: historyPrompt,
                  toolName: 'get_sprint_history'
                });
              expect(initialHistory.sprint.slug).toBe(createdSprint.slug);
              expect(
                eventTypes(initialHistory).includes('sprint_created')
              ).toBe(true);
              expect(eventTypes(initialHistory).includes('sprint_joined')).toBe(
                true
              );

              const leaveAfterCreate =
                await submitAndWaitForToolResponse<SprintLifecycleData>({
                  session,
                  prompt: prompts.leave,
                  toolName: 'leave_sprint'
                });
              expect(leaveAfterCreate.old_context.mode).toBe('sprint');
              const leaveAfterCreateOldContext = expectSprintContext(
                leaveAfterCreate.old_context,
                session.artifacts
              );
              expect(leaveAfterCreateOldContext.sprint.slug).toBe(
                createdSprint.slug
              );
              expect(leaveAfterCreate.new_context.mode).toBe('space');
              expect(leaveAfterCreate.message).toContain(createdSprint.slug);

              const joinPrompt = await tester.slashCommandPrompt(
                'sprint',
                `join ${createdSprint.slug}`
              );
              const joinResponse =
                await submitAndWaitForToolResponse<SprintLifecycleData>({
                  session,
                  prompt: joinPrompt,
                  toolName: 'join_sprint'
                });
              expect(joinResponse.old_context.mode).toBe('space');
              expect(joinResponse.new_context.mode).toBe('sprint');
              const joinNewContext = expectSprintContext(
                joinResponse.new_context,
                session.artifacts
              );
              expect(joinNewContext.sprint.slug).toBe(createdSprint.slug);
              expect(joinResponse.message).toContain(createdSprint.slug);

              const currentAfterJoin =
                await submitAndWaitForToolResponse<SprintCurrentData>({
                  session,
                  prompt: prompts.current,
                  toolName: 'get_current_sprint'
                });
              expect(currentAfterJoin.context.mode).toBe('sprint');
              expect(currentAfterJoin.sprint?.slug).toBe(createdSprint.slug);

              const leaveBeforeArchive =
                await submitAndWaitForToolResponse<SprintLifecycleData>({
                  session,
                  prompt: prompts.leave,
                  toolName: 'leave_sprint'
                });
              expect(leaveBeforeArchive.old_context.mode).toBe('sprint');
              const leaveBeforeArchiveOldContext = expectSprintContext(
                leaveBeforeArchive.old_context,
                session.artifacts
              );
              expect(leaveBeforeArchiveOldContext.sprint.slug).toBe(
                createdSprint.slug
              );
              expect(leaveBeforeArchive.new_context.mode).toBe('space');

              const archivePrompt = await tester.slashCommandPrompt(
                'sprint',
                `archive ${createdSprint.slug}`
              );
              const archiveResponse =
                await submitAndWaitForToolResponse<SprintArchiveData>({
                  session,
                  prompt: archivePrompt,
                  toolName: 'archive_sprint'
                });
              expect(archiveResponse.sprint.slug).toBe(createdSprint.slug);
              expect(archiveResponse.sprint.status).toBe('archived');
              expect(archiveResponse.message).toContain(createdSprint.slug);
              expect(Array.isArray(archiveResponse.released_claims)).toBe(true);

              const reopenPrompt = await tester.slashCommandPrompt(
                'sprint',
                `reopen ${createdSprint.slug}`
              );
              const reopenResponse =
                await submitAndWaitForToolResponse<SprintLifecycleData>({
                  session,
                  prompt: reopenPrompt,
                  toolName: 'reopen_sprint'
                });
              expect(reopenResponse.old_context.mode).toBe('space');
              expect(reopenResponse.new_context.mode).toBe('sprint');
              const reopenNewContext = expectSprintContext(
                reopenResponse.new_context,
                session.artifacts
              );
              expect(reopenNewContext.sprint.slug).toBe(createdSprint.slug);
              expect(reopenNewContext.sprint.status).toBe('active');
              expect(reopenResponse.message).toContain(createdSprint.slug);

              const currentAfterReopen =
                await submitAndWaitForToolResponse<SprintCurrentData>({
                  session,
                  prompt: prompts.current,
                  toolName: 'get_current_sprint'
                });
              expect(currentAfterReopen.context.mode).toBe('sprint');
              expect(currentAfterReopen.sprint?.slug).toBe(createdSprint.slug);

              const finalHistoryPrompt = await tester.slashCommandPrompt(
                'sprint',
                `history ${createdSprint.slug} --limit 20`
              );
              const finalHistory =
                await submitAndWaitForToolResponse<SprintHistoryData>({
                  session,
                  prompt: finalHistoryPrompt,
                  toolName: 'get_sprint_history'
                });
              expect(finalHistory.sprint.slug).toBe(createdSprint.slug);
              for (const eventType of [
                'sprint_created',
                'sprint_joined',
                'sprint_left',
                'sprint_archived',
                'sprint_reopened'
              ]) {
                expect(eventTypes(finalHistory)).toContain(eventType);
              }

              assertLiveInteractiveInputEvidence(session, {
                create: prompts.create,
                current: prompts.current,
                list: prompts.list,
                history: historyPrompt,
                leave: prompts.leave,
                join: joinPrompt,
                archive: archivePrompt,
                reopen: reopenPrompt,
                finalHistory: finalHistoryPrompt
              });
              assertTranscriptOutputEvidence(session, {
                prompts: {
                  create: prompts.create,
                  current: prompts.current,
                  list: prompts.list,
                  initialHistory: historyPrompt,
                  leaveAfterCreate: prompts.leave,
                  join: joinPrompt,
                  currentAfterJoin: prompts.current,
                  leaveBeforeArchive: prompts.leave,
                  archive: archivePrompt,
                  reopen: reopenPrompt,
                  currentAfterReopen: prompts.current,
                  finalHistory: finalHistoryPrompt
                },
                sprint: createdSprint,
                lifecycle: {
                  create: createResponse,
                  leaveAfterCreate,
                  join: joinResponse,
                  leaveBeforeArchive,
                  reopen: reopenResponse
                },
                archive: archiveResponse
              });
              await assertDurableRuntimeState(createdSprint);
              await session.close();

              await assertInteractiveArtifactsExist(session);
              const [hookTraces, mcpTraces] = await Promise.all([
                readHookTraces(session.artifacts.hookTraceDir),
                readMcpTraces(session.artifacts.mcpTraceDir)
              ]);
              await assertSessionStartEvidence(hookTraces, isolatedProfile);
              assertNoTeamemChannelMcpTrace(mcpTraces);
              assertSprintMcpEvidence({
                traces: mcpTraces,
                artifactsDir: session.artifacts.dir,
                sprint: createdSprint
              });
              await assertTeamemMcpTraceEvidence(mcpTraces, isolatedProfile);
              await assertLaunchUsesIsolatedState({
                artifacts: session.artifacts,
                profile: isolatedProfile
              });

              await cleanupRemoteSprint(createdSprint);
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
                  await cleanupRemoteSprint(createdSprint);
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
                    `Failed to close failed Sprint lifecycle smoke session for run id ${runId}: ${formatError(err)}`
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
                    `Preserving failed Sprint lifecycle demo workspace at ${cleanup.demoWorkspaceLaunchCwd}${cleanup.artifactPath ? ` (report ${cleanup.artifactPath})` : ''} for run id ${runId}`
                  );
                }
              }

              if (success) {
                await rm(artifactsDir, { recursive: true, force: true });
              } else {
                console.error(
                  `Preserving failed Sprint lifecycle smoke artifacts at ${artifactsDir} for run id ${runId}`
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

  return `set TEAMEM_CLAUDE_PLUGIN_E2E=1, TEAMEM_CLAUDE_PLUGIN_INTERACTIVE_E2E=1, TEAMEM_CLAUDE_PLUGIN_STATEFUL_E2E=1, and CLAUDE_PLUGIN_E2E_ALLOW_UNREDACTED=1 to run stateful interactive Sprint lifecycle smoke${
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

async function submitAndWaitForToolResponse<TData>(input: {
  session: InteractiveSession;
  prompt: string;
  toolName: SprintToolName;
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

type SprintToolName = (typeof sprintToolNames)[number];

async function waitForNextSuccessfulToolResponse(input: {
  session: InteractiveSession;
  toolName: SprintToolName;
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
    `Timed out waiting for /teamem:sprint MCP response ${input.toolName} after ${INTERACTIVE_WAIT_TIMEOUT_MS}ms. Last trace summary: ${lastTraceSummary}. Artifacts: ${input.session.artifacts.dir}. Permission mode env: ${TEAMEM_INTERACTIVE_PERMISSION_MODE_ENV}`
  );
}

function successfulTeamemToolResponseMessages(
  traces: McpTrace[],
  expectedToolName?: SprintToolName
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

function assertSprintMcpEvidence(input: {
  traces: McpTrace[];
  artifactsDir: string;
  sprint: SprintSummary;
}): void {
  const allObservedToolCalls = observedTeamemToolCallsOrThrow(
    input.traces,
    input.artifactsDir
  );
  const firstLifecycleToolIndex = allObservedToolCalls.findIndex(
    (call) => call.toolName === expectedToolSequence[0]
  );
  if (firstLifecycleToolIndex < 0) {
    throw new Error(
      `Expected Sprint lifecycle MCP sequence to start with ${expectedToolSequence[0]}. Artifacts: ${input.artifactsDir}`
    );
  }
  const observedToolCalls = allObservedToolCalls.slice(firstLifecycleToolIndex);
  const observedTools = observedToolCalls.map((call) => call.toolName);
  const unexpectedTools = observedTools.filter(
    (toolName) => !sprintToolNames.includes(toolName as SprintToolName)
  );
  if (unexpectedTools.length > 0) {
    throw new Error(
      `Expected only Sprint lifecycle MCP tools, observed unexpected ${unexpectedTools.join(', ')}. Artifacts: ${input.artifactsDir}`
    );
  }
  expect(observedTools).toEqual([...expectedToolSequence]);
  assertSprintToolCallArguments({
    calls: observedToolCalls,
    sprint: input.sprint,
    artifactsDir: input.artifactsDir
  });

  const responsesByTool = new Map<string, unknown[]>();
  for (const message of successfulTeamemToolResponseMessages(input.traces)) {
    const toolName = normalizeTeamemToolName(message.metadata?.toolName ?? '');
    const data = parseToolEnvelope<unknown>(message).data;
    const existing = responsesByTool.get(toolName) ?? [];
    existing.push(data);
    responsesByTool.set(toolName, existing);
  }

  const archiveResponses = (responsesByTool.get('archive_sprint') ??
    []) as SprintArchiveData[];
  expect(archiveResponses.at(-1)?.sprint.slug).toBe(input.sprint.slug);
  expect(archiveResponses.at(-1)?.sprint.status).toBe('archived');

  const reopenResponses = (responsesByTool.get('reopen_sprint') ??
    []) as SprintLifecycleData[];
  const reopenResponse = reopenResponses.at(-1);
  expect(reopenResponse?.old_context.mode).toBe('space');
  expect(reopenResponse?.new_context.mode).toBe('sprint');
  if (!reopenResponse) {
    throw new Error(
      `Expected reopen_sprint MCP response. Artifacts: ${input.artifactsDir}`
    );
  }
  if (
    reopenResponse.new_context.mode !== 'sprint' ||
    !reopenResponse.new_context.sprint
  ) {
    throw new Error(
      `Expected reopen_sprint new_context to be Sprint mode, observed ${JSON.stringify(reopenResponse.new_context)}. Artifacts: ${input.artifactsDir}`
    );
  }
  expect(reopenResponse.new_context.sprint.slug).toBe(input.sprint.slug);
}

type ObservedSprintToolCall = {
  toolName: string;
  arguments: Record<string, unknown>;
  traceIndex: number;
};

function observedTeamemToolCallsOrThrow(
  traces: McpTrace[],
  artifactsDir: string
): ObservedSprintToolCall[] {
  const teamemTrace = traces.find((trace) => trace.serverName === 'teamem');
  if (!teamemTrace) {
    throw new Error(
      `Expected core teamem MCP trace. Artifacts: ${artifactsDir}`
    );
  }

  const observedCalls: ObservedSprintToolCall[] = [];
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
        `Expected safe Sprint MCP tools/call name metadata at index ${index}. Artifacts: ${artifactsDir}`
      );
    }
    observedCalls.push({
      toolName: normalizeTeamemToolName(toolName),
      arguments: readToolCallArguments(message),
      traceIndex: index
    });
  }

  return observedCalls;
}

function assertSprintToolCallArguments(input: {
  calls: ObservedSprintToolCall[];
  sprint: SprintSummary;
  artifactsDir: string;
}): void {
  expectToolCall(input.calls, 0, 'create_sprint', input.artifactsDir, {
    display_name: input.sprint.display_name,
    goal: input.sprint.goal
  });
  expectToolCall(input.calls, 3, 'get_sprint_history', input.artifactsDir, {
    sprint: input.sprint.slug,
    limit: 10
  });
  expectToolCall(input.calls, 5, 'join_sprint', input.artifactsDir, {
    sprint: input.sprint.slug
  });
  expectToolCall(input.calls, 8, 'archive_sprint', input.artifactsDir, {
    sprint: input.sprint.slug
  });
  expectToolCall(input.calls, 9, 'reopen_sprint', input.artifactsDir, {
    sprint: input.sprint.slug
  });
  expectToolCall(input.calls, 11, 'get_sprint_history', input.artifactsDir, {
    sprint: input.sprint.slug,
    limit: 20
  });
}

function expectToolCall(
  calls: ObservedSprintToolCall[],
  index: number,
  toolName: SprintToolName,
  artifactsDir: string,
  expectedArguments: Record<string, unknown>
): void {
  const call = calls[index];
  if (!call) {
    throw new Error(
      `Expected ${toolName} tools/call at sequence index ${index}. Artifacts: ${artifactsDir}`
    );
  }
  expect(call.toolName).toBe(toolName);
  expectToolArguments(call.arguments, expectedArguments);
}

function expectToolArguments(
  actualArguments: Record<string, unknown>,
  expectedArguments: Record<string, unknown>
): void {
  expect(
    normalizeNumericExpectedArguments(actualArguments, expectedArguments)
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

function eventTypes(history: SprintHistoryData): string[] {
  return history.events.map((event) => event.event_type);
}

function expectSprintContext(
  context: SprintContext,
  artifacts: RunArtifacts
): Extract<SprintContext, { mode: 'sprint' }> {
  if (context.mode !== 'sprint' || !context.sprint) {
    throw new Error(
      `Expected Sprint context, observed ${JSON.stringify(context)}. ${artifactPathsFromRun(artifacts)}`
    );
  }
  return context;
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

function assertTranscriptOutputEvidence(
  session: InteractiveSession,
  input: {
    prompts: Record<string, string>;
    sprint: SprintSummary;
    lifecycle: {
      create: SprintLifecycleData;
      leaveAfterCreate: SprintLifecycleData;
      join: SprintLifecycleData;
      leaveBeforeArchive: SprintLifecycleData;
      reopen: SprintLifecycleData;
    };
    archive: SprintArchiveData;
  }
): void {
  const visibleOutput = commandOutputWithoutSubmittedPrompts({
    session,
    prompts: Object.values(input.prompts)
  });
  const artifacts = artifactPathsFromRun(session.artifacts);

  assertVisibleCommandOutput(visibleOutput, input.lifecycle.create.message, {
    label: 'create lifecycle message',
    artifacts
  });
  assertVisibleCommandOutput(
    visibleOutput,
    input.lifecycle.leaveAfterCreate.message,
    { label: 'leave after create lifecycle message', artifacts }
  );
  assertVisibleCommandOutput(visibleOutput, input.lifecycle.join.message, {
    label: 'join lifecycle message',
    artifacts
  });
  assertVisibleCommandOutput(
    visibleOutput,
    input.lifecycle.leaveBeforeArchive.message,
    { label: 'leave before archive lifecycle message', artifacts }
  );
  assertVisibleCommandOutput(visibleOutput, input.archive.message, {
    label: 'archive lifecycle message',
    artifacts
  });
  assertVisibleCommandOutput(visibleOutput, input.lifecycle.reopen.message, {
    label: 'reopen lifecycle message',
    artifacts
  });

  for (const text of [
    input.sprint.slug,
    input.sprint.display_name,
    input.sprint.goal
  ]) {
    assertVisibleCommandOutput(visibleOutput, text, {
      label: 'Sprint context output',
      artifacts
    });
  }
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
      `Expected /teamem:sprint output to include ${input.label}: ${JSON.stringify(expectedText)}. ${input.artifacts}`
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

async function assertDurableRuntimeState(sprint: SprintSummary): Promise<void> {
  if (!runtimePrerequisite.ok) {
    throw new Error(runtimePrerequisite.reason);
  }

  const [current, list, history] = await Promise.all([
    callLiveRuntimeTool<SprintCurrentData>(
      runtimePrerequisite.selectedEntry,
      'teamem.get_current_sprint',
      {}
    ),
    callLiveRuntimeTool<SprintListData>(
      runtimePrerequisite.selectedEntry,
      'teamem.list_sprints',
      {}
    ),
    callLiveRuntimeTool<SprintHistoryData>(
      runtimePrerequisite.selectedEntry,
      'teamem.get_sprint_history',
      { sprint: sprint.slug, limit: 20 }
    )
  ]);

  expect(current.data.context.mode).toBe('sprint');
  expect(current.data.sprint?.slug).toBe(sprint.slug);
  expect(
    list.data.sprints.some(
      (candidate) =>
        candidate.slug === sprint.slug && candidate.status === 'active'
    )
  ).toBe(true);
  for (const eventType of [
    'sprint_created',
    'sprint_joined',
    'sprint_left',
    'sprint_archived',
    'sprint_reopened'
  ]) {
    expect(eventTypes(history.data)).toContain(eventType);
  }
}

async function cleanupRemoteSprint(sprint: SprintSummary): Promise<void> {
  if (!runtimePrerequisite.ok) {
    throw new Error(runtimePrerequisite.reason);
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
