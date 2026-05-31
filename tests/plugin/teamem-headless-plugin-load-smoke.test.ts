import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createClaudePluginTester,
  type BootResult,
  type HookTrace,
  type PromptResult
} from '../../plugin-e2e-module/src/index.js';

const describeLive =
  process.env.TEAMEM_CLAUDE_PLUGIN_E2E === '1' ? describe : describe.skip;

const repoRoot = process.cwd();
const teamemPluginDir = join(repoRoot, 'plugin');
const fixedReply = 'TEAMEM_PLUGIN_LOAD_SMOKE_OK';

describeLive('Teamem headless plugin-load live smoke', () => {
  it('loads the real local Teamem plugin without forcing plugin data or runtime credentials', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'teamem-plugin-load-cwd-'));
    const artifactsDir = await mkdtemp(
      join(tmpdir(), 'teamem-plugin-load-artifacts-')
    );
    let success = false;

    try {
      initGitRepo(cwd);

      const tester = createClaudePluginTester({
        pluginDir: teamemPluginDir,
        cwd,
        artifactsDir,
        cleanup: 'never',
        mcp: { include: ['teamem'], mode: 'disable-non-included' },
        env: createSanitizedLiveEnv(cwd),
        timeouts: {
          headlessRunMs: 120_000
        }
      });
      const boot = await tester.boot();

      await expectOnlyTeamemMcpIsProxied(boot);

      const result = await tester.prompt(
        [
          `Reply exactly with ${fixedReply}.`,
          'Do not use tools, MCP tools, shell commands, slash commands, or Teamem runtime features.'
        ].join(' '),
        {
          disallowedTools: ['mcp__teamem__*'],
          maxTurns: 1
        }
      );

      expect(result.exitCode).toBe(0);
      expect(result.expectText(fixedReply)).toBe(result);
      assertNoTeamemChannelMcpTrace(result);
      await assertLaunchDidNotForcePluginData(result);
      await assertSessionStartTraceEvidence(result);
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
  });
});

function initGitRepo(cwd: string): void {
  const init = spawnSync('git', ['init'], {
    cwd,
    encoding: 'utf8'
  });
  expect(init.status).toBe(0);
}

function createSanitizedLiveEnv(cwd: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };

  for (const key of Object.keys(env)) {
    if (key.startsWith('TEAMEM_')) {
      delete env[key];
    }
  }

  delete env.CLAUDE_PLUGIN_DATA;
  delete env.CLAUDE_PLUGIN_OPTION_DEFAULT_SPACE;

  env.TEAMEM_CREDENTIALS = join(cwd, '.teamem', 'missing-credentials.json');
  env.TEAMEM_PROJECT_ID = `plugin-load-smoke-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}`;

  return env;
}

async function expectOnlyTeamemMcpIsProxied(boot: BootResult): Promise<void> {
  const mcpPath = boot.instrumentedPlugin.mcpPath;
  expect(mcpPath).toBeDefined();

  const config = JSON.parse(await readFile(mcpPath ?? '', 'utf8')) as {
    mcpServers: Record<string, { command: string; args?: string[] }>;
  };
  const proxiedServerNames = Object.entries(config.mcpServers)
    .filter(([, server]) => server.args?.[0]?.includes('mcp-proxy-runner.cjs'))
    .map(([serverName]) => serverName)
    .sort();

  expect(Object.keys(config.mcpServers).sort()).toEqual(['teamem']);
  expect(proxiedServerNames).toEqual(['teamem']);
  expect(config.mcpServers.teamem?.command).toBe(process.execPath);
  expect(config.mcpServers).not.toHaveProperty('teamem-channel');
}

async function assertLaunchDidNotForcePluginData(
  result: PromptResult
): Promise<void> {
  const environment = JSON.parse(
    await readFile(result.artifacts.environmentPath, 'utf8')
  ) as { env?: Record<string, string> };

  expect(environment.env ?? {}).not.toHaveProperty('CLAUDE_PLUGIN_DATA');
}

async function assertSessionStartTraceEvidence(
  result: PromptResult
): Promise<void> {
  const trace = result.expectHook('SessionStart');

  expect(trace.exitCode).toBe(0);
  expect(trace.artifacts.tracePath).toContain(result.artifacts.hookTraceDir);
  await expect(stat(trace.artifacts.tracePath)).resolves.toBeTruthy();
  await expect(stat(trace.artifacts.stdinPath)).resolves.toBeTruthy();
  await expect(stat(trace.artifacts.stdoutPath)).resolves.toBeTruthy();
  await expect(stat(trace.artifacts.stderrPath)).resolves.toBeTruthy();
  assertObservedPluginDataIsRedacted(trace);
}

function assertObservedPluginDataIsRedacted(trace: HookTrace): void {
  const observedPluginData = trace.environment?.env.CLAUDE_PLUGIN_DATA;
  if (observedPluginData !== undefined) {
    expect(observedPluginData).toBe('[REDACTED]');
  }
}

function assertNoTeamemChannelMcpTrace(result: PromptResult): void {
  expect(
    result.mcpTraces.some((trace) => trace.serverName === 'teamem-channel')
  ).toBe(false);
}
