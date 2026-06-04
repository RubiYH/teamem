import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  BootResult,
  InteractiveSession
} from '../../plugin-e2e-module/src/index.js';
import { resolveDevProfilePaths } from '../../packages/bootstrapper-cli/src/dev-profiles.js';
import {
  checkJwtExp,
  loadCredentials,
  pickEntry
} from '../../src/bridge/credentials.js';
import type { RuntimeWhoamiEvidence } from './teamem-live-smoke-helpers.js';
import {
  createLiveRuntimeEnv,
  type RuntimePrerequisite
} from './teamem-live-smoke-helpers.js';
import type { DemoRepositoryWorkspace } from './teamem-demo-repository-workspace.js';
import {
  finishMultiProfileRun,
  planTeamemDevClaudeMultiProfileRun,
  TEAMEM_MULTI_PROFILE_E2E_ENV,
  type MultiProfileCommandRunner,
  type MultiProfilePersona,
  type MultiProfileRunPlan
} from './teamem-multi-profile-coordinator.js';

export const TEAMEM_CHANNELS_E2E_ENV = 'TEAMEM_CLAUDE_PLUGIN_CHANNELS_E2E';
export const TEAMEM_CHANNEL_SERVER_NAME = 'teamem-channel';
export const TEAMEM_CHANNEL_SERVER_ARG = `server:${TEAMEM_CHANNEL_SERVER_NAME}`;
export const TEAMEM_CHANNEL_POLL_MS = '1000';

export type TeamemChannelsPersona = 'alice' | 'bob' | 'carol';
export type TeamemChannelsSplitCase = 'direct' | 'star' | 'starstar';
export type TeamemChannelsArtifactIsolation = 'fresh' | 'reuse';
export type TeamemChannelsFreshWorkspaceFactory = (input: {
  readonly runId: string;
  readonly splitCase: TeamemChannelsSplitCase;
  readonly index: number;
}) => DemoRepositoryWorkspace | Promise<DemoRepositoryWorkspace>;

export type TeamemChannelsGateEvaluation = {
  readonly enabled: boolean;
  readonly missingGates: readonly string[];
  readonly hardFailure: boolean;
  readonly reason: string;
};

export type TeamemChannelsProfileRuntime = {
  readonly persona: TeamemChannelsPersona;
  readonly profileName: string;
  readonly credentialsPath: string;
  readonly whoami: RuntimeWhoamiEvidence;
};

export type TeamemChannelsPersonaLaunchPlan = {
  readonly persona: TeamemChannelsPersona;
  readonly order: number;
  readonly role: 'passive-recipient' | 'sender';
  readonly profileName: string;
  readonly claudeBin: string;
  readonly artifactDir: string;
  readonly launcherPlanPath: string;
  readonly envSummaryPath: string;
  readonly readinessArtifactPath: string;
  readonly profileMcpConfigPath: string;
  readonly profileEnv: NodeJS.ProcessEnv;
  readonly launchOptions: {
    readonly useSourcePluginDir: true;
    readonly sessionName: string;
    readonly includePermissionMode: false;
    readonly includeRunInstrumentationEnv: false;
    readonly useInstrumentedMcpConfig: true;
    readonly strictMcpConfig: true;
    readonly channels: readonly { readonly server: string }[];
    readonly developmentChannels: readonly [{ readonly server: string }];
  };
  readonly allowedInstrumentationDifferences: readonly string[];
};

export type TeamemChannelsSplitCasePlan = {
  readonly runId: string;
  readonly splitCase: TeamemChannelsSplitCase;
  readonly artifactIsolation: TeamemChannelsArtifactIsolation;
  readonly reuseIsDebugOnly: boolean;
  readonly multiProfilePlan: MultiProfileRunPlan;
  readonly recipientOrder: readonly ['bob', 'carol'];
  readonly sender: 'alice';
  readonly personas: readonly TeamemChannelsPersonaLaunchPlan[];
  readonly launchPlanPath: string;
};

export type TeamemChannelsReadinessRunner = (input: {
  readonly persona: TeamemChannelsPersonaLaunchPlan;
  readonly phase: 'launch' | 'channel-ready' | 'cursor-primed';
}) => Promise<void>;

