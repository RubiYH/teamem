import { describe, expect, it } from 'bun:test';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';

import {
  createClaudePluginTester,
  normalizeTranscript,
  readHookTraces,
  readMcpTraces,
  type BootResult,
  type HookTrace,
  type InteractiveSession,
  type McpTrace
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

type SpaceRulesSnapshot = {
  has_server_rules: boolean;
  rendered_rules_body: string;
  metadata: {
    format_version: number;
    source: string;
    managed_begin: string;
    managed_end: string;
    rules_version: number;
    rules_hash: string;
    generated_at: string;
    space_id?: string | null;
    space_label?: string | null;
    source_event_id?: string | null;
    snapshot_updated_at?: string | null;
    snapshot_updated_by?: string | null;
  };
};

type SnapshotCache = {
  saved_at?: string;
  snapshot?: SpaceRulesSnapshot;
};

type OptionalFileState =
  | { exists: true; content: string }
  | { exists: false; content?: undefined };

type MultiProfilePersonaPlan = MultiProfileRunPlan['personaPlans'][number];

const liveGateEnabled = process.env.TEAMEM_CLAUDE_PLUGIN_E2E === '1';
const interactiveGateEnabled =
  process.env.TEAMEM_CLAUDE_PLUGIN_INTERACTIVE_E2E === '1';
const multiProfileGateEnabled =
  process.env[TEAMEM_MULTI_PROFILE_E2E_ENV] === '1';
const liveMultiProfileGateEnabled =
  liveGateEnabled && interactiveGateEnabled && multiProfileGateEnabled;
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
const LIVE_MULTI_PROFILE_SPACE_RULES_TIMEOUT_MS = 360_000;
const INTERACTIVE_READINESS_TIMEOUT_MS = 30_000;
const INTERACTIVE_WAIT_TIMEOUT_MS = 60_000;
const INTERACTIVE_CLOSE_TIMEOUT_MS = 10_000;
const INTERACTIVE_STARTUP_SETTLE_MS = 2_000;
const INTERACTIVE_TYPE_DELAY_MS = 20;
const FILE_POLL_TIMEOUT_MS = 45_000;
const ruleInitSlashCommand = '/teamem:rule init';
const pluginScopedToolPrefix = 'mcp__plugin_teamem_teamem__teamem_';
const canonicalTeamemToolPrefix = 'mcp__teamem__teamem_';

describeLiveMultiProfile(
  `Teamem L5 multi-profile Space Rules stream smoke${liveMultiProfileGateEnabled ? '' : ` (${formatGateReason()})`}`,
  () => {
    it(
      'lets Alice initialize copied workspace Space Rules cache and Bob refresh the same user-facing state',
      async () => {
        const sourceTeamemBefore = await readOptionalFile(
          join(repoRoot, 'TEAMEM.md')
        );
        const sourceRulesCacheBefore = await readOptionalFile(
          join(repoRoot, '.teamem', 'space-rules-snapshot.json')
        );
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
          expect(workspace.demoWorkspaceLaunchCwd).not.toBe(repoRoot);
          expect(workspace.demoWorkspaceLaunchCwd).not.toBe(teamemPluginDir);

          const [alicePlan, bobPlan] = plan.personaPlans;
          if (!alicePlan || !bobPlan) {
            throw new Error('Expected Alice and Bob multi-profile plans');
          }

          const aliceRuntime = await inspectProfileRuntime(
            alicePlan.profile.credentialsPath
          );
          const bobRuntime = await inspectProfileRuntime(
            bobPlan.profile.credentialsPath
          );
          assertSameSpaceProfiles({ aliceRuntime, bobRuntime });

          const workspaceTeamemBeforeCommand =
            await resetWorkspaceSpaceRulesOutputs(
              workspace.demoWorkspaceLaunchCwd
            );
          await assertSourceCheckoutUnchanged({
            sourceTeamemBefore,
            sourceRulesCacheBefore
          });

          const aliceResult = await runPersonaRuleInit({
            personaPlan: alicePlan,
            workspaceRoot: workspace.demoWorkspaceLaunchCwd,
            expectedSnapshot: aliceRuntime.snapshot,
            sourceTeamemBefore,
            sourceRulesCacheBefore,
            expectedTeamemBeforeCommand: workspaceTeamemBeforeCommand,
            sessions
          });
          await assertSourceCheckoutUnchanged({
            sourceTeamemBefore,
            sourceRulesCacheBefore
          });

          const bobResult = await runPersonaRuleInit({
            personaPlan: bobPlan,
            workspaceRoot: workspace.demoWorkspaceLaunchCwd,
            expectedSnapshot: bobRuntime.snapshot,
            sourceTeamemBefore,
            sourceRulesCacheBefore,
            expectedTeamemBeforeCommand: {
              exists: true,
              content: aliceResult.teamem
            },
            sessions
          });
          await assertSourceCheckoutUnchanged({
            sourceTeamemBefore,
            sourceRulesCacheBefore
          });

          expect(normalizeGeneratedAt(bobResult.cache.snapshot)).toEqual(
            normalizeGeneratedAt(aliceResult.cache.snapshot)
          );
          assertEquivalentWorkspaceRulesState({
            first: aliceResult,
            second: bobResult
          });
          await assertSourceCheckoutUnchanged({
            sourceTeamemBefore,
            sourceRulesCacheBefore
          });

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
                `Preserving failed multi-profile Space Rules smoke artifacts at ${cleanup.artifactsDir}`
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
                `Preserving failed multi-profile Space Rules demo workspace at ${cleanup.demoWorkspaceLaunchCwd}${cleanup.artifactPath ? ` (report ${cleanup.artifactPath})` : ''}`
              );
            }
          }
        }
      },
      LIVE_MULTI_PROFILE_SPACE_RULES_TIMEOUT_MS
    );
  }
);

