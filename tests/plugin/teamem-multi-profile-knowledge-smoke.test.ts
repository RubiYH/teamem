import { describe, expect, it } from 'bun:test';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createClaudePluginTester,
  normalizeTranscript,
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

type RuntimeBriefing = {
  recent_decisions?: Array<Record<string, unknown>>;
  recent_findings?: Array<Record<string, unknown>>;
};

type RuntimeFinding = {
  finding_id: string;
  summary: string;
  severity: string;
  tags: string[];
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
const liveMultiProfileKnowledgeGateEnabled =
  liveGateEnabled &&
  interactiveGateEnabled &&
  statefulGateEnabled &&
  multiProfileGateEnabled &&
  unredactedTraceGateEnabled;
const describeLiveMultiProfileKnowledge = liveMultiProfileKnowledgeGateEnabled
  ? describe
  : describe.skip;
const interactivePermissionMode = liveMultiProfileKnowledgeGateEnabled
  ? resolveTeamemInteractivePermissionMode(
      process.env,
      DEFAULT_TEAMEM_INTERACTIVE_SCRIPT_PERMISSION_MODE
    )
  : DEFAULT_TEAMEM_INTERACTIVE_PERMISSION_MODE;

const repoRoot = process.cwd();
const teamemPluginDir = join(repoRoot, 'plugin');
const LIVE_MULTI_PROFILE_KNOWLEDGE_TIMEOUT_MS = 300_000;
const INTERACTIVE_READINESS_TIMEOUT_MS = 30_000;
const INTERACTIVE_WAIT_TIMEOUT_MS = 75_000;
const INTERACTIVE_CLOSE_TIMEOUT_MS = 10_000;
const INTERACTIVE_STARTUP_SETTLE_MS = 2_000;
const INTERACTIVE_TYPE_DELAY_MS = 20;
const LIVE_RUNTIME_POLL_TIMEOUT_MS = 45_000;
const pluginScopedToolPrefix = 'mcp__plugin_teamem_teamem__teamem_';
const canonicalTeamemToolPrefix = 'mcp__teamem__teamem_';

type MultiProfilePersonaPlan = MultiProfileRunPlan['personaPlans'][number];

describeLiveMultiProfileKnowledge(
  `Teamem L5 multi-profile durable knowledge visibility smoke${liveMultiProfileKnowledgeGateEnabled ? '' : ` (${formatGateReason()})`}`,
  () => {
    it(
      'records Alice decision and gotcha through TTY and proves Bob sees both through runtime evidence',
      async () => {
        let workspace: DemoRepositoryWorkspace | undefined;
        let plan: MultiProfileRunPlan | undefined;
        const sessions: InteractiveSession[] = [];
        let success = false;

        try {
          workspace = await createDemoRepositoryWorkspace({
            teamemSourceRoot: repoRoot
          });
          const runId = createKnowledgeRunId();
          const runTag = `run-${runId.toLowerCase()}`;
          const decisionTitle = `L5 multi-profile decision ${runId}`;
          const decisionSummary = `Alice durable decision visible to Bob ${runId}`;
          const gotchaSummary = `Alice durable gotcha visible to Bob ${runId}`;

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

          const decisionPrompt = await aliceTester.slashCommandPrompt(
            'teamem-decide',
            `${decisionTitle} -- ${decisionSummary} --kind=process`
          );
          const gotchaPrompt = await aliceTester.slashCommandPrompt(
            'teamem-gotcha',
            `${gotchaSummary} #teamem-smoke #${runTag} --severity=info`
          );

          const aliceSession = await aliceTester.launchInteractive({
            useInstrumentedMcpConfig: true,
            strictMcpConfig: true,
            permissionMode: interactivePermissionMode,
            allowedTools: [
              'Bash(bash:*)',
              `${pluginScopedToolPrefix}record_decision`,
              `${pluginScopedToolPrefix}get_briefing`,
              `${canonicalTeamemToolPrefix}record_decision`,
              `${canonicalTeamemToolPrefix}get_briefing`
            ],
            disallowedTools: [
              'mcp__plugin_teamem_channel__*',
              'mcp__teamem-channel__*',
              `${canonicalTeamemToolPrefix}whoami`,
              `${canonicalTeamemToolPrefix}get_current_sprint`,
              `${canonicalTeamemToolPrefix}list_claims`,
              `${canonicalTeamemToolPrefix}read_thread`,
              `${canonicalTeamemToolPrefix}claim_scope`,
              `${canonicalTeamemToolPrefix}release_scope`,
              `${canonicalTeamemToolPrefix}force_release`,
              `${canonicalTeamemToolPrefix}post_message`,
              `${canonicalTeamemToolPrefix}share_finding`,
              `${canonicalTeamemToolPrefix}get_finding`,
              `${canonicalTeamemToolPrefix}acknowledge_finding`,
              `${canonicalTeamemToolPrefix}list_sprints`,
              `${pluginScopedToolPrefix}whoami`,
              `${pluginScopedToolPrefix}get_current_sprint`,
              `${pluginScopedToolPrefix}list_claims`,
              `${pluginScopedToolPrefix}read_thread`,
              `${pluginScopedToolPrefix}claim_scope`,
              `${pluginScopedToolPrefix}release_scope`,
              `${pluginScopedToolPrefix}force_release`,
              `${pluginScopedToolPrefix}post_message`,
              `${pluginScopedToolPrefix}share_finding`,
              `${pluginScopedToolPrefix}get_finding`,
              `${pluginScopedToolPrefix}acknowledge_finding`,
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
          await aliceSession.submit(decisionPrompt, {
            delayMs: INTERACTIVE_TYPE_DELAY_MS
          });
          const decisionTraces = await waitForDecisionEvidence(
            aliceSession,
            runId
          );
          assertNoChannelTraces(decisionTraces);
          assertDecisionMcpEvidence({
            traces: decisionTraces,
            artifactsDir: aliceSession.artifacts.dir,
            runId
          });

          await aliceSession.submit(gotchaPrompt, {
            delayMs: INTERACTIVE_TYPE_DELAY_MS
          });
          await aliceSession.waitFor(
            (transcript) =>
              hasSharedGotchaTranscriptEvidence(transcript, runTag),
            { timeoutMs: INTERACTIVE_WAIT_TIMEOUT_MS }
          );
          const findingId = parseSharedGotchaFindingId(
            aliceSession.normalizedTranscript(),
            aliceSession.artifacts.dir,
            runId
          );

          const bobDecisionBriefing = await waitForBobBriefing({
            bobEntry: bobRuntime.entry,
            runId,
            artifactsDir: plan.artifactsDir,
            itemDescription: `decision "${decisionTitle}"`,
            isComplete: (briefing) =>
              hasRuntimeDecision(briefing, {
                title: decisionTitle,
                summary: decisionSummary
              })
          });
          const bobBriefing = await waitForBobBriefing({
            bobEntry: bobRuntime.entry,
            runId,
            artifactsDir: plan.artifactsDir,
            itemDescription: `gotcha finding ${findingId}`,
            isComplete: (briefing) =>
              hasRuntimeFinding(briefing, {
                findingId,
                summary: gotchaSummary,
                tag: runTag,
                severity: 'info'
              })
          });
          requireRuntimeDecision({
            briefing: bobDecisionBriefing,
            title: decisionTitle,
            summary: decisionSummary,
            runId,
            artifactsDir: plan.artifactsDir
          });
          requireRuntimeFinding({
            briefing: bobBriefing,
            findingId,
            summary: gotchaSummary,
            tag: runTag,
            severity: 'info',
            runId,
            artifactsDir: plan.artifactsDir
          });
          const bobFinding = await readBobFinding({
            bobEntry: bobRuntime.entry,
            findingId,
            runId,
            artifactsDir: plan.artifactsDir
          });
          requireBobFindingDetails({
            finding: bobFinding,
            findingId,
            summary: gotchaSummary,
            tag: runTag,
            severity: 'info',
            runId,
            artifactsDir: plan.artifactsDir
          });

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

          await writeKnowledgeArtifacts({
            plan,
            alicePlan,
            bobPlan,
            aliceSession,
            bobSession,
            runId,
            decisionPrompt,
            gotchaPrompt,
            decisionTitle,
            decisionSummary,
            gotchaSummary,
            findingId,
            bobBriefing,
            bobFinding,
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
                `Preserving failed multi-profile knowledge smoke artifacts at ${cleanup.artifactsDir}`
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
                `Preserving failed multi-profile knowledge demo workspace at ${cleanup.demoWorkspaceLaunchCwd}${cleanup.artifactPath ? ` (report ${cleanup.artifactPath})` : ''}`
              );
            }
          }
        }
      },
      LIVE_MULTI_PROFILE_KNOWLEDGE_TIMEOUT_MS
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

async function waitForDecisionEvidence(
  session: InteractiveSession,
  runId: string
): Promise<McpTrace[]> {
  const deadline = Date.now() + INTERACTIVE_WAIT_TIMEOUT_MS;
  let lastTraceSummary = 'no MCP traces observed';

  while (Date.now() < deadline) {
    const traces = await readMcpTraces(session.artifacts.mcpTraceDir, {
      ignoreTransientErrors: true
    });
    if (successfulToolResponseMessages(traces, 'record_decision').length > 0) {
      return traces;
    }
    lastTraceSummary = summarizeMcpTraces(traces);
    await delay(250);
  }

  throw new Error(
    `Timed out waiting for Alice record_decision MCP evidence for run id ${runId}. Last trace summary: ${lastTraceSummary}. Artifacts: ${session.artifacts.dir}`
  );
}

async function waitForBobBriefing(input: {
  bobEntry: CredentialEntry;
  runId: string;
  artifactsDir: string;
  itemDescription: string;
  isComplete: (briefing: RuntimeBriefing) => boolean;
}): Promise<RuntimeBriefing> {
  const deadline = Date.now() + LIVE_RUNTIME_POLL_TIMEOUT_MS;
  let lastSummary = 'no runtime briefing observed';

  while (Date.now() < deadline) {
    const response = await callLiveRuntimeTool<RuntimeBriefing>(
      input.bobEntry,
      'teamem.get_briefing',
      { token_budget: 4000 }
    );

    if (input.isComplete(response.data)) {
      return response.data;
    }

    lastSummary = summarizeRuntimeBriefing(response.data);
    await delay(500);
  }

  throw new Error(
    `Timed out waiting for Bob-profile teamem.get_briefing visibility of ${input.itemDescription} for run id ${input.runId}. Last briefing summary: ${lastSummary}. Artifacts: ${input.artifactsDir}`
  );
}

async function readBobFinding(input: {
  bobEntry: CredentialEntry;
  findingId: string;
  runId: string;
  artifactsDir: string;
}): Promise<RuntimeFinding> {
  try {
    const response = await callLiveRuntimeTool<Record<string, unknown>>(
      input.bobEntry,
      'teamem.get_finding',
      { finding_id: input.findingId }
    );
    const data = response.data;
    return {
      finding_id: readStringField(data, 'finding_id', input),
      summary: readStringField(data, 'summary', input),
      severity: readStringField(data, 'severity', input),
      tags: readStringArrayField(data, 'tags', input)
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const error = new Error(
      `Bob get_finding failed for finding ${input.findingId} in run id ${input.runId}. Artifacts: ${input.artifactsDir}. ${message}`
    );
    if (err instanceof Error) {
      error.stack = err.stack;
    }
    throw error;
  }
}

function assertDecisionMcpEvidence(input: {
  traces: McpTrace[];
  artifactsDir: string;
  runId: string;
}): void {
  const decisionResponses = successfulToolResponseMessages(
    input.traces,
    'record_decision'
  );
  if (decisionResponses.length === 0) {
    throw new Error(
      `Expected Alice record_decision MCP response for run id ${input.runId}. ${summarizeTeamemResponseMetadata(input.traces)}. Artifacts: ${input.artifactsDir}`
    );
  }

  for (const response of decisionResponses) {
    const metadata = response.metadata?.response;
    const keys = new Set(metadata?.contentTextJsonDataKeys ?? []);
    const missing = [
      'event_id',
      'decision_id',
      'lifecycle_event',
      'version',
      'kind',
      'status'
    ].filter((key) => !keys.has(key));
    if (missing.length > 0) {
      throw new Error(
        `Expected Alice record_decision durable write response keys for run id ${input.runId}; missing ${missing.join(', ')}. Observed ${JSON.stringify(metadata)}. Artifacts: ${input.artifactsDir}`
      );
    }
  }

  const observedTools = observedToolNames(input.traces);
  const unexpectedTools = observedTools.filter(
    (toolName) => !['record_decision', 'get_briefing'].includes(toolName)
  );
  if (unexpectedTools.length > 0) {
    throw new Error(
      `Expected only Alice record_decision/get_briefing MCP tool calls for run id ${input.runId}, observed ${unexpectedTools.join(', ')}. Artifacts: ${input.artifactsDir}`
    );
  }
}

function requireRuntimeDecision(input: {
  briefing: RuntimeBriefing;
  title: string;
  summary: string;
  runId: string;
  artifactsDir: string;
}): void {
  if (
    !hasRuntimeDecision(input.briefing, {
      title: input.title,
      summary: input.summary
    })
  ) {
    throw new Error(
      `Bob briefing did not include decision "${input.title}" for run id ${input.runId}. Briefing summary: ${summarizeRuntimeBriefing(input.briefing)}. Artifacts: ${input.artifactsDir}`
    );
  }
}

function requireRuntimeFinding(input: {
  briefing: RuntimeBriefing;
  findingId: string;
  summary: string;
  tag: string;
  severity: string;
  runId: string;
  artifactsDir: string;
}): void {
  if (!hasRuntimeFinding(input.briefing, input)) {
    throw new Error(
      `Bob briefing did not include finding ${input.findingId} (${input.summary}) for run id ${input.runId}. Briefing summary: ${summarizeRuntimeBriefing(input.briefing)}. Artifacts: ${input.artifactsDir}`
    );
  }
}

function requireBobFindingDetails(input: {
  finding: RuntimeFinding;
  findingId: string;
  summary: string;
  tag: string;
  severity: string;
  runId: string;
  artifactsDir: string;
}): void {
  const mismatches: string[] = [];
  if (input.finding.finding_id !== input.findingId) {
    mismatches.push(`finding_id=${input.finding.finding_id}`);
  }
  if (input.finding.summary !== input.summary) {
    mismatches.push(`summary=${input.finding.summary}`);
  }
  if (input.finding.severity !== input.severity) {
    mismatches.push(`severity=${input.finding.severity}`);
  }
  if (!input.finding.tags.includes('teamem-smoke')) {
    mismatches.push('missing tag teamem-smoke');
  }
  if (!input.finding.tags.includes(input.tag)) {
    mismatches.push(`missing tag ${input.tag}`);
  }
  if (mismatches.length > 0) {
    throw new Error(
      `Bob get_finding did not expose gotcha ${input.findingId} with expected summary/tag/severity for run id ${input.runId}: ${mismatches.join(', ')}. Artifacts: ${input.artifactsDir}`
    );
  }
}

function hasRuntimeDecision(
  briefing: RuntimeBriefing,
  expected: { title: string; summary: string }
): boolean {
  return (briefing.recent_decisions ?? []).some(
    (decision) =>
      decision.title === expected.title && decision.summary === expected.summary
  );
}

function hasRuntimeFinding(
  briefing: RuntimeBriefing,
  expected: {
    findingId: string;
    summary: string;
    tag: string;
    severity: string;
  }
): boolean {
  return (briefing.recent_findings ?? []).some(
    (finding) => finding.summary === expected.summary
  );
}

function parseSharedGotchaFindingId(
  transcript: string,
  artifactsDir: string,
  runId: string
): string {
  const match = /Shared\s*gotcha\s*([A-Z0-9]+)/i.exec(
    normalizeTranscript(transcript)
  );
  if (!match) {
    throw new Error(
      `Expected Alice gotcha output to include "Shared gotcha <finding_id>" for run id ${runId}. Artifacts: ${artifactsDir}`
    );
  }

  return match[1].replace(/[.)\]]+$/u, '');
}

function hasSharedGotchaTranscriptEvidence(
  transcript: string,
  runTag: string
): boolean {
  const normalized = normalizeTranscript(transcript);
  const compact = normalized.replace(/\s+/g, '').toLowerCase();

  return (
    /Shared\s*gotcha\s*[A-Z0-9]+/i.test(normalized) &&
    compact.includes(`#${runTag}`.replace(/\s+/g, '').toLowerCase())
  );
}

async function writeKnowledgeArtifacts(input: {
  plan: MultiProfileRunPlan;
  alicePlan: MultiProfilePersonaPlan;
  bobPlan: MultiProfilePersonaPlan;
  aliceSession: InteractiveSession;
  bobSession: InteractiveSession;
  runId: string;
  decisionPrompt: string;
  gotchaPrompt: string;
  decisionTitle: string;
  decisionSummary: string;
  gotchaSummary: string;
  findingId: string;
  bobBriefing: RuntimeBriefing;
  bobFinding: RuntimeFinding;
  aliceWhoami: RuntimeWhoamiEvidence;
  bobWhoami: RuntimeWhoamiEvidence;
}): Promise<void> {
  await writeFile(
    join(
      input.alicePlan.runtimeEvidenceDir,
      `${input.alicePlan.persona}-knowledge-writes-${input.runId}.json`
    ),
    `${JSON.stringify(
      {
        runId: input.runId,
        persona: input.alicePlan.persona,
        profileName: input.alicePlan.profile.profileName,
        profileCredentialsPath: input.alicePlan.profile.credentialsPath,
        aliceWhoami: input.aliceWhoami,
        bobWhoami: input.bobWhoami,
        decision: {
          prompt: input.decisionPrompt,
          title: input.decisionTitle,
          summary: input.decisionSummary
        },
        gotcha: {
          prompt: input.gotchaPrompt,
          findingId: input.findingId,
          summary: input.gotchaSummary
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
      `${input.bobPlan.persona}-knowledge-visibility-${input.runId}.json`
    ),
    `${JSON.stringify(
      {
        runId: input.runId,
        persona: input.bobPlan.persona,
        profileName: input.bobPlan.profile.profileName,
        profileCredentialsPath: input.bobPlan.profile.credentialsPath,
        aliceWhoami: input.aliceWhoami,
        bobWhoami: input.bobWhoami,
        decision: {
          title: input.decisionTitle,
          summary: input.decisionSummary,
          visibleInBriefing: hasRuntimeDecision(input.bobBriefing, {
            title: input.decisionTitle,
            summary: input.decisionSummary
          })
        },
        gotcha: {
          findingId: input.findingId,
          summary: input.gotchaSummary,
          visibleInBriefing: hasRuntimeFinding(input.bobBriefing, {
            findingId: input.findingId,
            summary: input.gotchaSummary,
            tag: `run-${input.runId}`,
            severity: 'info'
          }),
          getFinding: input.bobFinding
        },
        bobBriefing: input.bobBriefing,
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
    join(input.plan.artifactsDir, `knowledge-run-${input.runId}.json`),
    `${JSON.stringify(
      {
        runId: input.runId,
        artifactsDir: input.plan.artifactsDir,
        decisionTitle: input.decisionTitle,
        gotchaFindingId: input.findingId,
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

function readStringField(
  data: Record<string, unknown>,
  key: string,
  input: { runId: string; artifactsDir: string }
): string {
  const value = data[key];
  if (typeof value !== 'string') {
    throw new Error(
      `Expected Bob get_finding field ${key} to be a string for run id ${input.runId}. Observed ${JSON.stringify(data)}. Artifacts: ${input.artifactsDir}`
    );
  }
  return value;
}

function readStringArrayField(
  data: Record<string, unknown>,
  key: string,
  input: { runId: string; artifactsDir: string }
): string[] {
  const value = data[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(
      `Expected Bob get_finding field ${key} to be a string array for run id ${input.runId}. Observed ${JSON.stringify(data)}. Artifacts: ${input.artifactsDir}`
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

function summarizeMcpTraces(traces: McpTrace[]): string {
  if (traces.length === 0) {
    return 'no MCP traces observed';
  }
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

function summarizeTeamemResponseMetadata(traces: McpTrace[]): string {
  const summaries = traces
    .filter((trace) => trace.serverName === 'teamem')
    .flatMap((trace) => trace.messages)
    .filter((message) => message.direction === 'server-to-client')
    .map((message) => {
      const tool = message.metadata?.toolName ?? 'unknown';
      const response = message.metadata?.response;
      return `${tool}:${JSON.stringify(response)}`;
    });
  return summaries.length > 0
    ? `Observed response metadata: ${summaries.join('; ')}`
    : 'No teamem response metadata observed';
}

function summarizeRuntimeBriefing(briefing: RuntimeBriefing): string {
  const decisions = (briefing.recent_decisions ?? [])
    .map((decision) => String(decision.title ?? decision.summary ?? ''))
    .filter(Boolean)
    .slice(0, 5);
  const findings = (briefing.recent_findings ?? [])
    .map((finding) => String(finding.summary ?? finding.finding_id ?? ''))
    .filter(Boolean)
    .slice(0, 5);
  return `decisions=[${decisions.join(' | ')}] findings=[${findings.join(' | ')}]`;
}

function formatGateReason(): string {
  return `set TEAMEM_CLAUDE_PLUGIN_E2E=1, TEAMEM_CLAUDE_PLUGIN_INTERACTIVE_E2E=1, TEAMEM_CLAUDE_PLUGIN_STATEFUL_E2E=1, ${TEAMEM_MULTI_PROFILE_E2E_ENV}=1, and CLAUDE_PLUGIN_E2E_ALLOW_UNREDACTED=1 to run L5 multi-profile durable knowledge Claude plugin smoke`;
}

function createKnowledgeRunId(): string {
  return `${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
