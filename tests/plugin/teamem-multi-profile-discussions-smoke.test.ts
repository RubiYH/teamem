import { describe, expect, it } from 'bun:test';
import { readFile, stat, writeFile } from 'node:fs/promises';
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
  checkJwtExp,
  loadCredentials,
  pickEntry,
  type CredentialEntry
} from '../../src/bridge/credentials.js';
import {
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

const liveGateEnabled = process.env.TEAMEM_CLAUDE_PLUGIN_E2E === '1';
const interactiveGateEnabled =
  process.env.TEAMEM_CLAUDE_PLUGIN_INTERACTIVE_E2E === '1';
const statefulGateEnabled =
  process.env.TEAMEM_CLAUDE_PLUGIN_STATEFUL_E2E === '1';
const multiProfileGateEnabled =
  process.env[TEAMEM_MULTI_PROFILE_E2E_ENV] === '1';
const unredactedTraceGateEnabled =
  process.env.CLAUDE_PLUGIN_E2E_ALLOW_UNREDACTED === '1';
const liveMultiProfileDiscussionsGateEnabled =
  liveGateEnabled &&
  interactiveGateEnabled &&
  statefulGateEnabled &&
  multiProfileGateEnabled &&
  unredactedTraceGateEnabled;
const describeLiveMultiProfileDiscussions =
  liveMultiProfileDiscussionsGateEnabled ? describe : describe.skip;
const interactivePermissionMode = liveMultiProfileDiscussionsGateEnabled
  ? resolveTeamemInteractivePermissionMode(
      process.env,
      DEFAULT_TEAMEM_INTERACTIVE_SCRIPT_PERMISSION_MODE
    )
  : DEFAULT_TEAMEM_INTERACTIVE_PERMISSION_MODE;

const repoRoot = process.cwd();
const teamemPluginDir = join(repoRoot, 'plugin');
const LIVE_MULTI_PROFILE_DISCUSSIONS_TIMEOUT_MS = 300_000;
const INTERACTIVE_READINESS_TIMEOUT_MS = 30_000;
const INTERACTIVE_WAIT_TIMEOUT_MS = 60_000;
const INTERACTIVE_CLOSE_TIMEOUT_MS = 10_000;
const INTERACTIVE_STARTUP_SETTLE_MS = 2_000;
const INTERACTIVE_TYPE_DELAY_MS = 20;
const pluginScopedToolPrefix = 'mcp__plugin_teamem_teamem__teamem_';
const canonicalTeamemToolPrefix = 'mcp__teamem__teamem_';

type MultiProfilePersonaPlan = MultiProfileRunPlan['personaPlans'][number];

type DiscussionPostEvidence = {
  message_id: string;
  thread_id: string;
  event_id: string;
  delivery_scope: 'direct' | 'sprint' | 'space';
  sprint_id: string | null;
  recipient_principals: string[];
};

type DiscussionMessageEvidence = {
  message_id: string;
  thread_id: string;
  sender_principal: string;
  recipient_principal: string | null;
  body: string;
  in_reply_to: string | null;
  created_at: string;
};

type ReadThreadEvidence = {
  messages: DiscussionMessageEvidence[];
};

describeLiveMultiProfileDiscussions(
  `Teamem L5 multi-profile Discussions stream smoke${liveMultiProfileDiscussionsGateEnabled ? '' : ` (${formatGateReason()})`}`,
  () => {
    it(
      'sends direct and Space-wide discussion messages from Alice TTY and proves Bob visibility through runtime read_thread',
      async () => {
        let workspace: DemoRepositoryWorkspace | undefined;
        let plan: MultiProfileRunPlan | undefined;
        const sessions: InteractiveSession[] = [];
        let success = false;

        try {
          workspace = await createDemoRepositoryWorkspace({
            teamemSourceRoot: repoRoot
          });
          const runId = createDiscussionRunId();
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

          const directBody = `teamem-l5-discuss-direct ${runId} alice-to-bob`;
          const broadcastBody = `teamem-l5-discuss-space ${runId} alice-to-space`;
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

          const directPrompt = await aliceTester.slashCommandPrompt(
            'teamem-discuss',
            `${bobRuntime.whoami.principal} -- ${directBody}`
          );
          const broadcastPrompt = await aliceTester.slashCommandPrompt(
            'teamem-discuss',
            `** -- ${broadcastBody}`
          );

          const aliceSession = await aliceTester.launchInteractive({
            useInstrumentedMcpConfig: true,
            strictMcpConfig: true,
            permissionMode: interactivePermissionMode,
            allowedTools: [
              `${pluginScopedToolPrefix}post_message`,
              `${canonicalTeamemToolPrefix}post_message`
            ],
            disallowedTools: [
              'mcp__plugin_teamem_channel__*',
              'mcp__teamem-channel__*',
              `${canonicalTeamemToolPrefix}whoami`,
              `${canonicalTeamemToolPrefix}get_current_sprint`,
              `${canonicalTeamemToolPrefix}list_claims`,
              `${canonicalTeamemToolPrefix}get_briefing`,
              `${canonicalTeamemToolPrefix}read_thread`,
              `${canonicalTeamemToolPrefix}claim_scope`,
              `${canonicalTeamemToolPrefix}release_scope`,
              `${canonicalTeamemToolPrefix}force_release`,
              `${canonicalTeamemToolPrefix}record_decision`,
              `${canonicalTeamemToolPrefix}share_finding`,
              `${canonicalTeamemToolPrefix}list_sprints`,
              `${pluginScopedToolPrefix}whoami`,
              `${pluginScopedToolPrefix}get_current_sprint`,
              `${pluginScopedToolPrefix}list_claims`,
              `${pluginScopedToolPrefix}get_briefing`,
              `${pluginScopedToolPrefix}read_thread`,
              `${pluginScopedToolPrefix}claim_scope`,
              `${pluginScopedToolPrefix}release_scope`,
              `${pluginScopedToolPrefix}force_release`,
              `${pluginScopedToolPrefix}record_decision`,
              `${pluginScopedToolPrefix}share_finding`,
              `${pluginScopedToolPrefix}list_sprints`
            ],
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

          await delay(INTERACTIVE_STARTUP_SETTLE_MS);
          await aliceSession.submit(directPrompt, {
            delayMs: INTERACTIVE_TYPE_DELAY_MS
          });
          const directTraces = await waitForDiscussionPosts(aliceSession, 1);
          assertNoChannelTraces(directTraces);
          const directPost = readPostMessageEvidence({
            traces: directTraces,
            artifactsDir: aliceSession.artifacts.dir,
            body: directBody
          });
          expect(directPost.delivery_scope).toBe('direct');
          expect(directPost.recipient_principals).toEqual([
            bobRuntime.whoami.principal
          ]);

          await aliceSession.submit(broadcastPrompt, {
            delayMs: INTERACTIVE_TYPE_DELAY_MS
          });
          const broadcastTraces = await waitForDiscussionPosts(aliceSession, 2);
          assertNoChannelTraces(broadcastTraces);
          const broadcastPost = readPostMessageEvidence({
            traces: broadcastTraces,
            artifactsDir: aliceSession.artifacts.dir,
            body: broadcastBody
          });
          expect(broadcastPost.delivery_scope).toBe('space');
          expect(broadcastPost.sprint_id).toBeNull();
          expect(broadcastPost.recipient_principals).toEqual([]);

          const directThread = await readBobThread({
            bobEntry: bobRuntime.entry,
            threadId: directPost.thread_id
          });
          const broadcastThread = await readBobThread({
            bobEntry: bobRuntime.entry,
            threadId: broadcastPost.thread_id
          });
          const directMessage = requireMessageWithBody(
            directThread.data,
            directBody
          );
          const broadcastMessage = requireMessageWithBody(
            broadcastThread.data,
            broadcastBody
          );
          expect(directMessage.sender_principal).toBe(
            aliceRuntime.whoami.principal
          );
          expect(directMessage.recipient_principal).toBe(
            bobRuntime.whoami.principal
          );
          expect(broadcastMessage.sender_principal).toBe(
            aliceRuntime.whoami.principal
          );
          expect(broadcastMessage.recipient_principal).toBeNull();

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
          const bobSession = await bobTester.launchInteractive({
            useInstrumentedMcpConfig: true,
            strictMcpConfig: true,
            permissionMode: interactivePermissionMode,
            disallowedTools: [
              'mcp__plugin_teamem_channel__*',
              'mcp__teamem-channel__*'
            ],
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
          await bobSession.close();
          await aliceSession.close();

          await writeDiscussionArtifacts({
            plan,
            alicePlan,
            bobPlan,
            aliceSession,
            runId,
            directPrompt,
            broadcastPrompt,
            directBody,
            broadcastBody,
            directPost,
            broadcastPost,
            directThread: directThread.data,
            broadcastThread: broadcastThread.data,
            aliceWhoami: aliceRuntime.whoami,
            bobWhoami: bobRuntime.whoami
          });
          await assertPersonaArtifacts(aliceSession, aliceEnv);
          await assertPersonaArtifacts(bobSession, bobEnv);
          success = true;
        } finally {
          for (const session of sessions) {
            try {
              await session.close();
            } catch {
              // Preserve the original failure and artifact paths.
            }
          }
          if (plan) {
            const cleanup = await finishMultiProfileRun(plan, { success });
            if (cleanup.preserved) {
              console.error(
                `Preserving failed multi-profile Discussions smoke artifacts at ${cleanup.artifactsDir}`
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
                `Preserving failed multi-profile Discussions demo workspace at ${cleanup.demoWorkspaceLaunchCwd}${cleanup.artifactPath ? ` (report ${cleanup.artifactPath})` : ''}`
              );
            }
          }
        }
      },
      LIVE_MULTI_PROFILE_DISCUSSIONS_TIMEOUT_MS
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

async function waitForDiscussionPosts(
  session: InteractiveSession,
  expectedCount: number
): Promise<McpTrace[]> {
  const deadline = Date.now() + INTERACTIVE_WAIT_TIMEOUT_MS;
  let lastTraceSummary = 'no MCP traces observed';

  while (Date.now() < deadline) {
    const traces = await readMcpTraces(session.artifacts.mcpTraceDir, {
      ignoreTransientErrors: true
    });
    const responses = successfulToolResponseMessages(traces, 'post_message');
    if (responses.length >= expectedCount) {
      return traces;
    }
    lastTraceSummary =
      traces.length === 0
        ? 'no MCP traces observed'
        : traces
            .map(
              (trace) =>
                `${trace.serverName}:${
                  trace.messages
                    .map(
                      (message) => message.metadata?.toolName ?? message.method
                    )
                    .join(',') || 'no messages'
                }`
            )
            .join('; ');
    await delay(250);
  }

  throw new Error(
    `Timed out waiting for ${expectedCount} successful post_message responses after ${INTERACTIVE_WAIT_TIMEOUT_MS}ms. Last trace summary: ${lastTraceSummary}. Artifacts: ${session.artifacts.dir}`
  );
}

function readPostMessageEvidence(input: {
  traces: McpTrace[];
  artifactsDir: string;
  body: string;
}): DiscussionPostEvidence {
  const messages = successfulToolResponseMessages(input.traces, 'post_message');
  for (const message of messages) {
    const request = findRequestForResponse(input.traces, message);
    const requestArgs = readRequestArguments(request);
    if (requestArgs.body !== input.body) continue;
    const data = extractToolResponseData(message);
    if (!data) {
      throw new Error(
        `Expected unredacted post_message response data for ${input.body}. Set CLAUDE_PLUGIN_E2E_ALLOW_UNREDACTED=1. Artifacts: ${input.artifactsDir}`
      );
    }
    return parseDiscussionPostEvidence(data, input.artifactsDir);
  }

  throw new Error(
    `Expected post_message MCP evidence for body "${input.body}". Artifacts: ${input.artifactsDir}`
  );
}

function successfulToolResponseMessages(
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

      return expectedToolName
        ? normalizeToolName(message.metadata.toolName) === expectedToolName
        : true;
    });
}

function findRequestForResponse(
  traces: McpTrace[],
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
  const args = isRecord(params.arguments) ? params.arguments : {};
  return args;
}

function parseDiscussionPostEvidence(
  data: Record<string, unknown>,
  artifactsDir: string
): DiscussionPostEvidence {
  return {
    message_id: readStringField(data, 'message_id', artifactsDir),
    thread_id: readStringField(data, 'thread_id', artifactsDir),
    event_id: readStringField(data, 'event_id', artifactsDir),
    delivery_scope: readDeliveryScope(data, artifactsDir),
    sprint_id: readNullableStringField(data, 'sprint_id', artifactsDir),
    recipient_principals: readStringArrayField(
      data,
      'recipient_principals',
      artifactsDir
    )
  };
}

async function readBobThread(input: {
  bobEntry: CredentialEntry;
  threadId: string;
}) {
  return callLiveRuntimeTool<ReadThreadEvidence>(
    input.bobEntry,
    'teamem.read_thread',
    {
      thread_id: input.threadId,
      limit: 10
    }
  );
}

function requireMessageWithBody(
  data: ReadThreadEvidence,
  body: string
): DiscussionMessageEvidence {
  const message = data.messages.find((candidate) => candidate.body === body);
  if (!message) {
    throw new Error(
      `Expected Bob read_thread evidence to contain discussion body "${body}". Observed: ${JSON.stringify(data.messages)}`
    );
  }
  return message;
}

async function writeDiscussionArtifacts(input: {
  plan: MultiProfileRunPlan;
  alicePlan: MultiProfilePersonaPlan;
  bobPlan: MultiProfilePersonaPlan;
  aliceSession: InteractiveSession;
  runId: string;
  directPrompt: string;
  broadcastPrompt: string;
  directBody: string;
  broadcastBody: string;
  directPost: DiscussionPostEvidence;
  broadcastPost: DiscussionPostEvidence;
  directThread: ReadThreadEvidence;
  broadcastThread: ReadThreadEvidence;
  aliceWhoami: RuntimeWhoamiEvidence;
  bobWhoami: RuntimeWhoamiEvidence;
}): Promise<void> {
  await writeFile(
    join(
      input.alicePlan.runtimeEvidenceDir,
      `${input.alicePlan.persona}-discussion-posts-${input.runId}.json`
    ),
    `${JSON.stringify(
      {
        runId: input.runId,
        persona: input.alicePlan.persona,
        profileName: input.alicePlan.profile.profileName,
        profileCredentialsPath: input.alicePlan.profile.credentialsPath,
        aliceWhoami: input.aliceWhoami,
        bobWhoami: input.bobWhoami,
        direct: {
          prompt: input.directPrompt,
          body: input.directBody,
          post: input.directPost
        },
        spaceWide: {
          prompt: input.broadcastPrompt,
          body: input.broadcastBody,
          post: input.broadcastPost
        },
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
      `${input.bobPlan.persona}-read-thread-${input.runId}.json`
    ),
    `${JSON.stringify(
      {
        runId: input.runId,
        persona: input.bobPlan.persona,
        profileName: input.bobPlan.profile.profileName,
        profileCredentialsPath: input.bobPlan.profile.credentialsPath,
        aliceWhoami: input.aliceWhoami,
        bobWhoami: input.bobWhoami,
        direct: {
          post: input.directPost,
          readThread: input.directThread
        },
        spaceWide: {
          post: input.broadcastPost,
          readThread: input.broadcastThread
        }
      },
      null,
      2
    )}\n`
  );
  await writeFile(
    join(input.plan.artifactsDir, `discussion-run-${input.runId}.json`),
    `${JSON.stringify(
      {
        runId: input.runId,
        artifactsDir: input.plan.artifactsDir,
        directThreadId: input.directPost.thread_id,
        spaceWideThreadId: input.broadcastPost.thread_id,
        directDeliveryScope: input.directPost.delivery_scope,
        spaceWideDeliveryScope: input.broadcastPost.delivery_scope,
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
  expect(environment.env ?? {}).toMatchObject({
    CLAUDE_PLUGIN_DATA: profileEnv.CLAUDE_PLUGIN_DATA,
    CLAUDE_PLUGIN_ROOT: profileEnv.CLAUDE_PLUGIN_ROOT
  });
}

function extractToolResponseData(
  message: McpTraceMessage
): Record<string, unknown> | undefined {
  if (!isRecord(message.json)) {
    return undefined;
  }
  const result = isRecord(message.json.result)
    ? message.json.result
    : undefined;
  const structuredContent = isRecord(result?.structuredContent)
    ? result.structuredContent
    : undefined;
  if (isRecord(structuredContent?.data)) {
    return structuredContent.data;
  }

  if (!Array.isArray(result?.content)) {
    return undefined;
  }
  const textBlock = result.content.find(
    (item) =>
      isRecord(item) && item.type === 'text' && typeof item.text === 'string'
  );
  if (!isRecord(textBlock) || typeof textBlock.text !== 'string') {
    return undefined;
  }

  try {
    const parsed = JSON.parse(textBlock.text) as unknown;
    if (isRecord(parsed) && isRecord(parsed.data)) {
      return parsed.data;
    }
  } catch {
    return undefined;
  }
  return undefined;
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

function normalizeToolName(toolName: string): string {
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

function assertNoChannelTraces(traces: McpTrace[]): void {
  expect(traces.some((trace) => trace.serverName === 'teamem-channel')).toBe(
    false
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatGateReason(): string {
  return `set TEAMEM_CLAUDE_PLUGIN_E2E=1, TEAMEM_CLAUDE_PLUGIN_INTERACTIVE_E2E=1, TEAMEM_CLAUDE_PLUGIN_STATEFUL_E2E=1, ${TEAMEM_MULTI_PROFILE_E2E_ENV}=1, and CLAUDE_PLUGIN_E2E_ALLOW_UNREDACTED=1 to run L5 multi-profile Discussions Claude plugin smoke`;
}

function createDiscussionRunId(): string {
  return `${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
