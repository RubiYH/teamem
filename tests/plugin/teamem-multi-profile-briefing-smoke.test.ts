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
const multiProfileGateEnabled =
  process.env[TEAMEM_MULTI_PROFILE_E2E_ENV] === '1';
const unredactedTraceGateEnabled =
  process.env.CLAUDE_PLUGIN_E2E_ALLOW_UNREDACTED === '1';
const liveMultiProfileGateEnabled =
  liveGateEnabled &&
  interactiveGateEnabled &&
  multiProfileGateEnabled &&
  unredactedTraceGateEnabled;
const describeLiveMultiProfile = liveMultiProfileGateEnabled
  ? describe
  : describe.skip;
const interactivePermissionMode = liveMultiProfileGateEnabled
  ? resolveTeamemInteractivePermissionMode(
      process.env,
      DEFAULT_TEAMEM_INTERACTIVE_SCRIPT_PERMISSION_MODE
    )
  : DEFAULT_TEAMEM_INTERACTIVE_PERMISSION_MODE;

const repoRoot = process.cwd();
const teamemPluginDir = join(repoRoot, 'plugin');
const LIVE_MULTI_PROFILE_TIMEOUT_MS = 300_000;
const INTERACTIVE_READINESS_TIMEOUT_MS = 30_000;
const INTERACTIVE_WAIT_TIMEOUT_MS = 60_000;
const INTERACTIVE_CLOSE_TIMEOUT_MS = 10_000;
const INTERACTIVE_STARTUP_SETTLE_MS = 2_000;
const INTERACTIVE_TYPE_DELAY_MS = 20;
const pluginScopedToolPrefix = 'mcp__plugin_teamem_teamem__teamem_';
const canonicalTeamemToolPrefix = 'mcp__teamem__teamem_';
const requiredStatusTools = [
  'whoami',
  'get_current_sprint',
  'list_claims',
  'get_briefing'
] as const;
const briefingSectionKeys = [
  'current_plan',
  'active_claims',
  'recent_decisions',
  'active_risks',
  'recent_progress'
] as const;

type MultiProfilePersonaPlan = MultiProfileRunPlan['personaPlans'][number];

