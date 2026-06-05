import { describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createClaudePluginTester,
  type McpTrace,
  type PromptResult
} from '../../plugin-e2e-module/src/index.js';
import {
  assertLaunchDidNotForcePluginData,
  assertNoTeamemChannelMcpTrace,
  assertObservedPluginDataIsRedacted,
  assertTraceArtifactsExist,
  callLiveRuntimeTool,
  createLiveRuntimeEnv,
  expectOnlyTeamemMcpIsProxied,
  initGitRepo,
  inspectRuntimePrerequisite,
  TEAMEM_MCP_INSTRUMENTATION_OPTIONS
} from './teamem-live-smoke-helpers.js';

type RuntimeBriefing = {
  recent_findings?: RuntimeFindingSummary[];
};

type RuntimeFindingSummary = {
  finding_id: unknown;
  summary: unknown;
  kind: unknown;
  lifecycle: unknown;
  status: unknown;
  version: unknown;
  expires_at: unknown;
  severity: unknown;
  tags: unknown;
};

type RuntimeFinding = {
  finding_id: unknown;
  summary: unknown;
  kind: unknown;
  lifecycle: unknown;
  status: unknown;
  version: unknown;
  expires_at: unknown;
  severity: unknown;
  tags: unknown;
};

const liveGateEnabled = process.env.TEAMEM_CLAUDE_PLUGIN_E2E === '1';
const statefulGateEnabled =
  process.env.TEAMEM_CLAUDE_PLUGIN_STATEFUL_E2E === '1';
const runtimePrerequisite = await inspectRuntimePrerequisite({
  liveGateEnabled: liveGateEnabled && statefulGateEnabled,
  gateReason: formatStatefulGateReason()
});
const describeLiveRuntime =
  liveGateEnabled && statefulGateEnabled && runtimePrerequisite.ok
    ? describe
    : describe.skip;

const repoRoot = process.cwd();
const teamemPluginDir = join(repoRoot, 'plugin');
const LIVE_SMOKE_TEST_TIMEOUT_MS = 240_000;
const gotchaSlashCommand = '/teamem:teamem-gotcha';
const pluginScopedToolPrefix = 'mcp__plugin_teamem_teamem__teamem_';
const ulidPattern = /^[0-9A-HJKMNP-TV-Z]{26}$/u;
const LIVE_RUNTIME_POLL_TIMEOUT_MS = 45_000;