export type TeamemChannelsLaunchedSession = {
  readonly persona: TeamemChannelsPersona;
  readonly session: InteractiveSession;
};

export const TEAMEM_CHANNELS_ALLOWED_INSTRUMENTATION_DIFFERENCES = [
  'mcp-proxy-wrapping',
  'artifact-directories',
  'debug-files',
  'pty-wrapper-behavior',
  'profile-log-checkpoints',
  'reduced-channel-poll-timing'
] as const;

export function evaluateTeamemChannelsGate(
  env: NodeJS.ProcessEnv = process.env
): TeamemChannelsGateEvaluation {
  const requiredGates = [
    ['TEAMEM_CLAUDE_PLUGIN_E2E', env.TEAMEM_CLAUDE_PLUGIN_E2E],
    [
      'TEAMEM_CLAUDE_PLUGIN_INTERACTIVE_E2E',
      env.TEAMEM_CLAUDE_PLUGIN_INTERACTIVE_E2E
    ],
    [
      'TEAMEM_CLAUDE_PLUGIN_STATEFUL_E2E',
      env.TEAMEM_CLAUDE_PLUGIN_STATEFUL_E2E
    ],
    [TEAMEM_MULTI_PROFILE_E2E_ENV, env[TEAMEM_MULTI_PROFILE_E2E_ENV]],
    [
      'CLAUDE_PLUGIN_E2E_ALLOW_UNREDACTED',
      env.CLAUDE_PLUGIN_E2E_ALLOW_UNREDACTED
    ]
  ] as const;
  const channelsGateEnabled = env[TEAMEM_CHANNELS_E2E_ENV] === '1';
  const missingGates = requiredGates
    .filter(([, value]) => value !== '1')
    .map(([name]) => `${name}=1`);

  if (!channelsGateEnabled) {
    return {
      enabled: false,
      missingGates,
      hardFailure: false,
      reason: `set ${TEAMEM_CHANNELS_E2E_ENV}=1 plus ${requiredGates
        .map(([name]) => `${name}=1`)
        .join(', ')} to run live Teamem Channels smokes`
    };
  }

  if (missingGates.length > 0) {
    return {
      enabled: false,
      missingGates,
      hardFailure: false,
      reason: `set ${missingGates.join(', ')} to run live Teamem Channels smokes`
    };
  }

  return {
    enabled: true,
    missingGates: [],
    hardFailure: true,
    reason: 'live Teamem Channels gate enabled'
  };
}

export function defaultTeamemChannelsPersonas(
  env: NodeJS.ProcessEnv = process.env
): readonly MultiProfilePersona[] {
  return [
    {
      persona: 'alice',
      profileName: env.TEAMEM_ALICE_PROFILE ?? 'alice',
      ownership: 'developer'
    },
    {
      persona: 'bob',
      profileName: env.TEAMEM_BOB_PROFILE ?? 'bob',
      ownership: 'developer'
    },
    {
      persona: 'carol',
      profileName: env.TEAMEM_CAROL_PROFILE ?? 'carol',
      ownership: 'developer'
    }
  ];
}

export async function assertTeamemChannelsLivePrerequisites(input: {
  readonly gate: TeamemChannelsGateEvaluation;
  readonly runtimePrerequisite: RuntimePrerequisite;
  readonly personas: readonly MultiProfilePersona[];
  readonly homeDir?: string;
}): Promise<void> {
  if (!input.gate.enabled) {
    return;
  }
  if (!input.runtimePrerequisite.ok) {
    throw new Error(
      `Live Teamem Channels gate is enabled but Claude/Teamem auth is not ready: ${input.runtimePrerequisite.reason}`
    );
  }

  for (const persona of input.personas) {
    const profile = resolveDevProfilePaths({
      homeDir: input.homeDir,
      profileName: persona.profileName
    });
    if (!existsSync(profile.credentialsPath)) {
      throw new Error(
        `Live Teamem Channels gate is enabled but ${persona.persona} profile ${persona.profileName} credentials are missing: ${profile.credentialsPath}`
      );
    }
  }
}