async function runPersonaRuleInit(input: {
  personaPlan: MultiProfilePersonaPlan;
  workspaceRoot: string;
  expectedSnapshot: SpaceRulesSnapshot;
  sourceTeamemBefore: OptionalFileState;
  sourceRulesCacheBefore: OptionalFileState;
  expectedTeamemBeforeCommand: OptionalFileState;
  sessions: InteractiveSession[];
}): Promise<{
  teamemPath: string;
  cachePath: string;
  teamem: string;
  cache: SnapshotCache;
}> {
  const profileEnv = createProfileRuntimeEnv(
    input.personaPlan.profile,
    teamemPluginDir
  );
  const tester = createClaudePluginTester({
    pluginDir: teamemPluginDir,
    cwd: input.workspaceRoot,
    artifactsDir: input.personaPlan.artifactDir,
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
  assertDevLaunchPlanParity({
    personaPlan: input.personaPlan,
    profileEnv,
    boot,
    launchCwd: input.workspaceRoot
  });

  const ruleInitPrompt = await tester.slashCommandPrompt('rule', 'init');
  expect(ruleInitPrompt).toBe(ruleInitSlashCommand);

  const session = await tester.launchInteractive({
    useInstrumentedMcpConfig: true,
    strictMcpConfig: true,
    permissionMode: interactivePermissionMode,
    allowedTools: ['Bash(bash:*)'],
    disallowedTools: [
      'mcp__plugin_teamem_channel__*',
      'mcp__teamem-channel__*',
      `${canonicalTeamemToolPrefix}whoami`,
      `${canonicalTeamemToolPrefix}get_current_sprint`,
      `${canonicalTeamemToolPrefix}list_claims`,
      `${canonicalTeamemToolPrefix}claim_scope`,
      `${canonicalTeamemToolPrefix}release_scope`,
      `${canonicalTeamemToolPrefix}force_release`,
      `${canonicalTeamemToolPrefix}post_message`,
      `${canonicalTeamemToolPrefix}record_decision`,
      `${canonicalTeamemToolPrefix}share_finding`,
      `${canonicalTeamemToolPrefix}get_finding`,
      `${canonicalTeamemToolPrefix}acknowledge_finding`,
      `${canonicalTeamemToolPrefix}get_briefing`,
      `${canonicalTeamemToolPrefix}export_space_rules_snapshot`,
      `${canonicalTeamemToolPrefix}publish_space_rules_snapshot`,
      `${canonicalTeamemToolPrefix}list_sprints`,
      `${pluginScopedToolPrefix}whoami`,
      `${pluginScopedToolPrefix}get_current_sprint`,
      `${pluginScopedToolPrefix}list_claims`,
      `${pluginScopedToolPrefix}claim_scope`,
      `${pluginScopedToolPrefix}release_scope`,
      `${pluginScopedToolPrefix}force_release`,
      `${pluginScopedToolPrefix}post_message`,
      `${pluginScopedToolPrefix}record_decision`,
      `${pluginScopedToolPrefix}share_finding`,
      `${pluginScopedToolPrefix}get_finding`,
      `${pluginScopedToolPrefix}acknowledge_finding`,
      `${pluginScopedToolPrefix}get_briefing`,
      `${pluginScopedToolPrefix}export_space_rules_snapshot`,
      `${pluginScopedToolPrefix}publish_space_rules_snapshot`,
      `${pluginScopedToolPrefix}list_sprints`
    ],
    readiness: isClaudeInteractiveReadyOrSafetyPrompt,
    readinessTimeoutMs: INTERACTIVE_READINESS_TIMEOUT_MS,
    waitTimeoutMs: INTERACTIVE_WAIT_TIMEOUT_MS,
    closeTimeoutMs: INTERACTIVE_CLOSE_TIMEOUT_MS
  });
  input.sessions.push(session);
  await acceptClaudeStartupPromptsIfPresent(
    session,
    INTERACTIVE_READINESS_TIMEOUT_MS
  );
  assertInteractiveLaunchParity({
    personaPlan: input.personaPlan,
    boot,
    session,
    launchCwd: input.workspaceRoot
  });

  await delay(INTERACTIVE_STARTUP_SETTLE_MS);
  await assertSourceCheckoutUnchanged({
    sourceTeamemBefore: input.sourceTeamemBefore,
    sourceRulesCacheBefore: input.sourceRulesCacheBefore
  });
  await session.submit(ruleInitPrompt, {
    delayMs: INTERACTIVE_TYPE_DELAY_MS
  });
  await assertRuleInitCommandEvidence(session);

  const workspaceEvidence = await waitForWorkspaceSpaceRulesEvidence({
    workspaceRoot: input.workspaceRoot,
    expectedSnapshot: input.expectedSnapshot,
    teamemBeforeCommand: input.expectedTeamemBeforeCommand
  });
  assertWorkspaceOnlyPaths(input.workspaceRoot, [
    workspaceEvidence.teamemPath,
    workspaceEvidence.cachePath
  ]);
  assertLiveInteractiveInputEvidence(session, ruleInitPrompt);
  await session.close();

  const [hookTraces, mcpTraces] = await Promise.all([
    readHookTraces(session.artifacts.hookTraceDir),
    readMcpTraces(session.artifacts.mcpTraceDir)
  ]);
  assertSessionStartEvidence(hookTraces);
  assertNoChannelTraces(mcpTraces);
  assertNoTeamemMcpToolCallTrace(mcpTraces, session.artifacts.dir);
  await assertPersonaArtifacts(session, profileEnv);
  await writePersonaRuleEvidence({
    personaPlan: input.personaPlan,
    session,
    workspaceEvidence
  });

  return workspaceEvidence;
}

async function inspectProfileRuntime(credentialsPath: string): Promise<{
  entry: CredentialEntry;
  whoami: RuntimeWhoamiEvidence;
  snapshot: SpaceRulesSnapshot;
}> {
  const credentials = await loadCredentials(credentialsPath);
  if (!credentials) {
    throw new Error(
      `Invalid profile credentials at ${credentialsPath}; refusing to open Claude.`
    );
  }
  const entry = pickEntry({ creds: credentials });
  checkJwtExp(entry);
  const [whoami, snapshot] = await Promise.all([
    callLiveRuntimeTool<RuntimeWhoamiEvidence>(entry, 'teamem.whoami'),
    callLiveRuntimeTool<SpaceRulesSnapshot>(
      entry,
      'teamem.export_space_rules_snapshot'
    )
  ]);
  expect(whoami.data.principal).toBe(entry.member_name);
  expect(whoami.data.space_id).toBe(entry.space_id);
  expect(whoami.data.label).toBe(entry.label);
  expect(snapshot.data.metadata.space_id ?? whoami.data.space_id).toBe(
    whoami.data.space_id
  );
  return { entry, whoami: whoami.data, snapshot: snapshot.data };
}

function assertSameSpaceProfiles(input: {
  aliceRuntime: { whoami: RuntimeWhoamiEvidence; snapshot: SpaceRulesSnapshot };
  bobRuntime: { whoami: RuntimeWhoamiEvidence; snapshot: SpaceRulesSnapshot };
}): void {
  expect(input.aliceRuntime.whoami.space_id).toBe(
    input.bobRuntime.whoami.space_id
  );
  expect(input.aliceRuntime.whoami.principal).not.toBe(
    input.bobRuntime.whoami.principal
  );
  expect(normalizeGeneratedAt(input.aliceRuntime.snapshot)).toEqual(
    normalizeGeneratedAt(input.bobRuntime.snapshot)
  );
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
  const permissionFlagIndex =
    input.session.command.args.indexOf('--permission-mode');
  expect(permissionFlagIndex).toBeGreaterThanOrEqual(0);
  expect(input.session.command.args[permissionFlagIndex + 1]).toBe(
    interactivePermissionMode
  );
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

async function resetWorkspaceSpaceRulesOutputs(
  workspaceRoot: string
): Promise<OptionalFileState> {
  const teamemPath = join(workspaceRoot, 'TEAMEM.md');
  const cachePath = join(workspaceRoot, '.teamem', 'space-rules-snapshot.json');
  const teamemStateBeforeReset = await readOptionalFile(teamemPath);

  await Promise.all([
    rm(teamemPath, { force: true }),
    rm(join(workspaceRoot, '.teamem'), { recursive: true, force: true })
  ]);

  await expect(readOptionalFile(teamemPath)).resolves.toEqual({
    exists: false
  });
  await expect(readOptionalFile(cachePath)).resolves.toEqual({
    exists: false
  });
  expect(teamemStateBeforeReset.exists).toBe(true);

  return { exists: false };
}

async function assertRuleInitCommandEvidence(
  session: InteractiveSession
): Promise<void> {
  await session.waitFor(hasRuleInitTranscriptEvidence, {
    timeoutMs: INTERACTIVE_WAIT_TIMEOUT_MS
  });
  expect(hasRuleInitTranscriptEvidence(session.normalizedTranscript())).toBe(
    true
  );
}

function hasRuleInitTranscriptEvidence(transcript: string): boolean {
  const normalized = normalizeTranscript(transcript);
  const compact = normalized.replace(/\s+/g, '').toLowerCase();

  return (
    normalized.includes('teamem-rule-init.sh') ||
    normalized.includes('Initialized TEAMEM.md') ||
    normalized.includes('Teamem-managed Space Rules block') ||
    normalized.includes('No server-authored Space Rules snapshot exists') ||
    normalized.includes('snapshot metadata was cached') ||
    compact.includes('initializedteamem.md') ||
    compact.includes('teamem-managedspacerulesblock') ||
    compact.includes('noserver-authoredspacerulessnapshotexists') ||
    compact.includes('snapshotmetadatawascached')
  );
}

async function waitForWorkspaceSpaceRulesEvidence(input: {
  workspaceRoot: string;
  expectedSnapshot: SpaceRulesSnapshot;
  teamemBeforeCommand: OptionalFileState;
}): Promise<{
  teamemPath: string;
  cachePath: string;
  teamem: string;
  cache: SnapshotCache;
}> {
  const teamemPath = join(input.workspaceRoot, 'TEAMEM.md');
  const cachePath = join(
    input.workspaceRoot,
    '.teamem',
    'space-rules-snapshot.json'
  );
  const deadline = Date.now() + FILE_POLL_TIMEOUT_MS;
  let lastSummary = 'TEAMEM.md/cache not observed yet';

  while (Date.now() < deadline) {
    const [teamemState, cacheState] = await Promise.all([
      readOptionalFile(teamemPath),
      readOptionalFile(cachePath)
    ]);

    if (teamemState.exists && cacheState.exists) {
      try {
        const cache = JSON.parse(cacheState.content) as SnapshotCache;
        assertSpaceRulesFilesystemEvidence({
          teamem: teamemState.content,
          cache,
          expectedSnapshot: input.expectedSnapshot,
          teamemBeforeCommand: input.teamemBeforeCommand
        });

        return {
          teamemPath,
          cachePath,
          teamem: teamemState.content,
          cache
        };
      } catch (err) {
        lastSummary = formatError(err);
      }
    } else {
      lastSummary = `TEAMEM.md exists=${teamemState.exists}; cache exists=${cacheState.exists}`;
    }

    await delay(250);
  }

  throw new Error(
    `Timed out waiting for Space Rules filesystem evidence after ${FILE_POLL_TIMEOUT_MS}ms. Last state: ${lastSummary}. Workspace: ${input.workspaceRoot}`
  );
}

function assertSpaceRulesFilesystemEvidence(input: {
  teamem: string;
  cache: SnapshotCache;
  expectedSnapshot: SpaceRulesSnapshot;
  teamemBeforeCommand: OptionalFileState;
}): void {
  if (input.teamemBeforeCommand.exists) {
    expect(input.teamemBeforeCommand.content).toContain('# TEAMEM.md');
  } else {
    expect(input.teamemBeforeCommand).toEqual({ exists: false });
  }
  expect(normalizeGeneratedAt(input.cache.snapshot)).toEqual(
    normalizeGeneratedAt(input.expectedSnapshot)
  );
  expect(input.cache.saved_at).toEqual(expect.any(String));
  expect(input.cache.snapshot?.metadata.generated_at).toEqual(
    expect.any(String)
  );
  expect(input.teamem.length).toBeGreaterThan(0);

  if (!input.expectedSnapshot.has_server_rules) {
    expect(input.cache.snapshot?.has_server_rules).toBe(false);
    expect(input.cache.snapshot?.metadata).toEqual(
      expect.objectContaining({
        ...input.expectedSnapshot.metadata,
        generated_at: expect.any(String)
      })
    );
    expect(input.teamem).toContain('# TEAMEM.md');
    expect(input.teamem).toContain('## Local Notes');
    expect(input.teamem).toContain('## Teamem Space Rules');
    expect(input.teamem).toContain('Run `/teamem:rule init`');
    expect(input.teamem).not.toContain(
      input.expectedSnapshot.metadata.managed_begin
    );
    expect(input.teamem).not.toContain(
      input.expectedSnapshot.metadata.managed_end
    );
    return;
  }

  const metadata = input.expectedSnapshot.metadata;
  expect(metadata.rules_hash).toBeTruthy();
  expect(metadata.rules_version).toBeGreaterThan(0);
  expect(metadata.space_id || metadata.space_label).toBeTruthy();
  expect(input.teamem).toContain(metadata.managed_begin);
  expect(input.teamem).toContain(metadata.managed_end);
  expect(countOccurrences(input.teamem, metadata.managed_begin)).toBe(1);
  expect(countOccurrences(input.teamem, metadata.managed_end)).toBe(1);
  expect(input.teamem).toContain(input.expectedSnapshot.rendered_rules_body);

  const parsedMetadata = parseManagedBlockMetadata(input.teamem, metadata);
  expect(parsedMetadata).toEqual(
    expect.objectContaining({
      ...metadata,
      generated_at: expect.any(String)
    })
  );
  expect(parsedMetadata.rules_hash).toBe(metadata.rules_hash);
  expect(parsedMetadata.rules_version).toBe(metadata.rules_version);
  if (metadata.space_id) {
    expect(parsedMetadata.space_id).toBe(metadata.space_id);
  } else {
    expect(parsedMetadata.space_label).toBe(metadata.space_label);
  }

  const body = managedBlockBody(input.teamem, metadata);
  expect(body).toBe(input.expectedSnapshot.rendered_rules_body);
}

function assertEquivalentWorkspaceRulesState(input: {
  first: { teamem: string; cache: SnapshotCache };
  second: { teamem: string; cache: SnapshotCache };
}): void {
  const firstSnapshot = input.first.cache.snapshot;
  const secondSnapshot = input.second.cache.snapshot;
  expect(normalizeGeneratedAt(secondSnapshot)).toEqual(
    normalizeGeneratedAt(firstSnapshot)
  );

  if (!firstSnapshot?.has_server_rules || !secondSnapshot?.has_server_rules) {
    expect(input.second.teamem).toBe(input.first.teamem);
    return;
  }

  expect(managedBlockBody(input.second.teamem, secondSnapshot.metadata)).toBe(
    managedBlockBody(input.first.teamem, firstSnapshot.metadata)
  );
  const firstMetadata = parseManagedBlockMetadata(
    input.first.teamem,
    firstSnapshot.metadata
  );
  const secondMetadata = parseManagedBlockMetadata(
    input.second.teamem,
    secondSnapshot.metadata
  );
  const { generated_at: firstGeneratedAt, ...stableFirstMetadata } =
    firstMetadata;
  const { generated_at: secondGeneratedAt, ...stableSecondMetadata } =
    secondMetadata;
  expect(firstGeneratedAt).toEqual(expect.any(String));
  expect(secondGeneratedAt).toEqual(expect.any(String));
  expect(stableSecondMetadata).toEqual(stableFirstMetadata);
}

function normalizeGeneratedAt(snapshot: SpaceRulesSnapshot | undefined): Omit<
  SpaceRulesSnapshot,
  'metadata'
> & {
  metadata: Omit<SpaceRulesSnapshot['metadata'], 'generated_at'>;
} {
  expect(snapshot).toBeDefined();
  if (!snapshot) {
    throw new Error('Expected Space Rules snapshot to be defined');
  }
  const { generated_at, ...metadata } = snapshot.metadata;
  expect(generated_at).toEqual(expect.any(String));
  return {
    ...snapshot,
    metadata
  };
}

function parseManagedBlockMetadata(
  teamem: string,
  metadata: SpaceRulesSnapshot['metadata']
): SpaceRulesSnapshot['metadata'] {
  const block = managedBlock(teamem, metadata);
  const metadataLine = block
    .split('\n')
    .find((line) => line.startsWith('<!-- teamem:space-rules '));
  expect(metadataLine).toBeTruthy();

  return JSON.parse(
    metadataLine?.replace('<!-- teamem:space-rules ', '').replace(' -->', '') ??
      '{}'
  ) as SpaceRulesSnapshot['metadata'];
}

function managedBlockBody(
  teamem: string,
  metadata: SpaceRulesSnapshot['metadata']
): string {
  const block = managedBlock(teamem, metadata);
  const lines = block.split('\n');
  return lines.slice(2, -1).join('\n');
}

function managedBlock(
  teamem: string,
  metadata: SpaceRulesSnapshot['metadata']
): string {
  const begin = teamem.indexOf(metadata.managed_begin);
  const end = teamem.indexOf(metadata.managed_end);
  expect(begin).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(begin);

  return teamem.slice(begin, end + metadata.managed_end.length);
}

function countOccurrences(value: string, needle: string): number {
  expect(needle.length).toBeGreaterThan(0);
  return value.split(needle).length - 1;
}

function assertWorkspaceOnlyPaths(
  workspaceRoot: string,
  paths: string[]
): void {
  for (const filePath of paths) {
    expect(isPathInside(workspaceRoot, filePath)).toBe(true);
    expect(isPathInside(repoRoot, filePath)).toBe(false);
  }
}

async function assertSourceCheckoutUnchanged(input: {
  sourceTeamemBefore: OptionalFileState;
  sourceRulesCacheBefore: OptionalFileState;
}): Promise<void> {
  await expect(readOptionalFile(join(repoRoot, 'TEAMEM.md'))).resolves.toEqual(
    input.sourceTeamemBefore
  );
  await expect(
    readOptionalFile(join(repoRoot, '.teamem', 'space-rules-snapshot.json'))
  ).resolves.toEqual(input.sourceRulesCacheBefore);
}

async function readOptionalFile(path: string): Promise<OptionalFileState> {
  try {
    return { exists: true, content: await readFile(path, 'utf8') };
  } catch (err) {
    if (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      err.code === 'ENOENT'
    ) {
      return { exists: false };
    }
    throw err;
  }
}

function assertLiveInteractiveInputEvidence(
  session: InteractiveSession,
  ruleInitPrompt: string
): void {
  const submittedText = session
    .events()
    .filter((event) => event.type === 'input' && event.source === 'submit')
    .map((event) => ('data' in event ? event.data : ''))
    .join('');

  expect(submittedText).toContain(ruleInitPrompt);
}

function assertNoChannelTraces(traces: McpTrace[]): void {
  expect(traces.some((trace) => trace.serverName === 'teamem-channel')).toBe(
    false
  );
}

function assertNoTeamemMcpToolCallTrace(
  traces: McpTrace[],
  artifactsDir: string
): void {
  const teamemTrace = traces.find((trace) => trace.serverName === 'teamem');
  const toolCalls =
    teamemTrace?.messages.filter(
      (message) =>
        message.direction === 'client-to-server' &&
        message.method === 'tools/call'
    ) ?? [];

  if (toolCalls.length > 0) {
    throw new Error(
      `Expected /teamem:rule init to use Bash/direct teamem-call rather than Teamem MCP tool calls. Observed ${toolCalls
        .map((message) => message.metadata?.toolName ?? 'unknown')
        .join(', ')}. Artifacts: ${artifactsDir}`
    );
  }
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
  await expect(
    stat(session.artifacts.interactiveEventsPath)
  ).resolves.toBeTruthy();

  const environment = JSON.parse(
    await readFile(session.artifacts.environmentPath, 'utf8')
  ) as { env?: Record<string, string> };
  const summary = JSON.parse(
    await readFile(session.artifacts.summaryPath, 'utf8')
  ) as {
    kind?: string;
    cwd?: string;
    exitStatus?: {
      errorCode?: string;
    };
    result?: {
      eventCount?: number;
      hookTraceCount?: number;
      mcpTraceCount?: number;
    };
  };

  expect(summary.kind).toBe('interactive');
  expect(summary.cwd).toBe(session.cwd);
  expect(summary.exitStatus?.errorCode).toBeUndefined();
  expect(summary.result?.eventCount ?? 0).toBeGreaterThan(0);
  expect(summary.result?.hookTraceCount ?? 0).toBeGreaterThan(0);
  expectRedactedOrValue(
    environment.env?.CLAUDE_PLUGIN_DATA,
    profileEnv.CLAUDE_PLUGIN_DATA
  );
  expectRedactedOrValue(
    environment.env?.CLAUDE_PLUGIN_ROOT,
    profileEnv.CLAUDE_PLUGIN_ROOT
  );
}

function assertSessionStartEvidence(traces: HookTrace[]): void {
  const sessionStart = traces.find((trace) => trace.event === 'SessionStart');
  expect(sessionStart).toBeDefined();
  expect(sessionStart?.exitCode).toBe(0);
}

function expectRedactedOrValue(
  actual: string | undefined,
  expected: string | undefined
): void {
  expect(actual).toBeDefined();
  if (expected && actual !== '[REDACTED]') {
    expect(actual).toBe(expected);
  }
}

async function writePersonaRuleEvidence(input: {
  personaPlan: MultiProfilePersonaPlan;
  session: InteractiveSession;
  workspaceEvidence: {
    teamemPath: string;
    cachePath: string;
    teamem: string;
    cache: SnapshotCache;
  };
}): Promise<void> {
  await writeFile(
    join(
      input.personaPlan.runtimeEvidenceDir,
      `${input.personaPlan.persona}-space-rules.json`
    ),
    `${JSON.stringify(
      {
        persona: input.personaPlan.persona,
        profileName: input.personaPlan.profile.profileName,
        profileCredentialsPath: input.personaPlan.profile.credentialsPath,
        teamemPath: input.workspaceEvidence.teamemPath,
        cachePath: input.workspaceEvidence.cachePath,
        cacheSnapshot: input.workspaceEvidence.cache.snapshot,
        teamemSize: input.workspaceEvidence.teamem.length,
        artifactRunDir: input.session.artifacts.dir,
        rawTranscriptPath: input.session.artifacts.rawTranscriptPath,
        normalizedTranscriptPath:
          input.session.artifacts.normalizedTranscriptPath,
        interactiveEventsPath: input.session.artifacts.interactiveEventsPath,
        mcpTraceDir: input.session.artifacts.mcpTraceDir,
        hookTraceDir: input.session.artifacts.hookTraceDir
      },
      null,
      2
    )}\n`
  );
}

function isPathInside(parent: string, child: string): boolean {
  const relativePath = relative(resolve(parent), resolve(child));
  return (
    relativePath.length > 0 &&
    !relativePath.startsWith('..') &&
    !relativePath.includes(`..${sep}`)
  );
}

function formatGateReason(): string {
  return `Space Rules init only reads teamem.export_space_rules_snapshot and writes local TEAMEM.md/.teamem cache, so no additional stateful-live gate is required; set TEAMEM_CLAUDE_PLUGIN_E2E=1, TEAMEM_CLAUDE_PLUGIN_INTERACTIVE_E2E=1, and ${TEAMEM_MULTI_PROFILE_E2E_ENV}=1 to run L5 multi-profile Space Rules smoke`;
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