describeLiveRuntime(
  `Teamem runtime gotcha live smoke${runtimePrerequisite.ok ? '' : ` (${runtimePrerequisite.reason})`}`,
  () => {
    it(
      'shares a gotcha through the slash command script and reads it back from runtime state',
      async () => {
        if (!runtimePrerequisite.ok) {
          throw new Error(runtimePrerequisite.reason);
        }

        const runId = createRunId();
        const runTag = `run-${runId}`;
        const gotchaSummary = `Teamem smoke gotcha ${runId}`;
        const gotchaArgs = `${gotchaSummary} #teamem-smoke #${runTag} --severity=info`;
        const cwd = await mkdtemp(join(tmpdir(), 'teamem-gotcha-cwd-'));
        const artifactsDir = await mkdtemp(
          join(tmpdir(), 'teamem-gotcha-artifacts-')
        );
        let success = false;

        try {
          initGitRepo(cwd);

          const tester = createClaudePluginTester({
            pluginDir: teamemPluginDir,
            cwd,
            artifactsDir,
            cleanup: 'never',
            mcp: TEAMEM_MCP_INSTRUMENTATION_OPTIONS,
            env: createLiveRuntimeEnv(),
            timeouts: {
              headlessRunMs: 120_000
            }
          });
          const boot = await tester.boot();

          expect(boot.plugin.pluginDir).toBe(teamemPluginDir);
          await expectOnlyTeamemMcpIsProxied(boot);

          const commandPrompt = await tester.slashCommandPrompt(
            'teamem-gotcha',
            gotchaArgs
          );
          expect(commandPrompt.startsWith(`${gotchaSlashCommand} `)).toBe(true);

          const gotchaResult = await tester.prompt(commandPrompt, {
            permissionMode: 'bypassPermissions',
            allowedTools: ['Bash(bash:*)'],
            disallowedTools: [
              'mcp__plugin_teamem_channel__*',
              'mcp__teamem-channel__*',
              `${pluginScopedToolPrefix}whoami`,
              `${pluginScopedToolPrefix}get_current_sprint`,
              `${pluginScopedToolPrefix}list_claims`,
              `${pluginScopedToolPrefix}get_briefing`,
              `${pluginScopedToolPrefix}claim_scope`,
              `${pluginScopedToolPrefix}release_scope`,
              `${pluginScopedToolPrefix}force_release`,
              `${pluginScopedToolPrefix}post_message`,
              `${pluginScopedToolPrefix}record_decision`,
              `${pluginScopedToolPrefix}share_finding`,
              `${pluginScopedToolPrefix}get_finding`,
              `${pluginScopedToolPrefix}acknowledge_finding`,
              `${pluginScopedToolPrefix}list_sprints`
            ],
            maxTurns: 6
          });

          withArtifactContext(gotchaResult, runId, () => {
            expect(gotchaResult.exitCode).toBe(0);
            assertNoTeamemChannelMcpTrace(gotchaResult);
          });
          assertGotchaWritePathEvidence({
            result: gotchaResult,
            runId
          });

          const sharedGotcha = await waitForRuntimeGotchaWrite({
            artifactsDir,
            runId,
            runTag,
            gotchaSummary
          });

          const lookupPrompt = [
            `Call the available Teamem get_finding MCP tool for finding_id ${sharedGotcha.findingId}.`,
            `Report the exact finding_id, summary, kind, severity, and tags for run id ${runId}.`
          ].join(' ');
          const lookupResult = await tester.prompt(lookupPrompt, {
            allowedTools: [
              `${pluginScopedToolPrefix}get_finding`,
              'mcp__teamem__teamem_get_finding'
            ],
            disallowedTools: [
              'mcp__plugin_teamem_channel__*',
              'mcp__teamem-channel__*',
              'mcp__teamem__teamem_whoami',
              'mcp__teamem__teamem_get_current_sprint',
              'mcp__teamem__teamem_list_claims',
              'mcp__teamem__teamem_get_briefing',
              'mcp__teamem__teamem_claim_scope',
              'mcp__teamem__teamem_release_scope',
              'mcp__teamem__teamem_force_release',
              'mcp__teamem__teamem_post_message',
              'mcp__teamem__teamem_record_decision',
              'mcp__teamem__teamem_share_finding',
              'mcp__teamem__teamem_acknowledge_finding',
              'mcp__teamem__teamem_list_sprints',
              `${pluginScopedToolPrefix}whoami`,
              `${pluginScopedToolPrefix}get_current_sprint`,
              `${pluginScopedToolPrefix}list_claims`,
              `${pluginScopedToolPrefix}get_briefing`,
              `${pluginScopedToolPrefix}claim_scope`,
              `${pluginScopedToolPrefix}release_scope`,
              `${pluginScopedToolPrefix}force_release`,
              `${pluginScopedToolPrefix}post_message`,
              `${pluginScopedToolPrefix}record_decision`,
              `${pluginScopedToolPrefix}share_finding`,
              `${pluginScopedToolPrefix}acknowledge_finding`,
              `${pluginScopedToolPrefix}list_sprints`
            ],
            maxTurns: 5
          });

          withArtifactContext(lookupResult, runId, () => {
            expect(lookupResult.exitCode).toBe(0);
            assertNoTeamemChannelMcpTrace(lookupResult);
            assertGetFindingMcpEvidence(
              lookupResult.mcpTraces,
              lookupResult.artifacts.dir,
              runId
            );
          });

          await assertLaunchDidNotForcePluginData(gotchaResult);
          await assertLaunchDidNotForcePluginData(lookupResult);
          await assertRuntimeGotchaVisibility({
            artifactsDir,
            runId,
            runTag,
            findingId: sharedGotcha.findingId,
            gotchaSummary
          });
          await assertProxyTraceEvidence(gotchaResult, runId);
          await assertProxyTraceEvidence(lookupResult, runId);
          success = true;
        } catch (err) {
          throw withArtifactError(err, artifactsDir, runId);
        } finally {
          if (success) {
            await rm(artifactsDir, { recursive: true, force: true });
            await rm(cwd, { recursive: true, force: true });
          } else {
            console.error(
              `Preserving failed live smoke artifacts at ${artifactsDir} and cwd ${cwd} for run id ${runId}`
            );
          }
        }
      },
      LIVE_SMOKE_TEST_TIMEOUT_MS
    );
  }
);

