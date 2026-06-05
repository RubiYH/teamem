import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createClaudePluginTester,
  type PromptResult
} from '../../plugin-e2e-module/src/index.js';
import {
  assertLaunchDidNotForcePluginData,
  assertNoTeamemChannelMcpTrace,
  assertObservedPluginDataIsRedacted,
  assertTraceArtifactsExist,
  assertWhoamiMcpEvidence,
  createLiveRuntimeEnv,
  expectOnlyTeamemMcpIsProxied,
  initGitRepo,
  inspectRuntimePrerequisite,
  TEAMEM_MCP_INSTRUMENTATION_OPTIONS
} from './teamem-live-smoke-helpers.js';

const liveGateEnabled = process.env.TEAMEM_CLAUDE_PLUGIN_E2E === '1';
const runtimePrerequisite = await inspectRuntimePrerequisite({
  liveGateEnabled,
  gateReason: 'set TEAMEM_CLAUDE_PLUGIN_E2E=1 to run live Claude plugin tests'
});
const describeLiveRuntime =
  liveGateEnabled && runtimePrerequisite.ok ? describe : describe.skip;

const repoRoot = process.cwd();
const teamemPluginDir = join(repoRoot, 'plugin');
const LIVE_SMOKE_TEST_TIMEOUT_MS = 180_000;
const whoamiSlashCommand = '/teamem:teamem-whoami';
const pluginScopedToolPrefix = 'mcp__plugin_teamem_teamem__teamem_';

describeLiveRuntime(
  `Teamem runtime whoami live smoke${runtimePrerequisite.ok ? '' : ` (${runtimePrerequisite.reason})`}`,
  () => {
    it(
      'invokes /teamem:teamem-whoami through the core Teamem MCP proxy',
      async () => {
        const cwd = await mkdtemp(join(tmpdir(), 'teamem-whoami-cwd-'));
        const artifactsDir = await mkdtemp(
          join(tmpdir(), 'teamem-whoami-artifacts-')
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

          await expectOnlyTeamemMcpIsProxied(boot);

          const commandPrompt =
            await tester.slashCommandPrompt('teamem-whoami');
          expect(commandPrompt).toBe(whoamiSlashCommand);

          const result = await tester.prompt(commandPrompt, {
            allowedTools: [`${pluginScopedToolPrefix}whoami`],
            disallowedTools: [
              `${pluginScopedToolPrefix}get_current_sprint`,
              `${pluginScopedToolPrefix}list_claims`,
              `${pluginScopedToolPrefix}get_briefing`
            ],
            maxTurns: 5
          });

          expect(result.exitCode).toBe(0);
          expect(result.expectText(/^principal:\s+\S+/m)).toBe(result);
          expect(result.expectText(/^space_id:\s+\S+/m)).toBe(result);
          expect(result.expectText(/^label:\s+.*$/m)).toBe(result);
          expect(result.prompt).not.toContain('teamem-status');
          assertNoTeamemChannelMcpTrace(result);
          assertWhoamiMcpEvidence(result.mcpTraces);
          await assertLaunchDidNotForcePluginData(result);
          await assertProxyTraceEvidence(result);
          success = true;
        } finally {
          if (success) {
            await rm(artifactsDir, { recursive: true, force: true });
            await rm(cwd, { recursive: true, force: true });
          } else {
            console.error(
              `Preserving failed live smoke artifacts at ${artifactsDir} and cwd ${cwd}`
            );
          }
        }
      },
      LIVE_SMOKE_TEST_TIMEOUT_MS
    );
  }
);

async function assertProxyTraceEvidence(result: PromptResult): Promise<void> {
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
  }
}