export async function planTeamemChannelsSplitCase(options: {
  readonly runId: string;
  readonly splitCase: TeamemChannelsSplitCase;
  readonly teamemRoot: string;
  readonly workspace: DemoRepositoryWorkspace;
  readonly homeDir?: string;
  readonly artifactsParentDir?: string;
  readonly artifactIsolation?: TeamemChannelsArtifactIsolation;
  readonly commandRunner?: MultiProfileCommandRunner;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<TeamemChannelsSplitCasePlan> {
  const multiProfilePlan = await planTeamemDevClaudeMultiProfileRun({
    runId: `${options.runId}-${options.splitCase}`,
    personas: defaultTeamemChannelsPersonas(options.env),
    teamemRoot: options.teamemRoot,
    workspace: options.workspace,
    homeDir: options.homeDir,
    artifactsParentDir: options.artifactsParentDir,
    commandRunner: options.commandRunner,
    env: options.env
  });
  const artifactIsolation = options.artifactIsolation ?? 'fresh';
  const personas = (['bob', 'carol', 'alice'] as const).map((persona, index) =>
    createChannelsPersonaLaunchPlan({
      multiProfilePlan,
      persona,
      order: index + 1,
      role: persona === 'alice' ? 'sender' : 'passive-recipient',
      teamemPluginDir: join(options.teamemRoot, 'plugin')
    })
  );
  const launchPlanPath = join(
    multiProfilePlan.artifactsDir,
    'channels-launch-plan.json'
  );
  const splitCasePlan: TeamemChannelsSplitCasePlan = {
    runId: multiProfilePlan.runId,
    splitCase: options.splitCase,
    artifactIsolation,
    reuseIsDebugOnly: artifactIsolation === 'reuse',
    multiProfilePlan,
    recipientOrder: ['bob', 'carol'],
    sender: 'alice',
    personas,
    launchPlanPath
  };

  await mkdir(multiProfilePlan.artifactsDir, { recursive: true });
  await writeFile(
    launchPlanPath,
    `${JSON.stringify(formatChannelsSplitCasePlan(splitCasePlan), null, 2)}\n`
  );
  await Promise.all(
    personas.map((persona) =>
      writeFile(
        persona.envSummaryPath,
        `${JSON.stringify(formatPersonaEnvSummary(persona), null, 2)}\n`
      )
    )
  );

  return splitCasePlan;
}

export async function planFreshTeamemChannelsSplitCases(options: {
  readonly runId: string;
  readonly splitCases: readonly TeamemChannelsSplitCase[];
  readonly teamemRoot: string;
  readonly workspaceFactory: TeamemChannelsFreshWorkspaceFactory;
  readonly homeDir?: string;
  readonly artifactsParentDir?: string;
  readonly commandRunner?: MultiProfileCommandRunner;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<readonly TeamemChannelsSplitCasePlan[]> {
  const plans: TeamemChannelsSplitCasePlan[] = [];
  for (const [index, splitCase] of options.splitCases.entries()) {
    const workspace = await options.workspaceFactory({
      runId: options.runId,
      splitCase,
      index
    });
    plans.push(
      await planTeamemChannelsSplitCase({
        ...options,
        workspace,
        splitCase,
        artifactIsolation: 'fresh'
      })
    );
  }
  assertFreshSplitIsolation(plans);
  return plans;
}

export function assertTeamemChannelsPrincipals(
  runtimes: readonly TeamemChannelsProfileRuntime[]
): void {
  const byPersona = new Map(
    runtimes.map((runtime) => [runtime.persona, runtime])
  );
  for (const persona of ['alice', 'bob', 'carol'] as const) {
    if (!byPersona.has(persona)) {
      throw new Error(`Missing ${persona} Teamem principal validation.`);
    }
  }
  const spaceIds = new Set(runtimes.map((runtime) => runtime.whoami.space_id));
  if (spaceIds.size !== 1) {
    throw new Error(
      `Alice, Bob, and Carol must be in the same default Space before Channels sends. Observed Spaces: ${[...spaceIds].join(', ')}`
    );
  }
  const principals = new Set(
    runtimes.map((runtime) => runtime.whoami.principal)
  );
  if (principals.size !== runtimes.length) {
    throw new Error(
      `Alice, Bob, and Carol must be distinct Teamem principals before Channels sends. Observed principals: ${[...principals].join(', ')}`
    );
  }
}

export async function inspectTeamemChannelsProfileRuntime(input: {
  readonly persona: TeamemChannelsPersona;
  readonly profileName: string;
  readonly credentialsPath: string;
  readonly whoami: (credentialsPath: string) => Promise<RuntimeWhoamiEvidence>;
}): Promise<TeamemChannelsProfileRuntime> {
  const credentials = await loadCredentials(input.credentialsPath);
  if (!credentials) {
    throw new Error(
      `Invalid ${input.persona} profile credentials at ${input.credentialsPath}; refusing to open Claude.`
    );
  }
  const entry = pickEntry({ creds: credentials });
  checkJwtExp(entry);
  const whoami = await input.whoami(input.credentialsPath);
  if (whoami.principal !== entry.member_name) {
    throw new Error(
      `${input.persona} profile principal mismatch: credentials=${entry.member_name}, whoami=${whoami.principal}`
    );
  }
  if (whoami.space_id !== entry.space_id) {
    throw new Error(
      `${input.persona} profile Space mismatch: credentials=${entry.space_id}, whoami=${whoami.space_id}`
    );
  }
  return {
    persona: input.persona,
    profileName: input.profileName,
    credentialsPath: input.credentialsPath,
    whoami
  };
}

export async function runTeamemChannelsRecipientReadinessSequence(input: {
  readonly plan: TeamemChannelsSplitCasePlan;
  readonly runner: TeamemChannelsReadinessRunner;
}): Promise<void> {
  for (const personaName of input.plan.recipientOrder) {
    const persona = requireChannelsPersonaPlan(input.plan, personaName);
    await input.runner({ persona, phase: 'launch' });
    await input.runner({ persona, phase: 'channel-ready' });
    await input.runner({ persona, phase: 'cursor-primed' });
    await writeFile(
      persona.readinessArtifactPath,
      `${JSON.stringify(
        {
          persona: persona.persona,
          launched: true,
          channelReady: true,
          cursorPrimed: true
        },
        null,
        2
      )}\n`
    );
  }

  await input.runner({
    persona: requireChannelsPersonaPlan(input.plan, 'alice'),
    phase: 'launch'
  });
}

export async function finishTeamemChannelsSplitCase(
  plan: TeamemChannelsSplitCasePlan,
  options: {
    readonly success: boolean;
    readonly error?: unknown;
    readonly workspacePath?: string;
  }
): Promise<{
  readonly preserved: boolean;
  readonly artifactsDir: string;
  readonly failurePathsPath?: string;
  readonly failureError?: Error;
}> {
  const failurePathsPath = join(
    plan.multiProfilePlan.artifactsDir,
    'channels-failure-paths.json'
  );
  const failurePaths = {
    error:
      options.error instanceof Error
        ? options.error.message
        : String(options.error ?? ''),
    artifactsDir: plan.multiProfilePlan.artifactsDir,
    workspace:
      options.workspacePath ?? plan.multiProfilePlan.demoWorkspaceLaunchCwd,
    launchPlanPath: plan.launchPlanPath,
    personas: plan.personas.map((persona) => ({
      persona: persona.persona,
      artifactDir: persona.artifactDir,
      envSummaryPath: persona.envSummaryPath,
      launcherPlanPath: persona.launcherPlanPath,
      readinessArtifactPath: persona.readinessArtifactPath
    }))
  };
  if (!options.success) {
    await writeFile(
      failurePathsPath,
      `${JSON.stringify(failurePaths, null, 2)}\n`
    );
  }
  const cleanup = await finishMultiProfileRun(plan.multiProfilePlan, {
    success: options.success
  });
  if (options.success) {
    return cleanup;
  }
  return {
    ...cleanup,
    failurePathsPath,
    failureError: new Error(
      formatChannelsFailureMessage(failurePathsPath, failurePaths)
    )
  };
}

export function assertTeamemChannelsLaunchParity(input: {
  readonly personaPlan: TeamemChannelsPersonaLaunchPlan;
  readonly boot?: BootResult;
  readonly session?: InteractiveSession;
  readonly launchCwd: string;
}): void {
  const env = input.personaPlan.profileEnv;
  assertEnvValue(env.CLAUDE_CONFIG_DIR, 'CLAUDE_CONFIG_DIR');
  assertEnvValue(
    env.CLAUDE_CODE_PLUGIN_CACHE_DIR,
    'CLAUDE_CODE_PLUGIN_CACHE_DIR'
  );
  assertEnvValue(env.CLAUDE_PLUGIN_DATA, 'CLAUDE_PLUGIN_DATA');
  assertEnvValue(env.CLAUDE_PLUGIN_ROOT, 'CLAUDE_PLUGIN_ROOT');
  assertEnvValue(env.TEAMEM_CREDENTIALS, 'TEAMEM_CREDENTIALS');
  if (env.CLAUDE_CODE_MCP_ALLOWLIST_ENV !== '1') {
    throw new Error('Expected strict MCP allowlist env for Channels launch.');
  }
  if (env.TEAMEM_CLAUDE_LAUNCH_INTENT !== 'activate') {
    throw new Error('Expected TEAMEM_CLAUDE_LAUNCH_INTENT=activate.');
  }
  if (
    env.CLAUDE_PLUGIN_OPTION_DEFAULT_SPACE !== env.TEAMEM_CLAUDE_LAUNCH_SPACE
  ) {
    throw new Error(
      'Expected default Space and launch-intent Space env to match.'
    );
  }
  if (env.TEAMEM_CHANNEL_POLL_MS !== TEAMEM_CHANNEL_POLL_MS) {
    throw new Error('Expected reduced Teamem channel poll timing.');
  }

  const sessionArgs = input.session?.command.args ?? [];
  if (sessionArgs.length > 0) {
    assertArgPresent(sessionArgs, '--plugin-dir');
    assertArgPresent(sessionArgs, '--mcp-config');
    assertArgPresent(sessionArgs, '--strict-mcp-config');
    assertArgPresent(sessionArgs, '--dangerously-load-development-channels');
    if (sessionArgs.includes('--channels')) {
      throw new Error(
        `Did not expect --channels for local ${TEAMEM_CHANNEL_SERVER_ARG}; use --dangerously-load-development-channels only.`
      );
    }
    if (
      sessionArgs.filter((arg) => arg === TEAMEM_CHANNEL_SERVER_ARG).length !==
      1
    ) {
      throw new Error(
        `Expected exactly one ${TEAMEM_CHANNEL_SERVER_ARG} development Channel entry.`
      );
    }
    if (input.session?.cwd !== input.launchCwd) {
      throw new Error(
        `Expected Channels session cwd ${input.launchCwd}; got ${input.session?.cwd}`
      );
    }
  }
  if (input.boot && input.boot.plugin.pluginDir !== env.CLAUDE_PLUGIN_ROOT) {
    throw new Error('Expected effective plugin root to match Teamem plugin.');
  }
}

function createChannelsPersonaLaunchPlan(input: {
  readonly multiProfilePlan: MultiProfileRunPlan;
  readonly persona: TeamemChannelsPersona;
  readonly order: number;
  readonly role: 'passive-recipient' | 'sender';
  readonly teamemPluginDir: string;
}): TeamemChannelsPersonaLaunchPlan {
  const personaPlan = input.multiProfilePlan.personaPlans.find(
    (plan) => plan.persona === input.persona
  );
  if (!personaPlan) {
    throw new Error(`Missing ${input.persona} multi-profile launch plan.`);
  }
  const defaultSpace = readDefaultSpaceFromDryRun(personaPlan.result.stdout);
  const claudeBin = readClaudeCommandFromDryRun(personaPlan.result.stdout);
  if (!defaultSpace) {
    throw new Error(
      `Missing default Space in ${input.persona} launcher plan: ${personaPlan.launcherPlanPath}`
    );
  }
  if (!claudeBin) {
    throw new Error(
      `Missing Claude command in ${input.persona} launcher plan: ${personaPlan.launcherPlanPath}`
    );
  }
  const profileEnv = createChannelsProfileEnv({
    profile: personaPlan.profile,
    pluginRoot: input.teamemPluginDir,
    defaultSpace
  });

  return {
    persona: input.persona,
    order: input.order,
    role: input.role,
    profileName: personaPlan.profile.profileName,
    claudeBin,
    artifactDir: personaPlan.artifactDir,
    launcherPlanPath: personaPlan.launcherPlanPath,
    envSummaryPath: join(personaPlan.artifactDir, 'env-summary.json'),
    readinessArtifactPath: join(
      personaPlan.artifactDir,
      'recipient-readiness.json'
    ),
    profileMcpConfigPath: personaPlan.profile.mcpConfigPath,
    profileEnv,
    launchOptions: {
      useSourcePluginDir: true,
      sessionName: `teamem-${personaPlan.profile.profileName}`,
      includePermissionMode: false,
      includeRunInstrumentationEnv: false,
      useInstrumentedMcpConfig: true,
      strictMcpConfig: true,
      channels: [],
      developmentChannels: [{ server: TEAMEM_CHANNEL_SERVER_NAME }]
    },
    allowedInstrumentationDifferences:
      TEAMEM_CHANNELS_ALLOWED_INSTRUMENTATION_DIFFERENCES
  };
}

function createChannelsProfileEnv(input: {
  readonly profile: {
    readonly claudeConfigDir: string;
    readonly pluginCacheDir: string;
    readonly pluginDataDir: string;
    readonly credentialsPath: string;
  };
  readonly pluginRoot: string;
  readonly defaultSpace: string;
}): NodeJS.ProcessEnv {
  return {
    ...createLiveRuntimeEnv(),
    CLAUDE_CONFIG_DIR: input.profile.claudeConfigDir,
    CLAUDE_CODE_PLUGIN_CACHE_DIR: input.profile.pluginCacheDir,
    CLAUDE_CODE_MCP_ALLOWLIST_ENV: '1',
    CLAUDE_PLUGIN_DATA: input.profile.pluginDataDir,
    CLAUDE_PLUGIN_ROOT: input.pluginRoot,
    CLAUDE_PLUGIN_OPTION_DEFAULT_SPACE: input.defaultSpace,
    TEAMEM_CREDENTIALS: input.profile.credentialsPath,
    TEAMEM_CLAUDE_LAUNCH_INTENT: 'activate',
    TEAMEM_CLAUDE_LAUNCH_SPACE: input.defaultSpace,
    TEAMEM_CHANNEL_POLL_MS: TEAMEM_CHANNEL_POLL_MS
  };
}

function formatChannelsSplitCasePlan(
  plan: TeamemChannelsSplitCasePlan
): Record<string, unknown> {
  return {
    runId: plan.runId,
    splitCase: plan.splitCase,
    artifactIsolation: plan.artifactIsolation,
    reuseIsDebugOnly: plan.reuseIsDebugOnly,
    recipientOrder: plan.recipientOrder,
    sender: plan.sender,
    allowedInstrumentationDifferences:
      TEAMEM_CHANNELS_ALLOWED_INSTRUMENTATION_DIFFERENCES,
    personas: plan.personas.map((persona) => ({
      persona: persona.persona,
      order: persona.order,
      role: persona.role,
      profileName: persona.profileName,
      claudeBin: persona.claudeBin,
      artifactDir: persona.artifactDir,
      launcherPlanPath: persona.launcherPlanPath,
      envSummaryPath: persona.envSummaryPath,
      readinessArtifactPath: persona.readinessArtifactPath,
      profileMcpConfigPath: persona.profileMcpConfigPath,
      launchOptions: persona.launchOptions
    }))
  };
}

function formatPersonaEnvSummary(
  persona: TeamemChannelsPersonaLaunchPlan
): Record<string, unknown> {
  const env = persona.profileEnv;
  return {
    persona: persona.persona,
    profileName: persona.profileName,
    claudeBin: persona.claudeBin,
    env: {
      CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR,
      CLAUDE_CODE_PLUGIN_CACHE_DIR: env.CLAUDE_CODE_PLUGIN_CACHE_DIR,
      CLAUDE_CODE_MCP_ALLOWLIST_ENV: env.CLAUDE_CODE_MCP_ALLOWLIST_ENV,
      CLAUDE_PLUGIN_DATA: env.CLAUDE_PLUGIN_DATA,
      CLAUDE_PLUGIN_ROOT: env.CLAUDE_PLUGIN_ROOT,
      CLAUDE_PLUGIN_OPTION_DEFAULT_SPACE:
        env.CLAUDE_PLUGIN_OPTION_DEFAULT_SPACE,
      TEAMEM_CREDENTIALS: env.TEAMEM_CREDENTIALS,
      TEAMEM_CLAUDE_LAUNCH_INTENT: env.TEAMEM_CLAUDE_LAUNCH_INTENT,
      TEAMEM_CLAUDE_LAUNCH_SPACE: env.TEAMEM_CLAUDE_LAUNCH_SPACE,
      TEAMEM_CHANNEL_POLL_MS: env.TEAMEM_CHANNEL_POLL_MS
    },
    allowedInstrumentationDifferences:
      TEAMEM_CHANNELS_ALLOWED_INSTRUMENTATION_DIFFERENCES
  };
}

function readDefaultSpaceFromDryRun(stdout: string): string {
  const match =
    stdout.match(/^Default Space:\s*(.+)$/m) ??
    stdout.match(/^TEAMEM_CLAUDE_LAUNCH_SPACE=(.+)$/m);
  return match?.[1]?.trim() || '';
}

function readClaudeCommandFromDryRun(stdout: string): string {
  const match = stdout.match(/^Command:\s*(.+)$/m);
  return match?.[1]?.trim() || '';
}

function assertFreshSplitIsolation(
  plans: readonly TeamemChannelsSplitCasePlan[]
): void {
  assertUniqueFreshValues(
    'fresh Channels launch cwd',
    plans.map((plan) => plan.multiProfilePlan.demoWorkspaceLaunchCwd)
  );
  assertUniqueFreshValues(
    'fresh Channels artifact dir',
    plans.flatMap((plan) => plan.personas.map((persona) => persona.artifactDir))
  );
}

function assertUniqueFreshValues(
  label: string,
  values: readonly (string | undefined)[]
): void {
  const presentValues = values.filter((value): value is string =>
    Boolean(value)
  );
  if (new Set(presentValues).size !== presentValues.length) {
    throw new Error(`Expected unique ${label} per fresh split case.`);
  }
}

function formatChannelsFailureMessage(
  failurePathsPath: string,
  failurePaths: {
    readonly error: string;
    readonly artifactsDir: string;
    readonly workspace: string | undefined;
    readonly launchPlanPath: string;
    readonly personas: readonly {
      readonly persona: TeamemChannelsPersona;
      readonly artifactDir: string;
      readonly envSummaryPath: string;
      readonly launcherPlanPath: string;
      readonly readinessArtifactPath: string;
    }[];
  }
): string {
  return [
    `Teamem Channels split case failed: ${failurePaths.error}`,
    `artifactsDir=${failurePaths.artifactsDir}`,
    `failurePaths=${failurePathsPath}`,
    `workspace=${failurePaths.workspace ?? ''}`,
    `launchPlanPath=${failurePaths.launchPlanPath}`,
    ...failurePaths.personas.flatMap((persona) => [
      `${persona.persona}.artifactDir=${persona.artifactDir}`,
      `${persona.persona}.launcherPlanPath=${persona.launcherPlanPath}`,
      `${persona.persona}.envSummaryPath=${persona.envSummaryPath}`,
      `${persona.persona}.readinessArtifactPath=${persona.readinessArtifactPath}`
    ])
  ].join('\n');
}

function requireChannelsPersonaPlan(
  plan: TeamemChannelsSplitCasePlan,
  persona: TeamemChannelsPersona
): TeamemChannelsPersonaLaunchPlan {
  const found = plan.personas.find((entry) => entry.persona === persona);
  if (!found) {
    throw new Error(`Missing Channels plan for ${persona}.`);
  }
  return found;
}

function assertEnvValue(value: string | undefined, key: string): void {
  if (!value) {
    throw new Error(`Expected ${key} for Channels launch.`);
  }
}

function assertArgPresent(args: readonly string[], flag: string): void {
  if (!args.includes(flag)) {
    throw new Error(`Expected Claude launch flag ${flag}.`);
  }
}