function formatStatefulGateReason(): string {
  const missingGates: string[] = [];
  if (!liveGateEnabled) {
    missingGates.push('TEAMEM_CLAUDE_PLUGIN_E2E=1');
  }
  if (!statefulGateEnabled) {
    missingGates.push('TEAMEM_CLAUDE_PLUGIN_STATEFUL_E2E=1');
  }

  return `set TEAMEM_CLAUDE_PLUGIN_E2E=1 and TEAMEM_CLAUDE_PLUGIN_STATEFUL_E2E=1 to run stateful live Claude plugin gotcha smoke${
    missingGates.length > 0 ? `; missing ${missingGates.join(' and ')}` : ''
  }`;
}

function createRunId(): string {
  return `${Date.now().toString(36)}${randomUUID().replaceAll('-', '').slice(0, 6)}`;
}

async function assertRuntimeGotchaVisibility(input: {
  artifactsDir: string;
  runId: string;
  runTag: string;
  findingId: string;
  gotchaSummary: string;
}): Promise<void> {
  if (!runtimePrerequisite.ok) {
    throw new Error(runtimePrerequisite.reason);
  }

  const detail = await callLiveRuntimeTool<RuntimeFinding>(
    runtimePrerequisite.selectedEntry,
    'teamem.get_finding',
    { finding_id: input.findingId }
  );
  assertRuntimeFindingValues({
    finding: detail.data,
    source: 'teamem.get_finding',
    ...input
  });

  const briefing = await callLiveRuntimeTool<RuntimeBriefing>(
    runtimePrerequisite.selectedEntry,
    'teamem.get_briefing',
    { token_budget: 2000 }
  );
  const recentFindings = Array.isArray(briefing.data.recent_findings)
    ? briefing.data.recent_findings
    : [];
  const matchingFinding = recentFindings.find(
    (finding) => finding.finding_id === input.findingId
  );

  if (!matchingFinding) {
    throw new Error(
      `Expected live runtime briefing recent_findings to include finding ${input.findingId} (${input.gotchaSummary}) for run id ${input.runId}. Observed ${summarizeRuntimeFindings(recentFindings)}. Artifacts: ${input.artifactsDir}`
    );
  }

  assertRuntimeFindingValues({
    finding: matchingFinding,
    source: 'teamem.get_briefing recent_findings',
    ...input
  });
}

async function waitForRuntimeGotchaWrite(input: {
  artifactsDir: string;
  runId: string;
  runTag: string;
  gotchaSummary: string;
}): Promise<{ findingId: string }> {
  if (!runtimePrerequisite.ok) {
    throw new Error(runtimePrerequisite.reason);
  }

  const deadline = Date.now() + LIVE_RUNTIME_POLL_TIMEOUT_MS;
  let lastSummary = 'no runtime findings observed';

  while (Date.now() < deadline) {
    const briefing = await callLiveRuntimeTool<RuntimeBriefing>(
      runtimePrerequisite.selectedEntry,
      'teamem.get_briefing',
      { token_budget: 2000 }
    );
    const recentFindings = Array.isArray(briefing.data.recent_findings)
      ? briefing.data.recent_findings
      : [];
    const matchingFinding = recentFindings.find(
      (finding) =>
        finding.summary === input.gotchaSummary &&
        finding.kind === 'gotcha' &&
        finding.lifecycle === 'persistent' &&
        finding.status === 'active' &&
        finding.severity === 'info' &&
        Array.isArray(finding.tags) &&
        finding.tags.includes('teamem-smoke') &&
        finding.tags.includes(input.runTag)
    );

    if (matchingFinding) {
      const findingId = matchingFinding.finding_id;
      if (typeof findingId !== 'string' || !ulidPattern.test(findingId)) {
        throw new Error(
          `Expected live runtime gotcha finding_id to be a valid ULID for run id ${input.runId}. Observed ${JSON.stringify(matchingFinding)}. Artifacts: ${input.artifactsDir}`
        );
      }
      return { findingId };
    }

    lastSummary = summarizeRuntimeFindings(recentFindings);
    await delay(500);
  }

  throw new Error(
    `Timed out waiting for live runtime gotcha write for run id ${input.runId}. Last findings summary: ${lastSummary}. Artifacts: ${input.artifactsDir}`
  );
}