describeLiveMultiProfile(
  `Teamem L5 multi-profile status and briefing smoke${liveMultiProfileGateEnabled ? '' : ` (${formatGateReason()})`}`,
  () => {
    it(
      'plans Alice and Bob through teamem dev claude and proves whoami/status/briefing with separated evidence',
      async () => {
        let workspace: DemoRepositoryWorkspace | undefined;
        let plan: MultiProfileRunPlan | undefined;
        const sessions: InteractiveSession[] = [];
        let success = false;

        try {
          workspace = await createDemoRepositoryWorkspace({
            teamemSourceRoot: repoRoot
          });
          plan = await planTeamemDevClaudeMultiProfileRun({
            personas: defaultMultiProfilePersonas(),
            teamemRoot: repoRoot,
            workspace,
            artifactsParentDir: tmpdir()
          });

          expect(plan.personaPlans).toHaveLength(2);
          expect(plan.teamemRoot).toBe(repoRoot);
          expect(plan.demoWorkspaceLaunchCwd).toBe(
            workspace.demoWorkspaceLaunchCwd
          );

          for (const personaPlan of plan.personaPlans) {
            const profileRuntime = await inspectProfileRuntime(
              personaPlan.profile.credentialsPath
            );
            const profileEnv = createProfileRuntimeEnv(
              personaPlan.profile,
              teamemPluginDir
            );
            const tester = createClaudePluginTester({
              pluginDir: teamemPluginDir,
              cwd: workspace.demoWorkspaceLaunchCwd,
              artifactsDir: personaPlan.artifactDir,
              cleanup: 'never',
              mcp: TEAMEM_MCP_INSTRUMENTATION_OPTIONS,
              env: profileEnv,
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
            assertDevLaunchPlanParity({
              personaPlan,
              profileEnv,
              boot,
              launchCwd: workspace.demoWorkspaceLaunchCwd
            });

            const statusPrompt =
              await tester.slashCommandPrompt('teamem-status');
            const briefingPrompt =
              await tester.slashCommandPrompt('teamem-briefing');
            const session = await tester.launchInteractive({
              useInstrumentedMcpConfig: true,
              strictMcpConfig: true,
              permissionMode: interactivePermissionMode,
              allowedTools: [
                'Bash(${CLAUDE_PLUGIN_ROOT}/bin/teamem-flag:*)',
                `${pluginScopedToolPrefix}whoami`,
                `${pluginScopedToolPrefix}get_current_sprint`,
                `${pluginScopedToolPrefix}list_claims`,
                `${pluginScopedToolPrefix}get_briefing`,
                `${canonicalTeamemToolPrefix}whoami`,
                `${canonicalTeamemToolPrefix}get_current_sprint`,
                `${canonicalTeamemToolPrefix}list_claims`,
                `${canonicalTeamemToolPrefix}get_briefing`
              ],
              disallowedTools: [
                'mcp__plugin_teamem_channel__*',
                'mcp__teamem-channel__*',
                `${canonicalTeamemToolPrefix}claim_scope`,
                `${canonicalTeamemToolPrefix}release_scope`,
                `${canonicalTeamemToolPrefix}force_release`,
                `${canonicalTeamemToolPrefix}post_message`,
                `${canonicalTeamemToolPrefix}record_decision`,
                `${canonicalTeamemToolPrefix}list_sprints`,
                `${pluginScopedToolPrefix}claim_scope`,
                `${pluginScopedToolPrefix}release_scope`,
                `${pluginScopedToolPrefix}force_release`,
                `${pluginScopedToolPrefix}post_message`,
                `${pluginScopedToolPrefix}record_decision`,
                `${pluginScopedToolPrefix}list_sprints`
              ],
              readiness: isClaudeInteractiveReadyOrSafetyPrompt,
              readinessTimeoutMs: INTERACTIVE_READINESS_TIMEOUT_MS,
              waitTimeoutMs: INTERACTIVE_WAIT_TIMEOUT_MS,
              closeTimeoutMs: INTERACTIVE_CLOSE_TIMEOUT_MS
            });
            sessions.push(session);
            await acceptClaudeStartupPromptsIfPresent(
              session,
              INTERACTIVE_READINESS_TIMEOUT_MS
            );
            assertInteractiveLaunchParity({
              personaPlan,
              boot,
              session,
              launchCwd: workspace.demoWorkspaceLaunchCwd
            });

            await delay(INTERACTIVE_STARTUP_SETTLE_MS);
            await session.submit(statusPrompt, {
              delayMs: INTERACTIVE_TYPE_DELAY_MS
            });
            const statusTraces = await waitForStatusEvidence(session);
            assertNoChannelTraces(statusTraces);
            assertStatusEvidence({
              traces: statusTraces,
              artifactsDir: session.artifacts.dir,
              expectedWhoami: profileRuntime.whoami
            });
            const briefingCount = countSuccessfulToolResponses(
              statusTraces,
              'get_briefing'
            );

            await session.submit(briefingPrompt, {
              delayMs: INTERACTIVE_TYPE_DELAY_MS
            });
            const briefingTraces = await waitForAdditionalBriefingEvidence(
              session,
              briefingCount
            );
            assertNoChannelTraces(briefingTraces);
            assertStatusEvidence({
              traces: briefingTraces,
              artifactsDir: session.artifacts.dir,
              expectedWhoami: profileRuntime.whoami
            });
            assertBriefingEvidence({
              traces: briefingTraces,
              artifactsDir: session.artifacts.dir,
              previousBriefingResponseCount: briefingCount
            });
            await session.close();

            await assertPersonaArtifacts(session, profileEnv);
            await writeFile(
              join(
                personaPlan.runtimeEvidenceDir,
                `${personaPlan.persona}-whoami-status-briefing.json`
              ),
              `${JSON.stringify(
                {
                  persona: personaPlan.persona,
                  profileName: personaPlan.profile.profileName,
                  profileCredentialsPath: personaPlan.profile.credentialsPath,
                  preflightWhoami: profileRuntime.whoami,
                  mcpWhoami: readWhoamiMcpResponseData(
                    briefingTraces,
                    session.artifacts.dir
                  ),
                  statusTools: observedToolNames(briefingTraces),
                  successfulStatusResponses:
                    observedSuccessfulToolResponses(briefingTraces),
                  artifactRunDir: session.artifacts.dir,
                  rawTranscriptPath: session.artifacts.rawTranscriptPath,
                  normalizedTranscriptPath:
                    session.artifacts.normalizedTranscriptPath,
                  mcpTraceDir: session.artifacts.mcpTraceDir,
                  hookTraceDir: session.artifacts.hookTraceDir
                },
                null,
                2
              )}\n`
            );
            await writeFile(
              join(
                personaPlan.transcriptDir,
                `${personaPlan.persona}-transcript-pointers.json`
              ),
              `${JSON.stringify(
                {
                  rawTranscriptPath: session.artifacts.rawTranscriptPath,
                  normalizedTranscriptPath:
                    session.artifacts.normalizedTranscriptPath,
                  interactiveEventsPath: session.artifacts.interactiveEventsPath
                },
                null,
                2
              )}\n`
            );
          }

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
                `Preserving failed multi-profile smoke artifacts at ${cleanup.artifactsDir}`
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
                `Preserving failed multi-profile demo workspace at ${cleanup.demoWorkspaceLaunchCwd}${cleanup.artifactPath ? ` (report ${cleanup.artifactPath})` : ''}`
              );
            }
          }
        }
      },
      LIVE_MULTI_PROFILE_TIMEOUT_MS
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
  expect(dryRunOutput).toContain(
    'Env keys: CLAUDE_CONFIG_DIR, CLAUDE_CODE_PLUGIN_CACHE_DIR, CLAUDE_CODE_MCP_ALLOWLIST_ENV, CLAUDE_PLUGIN_DATA, CLAUDE_PLUGIN_ROOT, TEAMEM_CREDENTIALS, TEAMEM_CLAUDE_LAUNCH_INTENT'
  );
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

async function waitForStatusEvidence(
  session: InteractiveSession
): Promise<McpTrace[]> {
  return waitForMcpEvidence(session, hasRequiredStatusMcpEvidence);
}

async function waitForAdditionalBriefingEvidence(
  session: InteractiveSession,
  previousBriefingCount: number
): Promise<McpTrace[]> {
  return waitForMcpEvidence(
    session,
    (traces) =>
      countSuccessfulToolResponses(traces, 'get_briefing') >
      previousBriefingCount
  );
}

async function waitForMcpEvidence(
  session: InteractiveSession,
  predicate: (traces: McpTrace[]) => boolean
): Promise<McpTrace[]> {
  const deadline = Date.now() + INTERACTIVE_WAIT_TIMEOUT_MS;
  let lastTraceSummary = 'no MCP traces observed';

  while (Date.now() < deadline) {
    const traces = await readMcpTraces(session.artifacts.mcpTraceDir, {
      ignoreTransientErrors: true
    });
    if (predicate(traces)) {
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
    `Timed out waiting for multi-profile MCP evidence after ${INTERACTIVE_WAIT_TIMEOUT_MS}ms. Last trace summary: ${lastTraceSummary}. Artifacts: ${session.artifacts.dir}`
  );
}

function hasRequiredStatusMcpEvidence(traces: McpTrace[]): boolean {
  const observedTools = observedToolNames(traces);
  const successfulResponses = observedSuccessfulToolResponses(traces);

  return requiredStatusTools.every(
    (toolName) =>
      observedTools.includes(toolName) && successfulResponses.includes(toolName)
  );
}

function assertStatusEvidence(input: {
  traces: McpTrace[];
  artifactsDir: string;
  expectedWhoami: RuntimeWhoamiEvidence;
}): void {
  const observedTools = observedToolNames(input.traces);
  const unexpectedTools = observedTools.filter(
    (toolName) => !isRequiredStatusTool(toolName)
  );
  if (unexpectedTools.length > 0) {
    throw new Error(
      `Expected only status MCP tools ${requiredStatusTools.join(', ')}, observed unexpected ${unexpectedTools.join(', ')}. Artifacts: ${input.artifactsDir}`
    );
  }

  const missingTools = requiredStatusTools.filter(
    (toolName) => !observedTools.includes(toolName)
  );
  if (missingTools.length > 0) {
    throw new Error(
      `Expected status MCP tool calls for ${missingTools.join(', ')}. Observed ${observedTools.join(', ') || 'none'}. Artifacts: ${input.artifactsDir}`
    );
  }

  const successfulResponses = observedSuccessfulToolResponses(input.traces);
  const missingSuccessfulResponses = requiredStatusTools.filter(
    (toolName) => !successfulResponses.includes(toolName)
  );
  if (missingSuccessfulResponses.length > 0) {
    throw new Error(
      `Expected successful status MCP responses for ${missingSuccessfulResponses.join(', ')}. Observed successful responses ${successfulResponses.join(', ') || 'none'}. ${summarizeTeamemResponseMetadata(input.traces)}. Artifacts: ${input.artifactsDir}`
    );
  }

  assertStatusResponseShapes(input.traces, input.artifactsDir);
  assertWhoamiResponseMatchesProfile(input);
}

function assertBriefingEvidence(input: {
  traces: McpTrace[];
  artifactsDir: string;
  previousBriefingResponseCount: number;
}): void {
  const successfulBriefingResponses = successfulToolResponseMessages(
    input.traces,
    'get_briefing'
  );
  const briefingResponseCount = successfulBriefingResponses.length;

  if (briefingResponseCount <= input.previousBriefingResponseCount) {
    throw new Error(
      `Expected briefing command to add a successful get_briefing MCP response after status. Previous ${input.previousBriefingResponseCount}, observed ${briefingResponseCount}. ${summarizeTeamemResponseMetadata(input.traces)}. Artifacts: ${input.artifactsDir}`
    );
  }

  const additionalResponses = successfulBriefingResponses.slice(
    input.previousBriefingResponseCount
  );
  for (const response of additionalResponses) {
    assertBriefingResponseShape(response, input.artifactsDir);
  }
}

function observedToolNames(traces: McpTrace[]): string[] {
  return traces
    .filter((trace) => trace.serverName === 'teamem')
    .flatMap((trace) => trace.messages)
    .filter(
      (message) =>
        message.direction === 'client-to-server' &&
        message.method === 'tools/call'
    )
    .map((message) => normalizeToolName(message.metadata?.toolName ?? ''))
    .filter((toolName) => toolName !== '');
}

function countSuccessfulToolResponses(
  traces: McpTrace[],
  toolName: string
): number {
  return successfulToolResponseMessages(traces, toolName).length;
}

function observedSuccessfulToolResponses(traces: McpTrace[]): string[] {
  return successfulToolResponseMessages(traces).map((message) =>
    normalizeToolName(message.metadata?.toolName ?? '')
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

function assertStatusResponseShapes(
  traces: McpTrace[],
  artifactsDir: string
): void {
  const requiredDataKeysByTool: Record<
    (typeof requiredStatusTools)[number],
    readonly string[]
  > = {
    whoami: ['principal', 'space_id', 'label'],
    get_current_sprint: ['context', 'sprint', 'current_members'],
    list_claims: ['claims'],
    get_briefing: briefingSectionKeys
  };

  for (const toolName of requiredStatusTools) {
    const [message] = successfulToolResponseMessages(traces, toolName);
    if (!message) {
      throw new Error(
        `Expected successful ${toolName} MCP response metadata. Artifacts: ${artifactsDir}`
      );
    }
    const response = message.metadata?.response;
    const responseDataKeys = new Set([
      ...(response?.contentTextJsonDataKeys ?? []),
      ...(response?.structuredContentKeys ?? [])
    ]);
    const missingKeys = requiredDataKeysByTool[toolName].filter(
      (key) => !responseDataKeys.has(key)
    );
    if (missingKeys.length > 0) {
      throw new Error(
        `Expected ${toolName} response metadata data keys to include ${requiredDataKeysByTool[toolName].join(', ')}; missing ${missingKeys.join(', ')}. Observed ${JSON.stringify(response)}. Artifacts: ${artifactsDir}`
      );
    }
  }
}

function assertBriefingResponseShape(
  message: McpTraceMessage,
  artifactsDir: string
): void {
  const response = message.metadata?.response;
  if (!response?.ok) {
    throw new Error(
      `Expected successful get_briefing MCP response metadata. Observed ${JSON.stringify(response)}. Artifacts: ${artifactsDir}`
    );
  }

  const responseSectionKeys = new Set([
    ...response.contentTextJsonDataKeys,
    ...response.structuredContentKeys
  ]);
  const missingSectionKeys = briefingSectionKeys.filter(
    (key) => !responseSectionKeys.has(key)
  );
  if (missingSectionKeys.length > 0) {
    throw new Error(
      `Expected get_briefing response metadata to include briefing section keys ${briefingSectionKeys.join(', ')}; missing ${missingSectionKeys.join(', ')}. Observed ${JSON.stringify(response)}. Artifacts: ${artifactsDir}`
    );
  }
}

function assertWhoamiResponseMatchesProfile(input: {
  traces: McpTrace[];
  artifactsDir: string;
  expectedWhoami: RuntimeWhoamiEvidence;
}): void {
  const actual = readWhoamiMcpResponseData(input.traces, input.artifactsDir);
  expect(actual).toEqual(input.expectedWhoami);
}

function readWhoamiMcpResponseData(
  traces: McpTrace[],
  artifactsDir: string
): RuntimeWhoamiEvidence {
  const [message] = successfulToolResponseMessages(traces, 'whoami');
  const data = message ? extractToolResponseData(message) : undefined;
  if (!data) {
    throw new Error(
      `Expected readable whoami MCP response data. Set CLAUDE_PLUGIN_E2E_ALLOW_UNREDACTED=1 so the smoke can compare persona identity. Artifacts: ${artifactsDir}`
    );
  }

  return {
    principal: readStringField(data, 'principal', artifactsDir),
    space_id: readStringField(data, 'space_id', artifactsDir),
    label: readStringField(data, 'label', artifactsDir)
  };
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
  key: keyof RuntimeWhoamiEvidence,
  artifactsDir: string
): string {
  const value = data[key];
  if (typeof value !== 'string') {
    throw new Error(
      `Expected whoami MCP response field ${key} to be a string. Observed ${JSON.stringify(data)}. Artifacts: ${artifactsDir}`
    );
  }
  return value;
}

function summarizeTeamemResponseMetadata(traces: McpTrace[]): string {
  const summaries = traces
    .filter((trace) => trace.serverName === 'teamem')
    .flatMap((trace) => trace.messages)
    .filter((message) => message.direction === 'server-to-client')
    .map((message) => {
      const toolName = message.metadata?.toolName
        ? normalizeToolName(message.metadata.toolName)
        : 'unknown';
      const response = message.metadata?.response;
      return `${toolName}:${response?.ok === true ? 'ok' : 'not-ok'}:${[
        ...(response?.contentTextJsonDataKeys ?? []),
        ...(response?.structuredContentKeys ?? [])
      ].join('|')}`;
    });

  return `Teamem response metadata: ${summaries.join(', ') || 'none'}`;
}

function isRequiredStatusTool(toolName: string): boolean {
  return requiredStatusTools.includes(
    toolName as (typeof requiredStatusTools)[number]
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

function formatGateReason(): string {
  return `set TEAMEM_CLAUDE_PLUGIN_E2E=1, TEAMEM_CLAUDE_PLUGIN_INTERACTIVE_E2E=1, ${TEAMEM_MULTI_PROFILE_E2E_ENV}=1, and CLAUDE_PLUGIN_E2E_ALLOW_UNREDACTED=1 to run L5 multi-profile Claude plugin smoke`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