function assertRuntimeFindingValues(input: {
  finding: RuntimeFinding | RuntimeFindingSummary;
  source: string;
  artifactsDir: string;
  runId: string;
  runTag: string;
  findingId: string;
  gotchaSummary: string;
}): void {
  const mismatches: string[] = [];
  if (input.finding.finding_id !== input.findingId) {
    mismatches.push(`finding_id=${String(input.finding.finding_id)}`);
  }
  if (input.finding.summary !== input.gotchaSummary) {
    mismatches.push(`summary=${String(input.finding.summary)}`);
  }
  if (input.finding.kind !== 'gotcha') {
    mismatches.push(`kind=${String(input.finding.kind)}`);
  }
  if (input.finding.lifecycle !== 'persistent') {
    mismatches.push(`lifecycle=${String(input.finding.lifecycle)}`);
  }
  if (input.finding.status !== 'active') {
    mismatches.push(`status=${String(input.finding.status)}`);
  }
  if (input.finding.expires_at !== null) {
    mismatches.push(`expires_at=${String(input.finding.expires_at)}`);
  }
  if (
    typeof input.finding.version !== 'number' ||
    !Number.isInteger(input.finding.version) ||
    input.finding.version <= 0
  ) {
    mismatches.push(`version=${String(input.finding.version)}`);
  }
  if (input.finding.severity !== 'info') {
    mismatches.push(`severity=${String(input.finding.severity)}`);
  }
  if (!Array.isArray(input.finding.tags)) {
    mismatches.push(`tags=${String(input.finding.tags)}`);
  } else {
    for (const expectedTag of ['teamem-smoke', input.runTag]) {
      if (!input.finding.tags.includes(expectedTag)) {
        mismatches.push(`missing tag ${expectedTag}`);
      }
    }
  }

  if (mismatches.length > 0) {
    throw new Error(
      `Expected ${input.source} to expose gotcha ${input.findingId} with summary/tag/severity/runtime identity for run id ${input.runId}: ${mismatches.join(', ')}. Observed ${JSON.stringify(input.finding)}. Artifacts: ${input.artifactsDir}`
    );
  }
}

function summarizeRuntimeFindings(findings: RuntimeFindingSummary[]): string {
  const summary = findings
    .map((finding) =>
      [
        finding.finding_id,
        finding.summary,
        finding.kind,
        finding.lifecycle,
        finding.status,
        typeof finding.version === 'number' ? `v${finding.version}` : undefined,
        finding.expires_at === null ? 'expires:null' : undefined,
        finding.severity,
        Array.isArray(finding.tags) ? finding.tags.join('|') : undefined
      ]
        .filter((value) => typeof value === 'string' && value.length > 0)
        .join(':')
    )
    .filter(Boolean)
    .slice(0, 5)
    .join(', ');

  return summary || 'none';
}

function assertGetFindingMcpEvidence(
  traces: McpTrace[],
  artifactsDir: string,
  runId: string
): void {
  const observedTools = collectTeamemToolCalls(traces, artifactsDir, runId);

  if (!observedTools.includes('get_finding')) {
    throw new Error(
      `Expected get_finding MCP call for run id ${runId}. Observed ${observedTools.join(', ') || 'none'}. Artifacts: ${artifactsDir}`
    );
  }

  const unexpectedTools = observedTools.filter(
    (toolName) => toolName !== 'get_finding'
  );
  if (unexpectedTools.length > 0) {
    throw new Error(
      `Expected only get_finding MCP calls for run id ${runId}, observed unexpected ${unexpectedTools.join(', ')}. Artifacts: ${artifactsDir}`
    );
  }
}

function collectTeamemToolCalls(
  traces: McpTrace[],
  artifactsDir: string,
  runId: string
): string[] {
  const teamemTrace = traces.find((trace) => trace.serverName === 'teamem');
  if (!teamemTrace) {
    throw new Error(
      `Expected core teamem MCP trace for run id ${runId}. Artifacts: ${artifactsDir}`
    );
  }

  const toolCalls = teamemTrace.messages.filter(
    (message) =>
      message.direction === 'client-to-server' &&
      message.method === 'tools/call'
  );

  const observedTools: string[] = [];
  for (const [index, message] of toolCalls.entries()) {
    const toolName = message.metadata?.toolName;
    if (!toolName) {
      throw new Error(
        `Expected safe MCP tools/call name metadata at index ${index} for run id ${runId}. Artifacts: ${artifactsDir}`
      );
    }
    observedTools.push(normalizeToolName(toolName));
  }

  return observedTools;
}

function normalizeToolName(toolName: string): string {
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

function assertGotchaWritePathEvidence(input: {
  result: PromptResult;
  runId: string;
}): void {
  const bashCommands = collectBashToolCommands(input.result.events);
  const invokedBundledScript = bashCommands.some(
    (command) =>
      command.includes('bash') &&
      (command.includes('${CLAUDE_PLUGIN_ROOT}/scripts/teamem-gotcha.sh') ||
        command.includes('/scripts/teamem-gotcha.sh'))
  );
  if (!invokedBundledScript) {
    throw withArtifactError(
      new Error(
        `Expected write run to invoke bundled teamem-gotcha.sh through Bash. Observed Bash commands: ${bashCommands.join(' | ') || 'none'}`
      ),
      input.result.artifacts.dir,
      input.runId
    );
  }
}

function collectBashToolCommands(events: unknown[]): string[] {
  const commands = new Set<string>();
  const seen = new Set<unknown>();

  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object' || seen.has(value)) {
      return;
    }
    seen.add(value);

    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item);
      }
      return;
    }

    const record = value as Record<string, unknown>;
    if (
      record.name === 'Bash' &&
      record.input &&
      typeof record.input === 'object'
    ) {
      const command = (record.input as Record<string, unknown>).command;
      if (typeof command === 'string') {
        commands.add(command);
      }
    }

    for (const nested of Object.values(record)) {
      visit(nested);
    }
  };

  for (const event of events) {
    visit(event);
  }

  return [...commands];
}

async function assertProxyTraceEvidence(
  result: PromptResult,
  runId: string
): Promise<void> {
  const sessionStart = result.expectHook('SessionStart');
  expect(sessionStart.exitCode).toBe(0);
  await assertTraceArtifactsExist(sessionStart);
  assertObservedPluginDataIsRedacted(sessionStart);

  const teamemTrace = result.mcpTraces.find(
    (trace) => trace.serverName === 'teamem'
  );
  expect(teamemTrace).toBeDefined();
  if (teamemTrace) {
    await assertTraceArtifactsExist(teamemTrace);
    assertObservedPluginDataIsRedacted(teamemTrace);
  } else {
    throw withArtifactError(
      new Error('Expected core teamem MCP trace'),
      result.artifacts.dir,
      runId
    );
  }
}

function withArtifactContext<T>(
  result: PromptResult,
  runId: string,
  assertion: () => T
): T {
  try {
    return assertion();
  } catch (err) {
    throw withArtifactError(err, result.artifacts.dir, runId);
  }
}

function withArtifactError(
  err: unknown,
  artifactsDir: string,
  runId: string
): Error {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes('Artifacts:') && message.includes('run id')) {
    return err instanceof Error ? err : new Error(message);
  }
  const error = new Error(
    `${message}\nArtifacts: ${artifactsDir}\nStateful gotcha smoke run id: ${runId}`
  );
  if (err instanceof Error) {
    error.stack = err.stack;
  }
  return error;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
