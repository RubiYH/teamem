import { describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildDevLaunchPlan,
  renderDevLaunchDryRun
} from '../../packages/bootstrapper-cli/src/dev-launch.js';
import { resolveDevProfilePaths } from '../../packages/bootstrapper-cli/src/dev-profiles.js';
import type { DemoRepositoryWorkspace } from './teamem-demo-repository-workspace.js';
import type { RuntimePrerequisite } from './teamem-live-smoke-helpers.js';
import type { MultiProfileCommandRunner } from './teamem-multi-profile-coordinator.js';
import {
  TEAMEM_CHANNELS_E2E_ENV,
  TEAMEM_CHANNELS_ALLOWED_INSTRUMENTATION_DIFFERENCES,
  TEAMEM_CHANNEL_SERVER_ARG,
  TEAMEM_CHANNEL_POLL_MS,
  assertTeamemChannelsLivePrerequisites,
  assertTeamemChannelsLaunchParity,
  assertTeamemChannelsPrincipals,
  defaultTeamemChannelsPersonas,
  evaluateTeamemChannelsGate,
  finishTeamemChannelsSplitCase,
  planFreshTeamemChannelsSplitCases,
  planTeamemChannelsSplitCase,
  runTeamemChannelsRecipientReadinessSequence,
  type TeamemChannelsPersona,
  type TeamemChannelsProfileRuntime
} from './teamem-channels-session-planner.js';

describe('Teamem Channels session planner and gates', () => {
  it('keeps normal runs skipped unless every live gate and the Channels gate are enabled', () => {
    expect(evaluateTeamemChannelsGate({})).toMatchObject({
      enabled: false,
      hardFailure: false
    });

    const missingLiveGates = evaluateTeamemChannelsGate({
      [TEAMEM_CHANNELS_E2E_ENV]: '1'
    });
    expect(missingLiveGates).toMatchObject({
      enabled: false,
      hardFailure: false
    });
    expect(missingLiveGates.missingGates).toContain(
      'TEAMEM_CLAUDE_PLUGIN_E2E=1'
    );

    const enabled = evaluateTeamemChannelsGate({
      TEAMEM_CLAUDE_PLUGIN_E2E: '1',
      TEAMEM_CLAUDE_PLUGIN_INTERACTIVE_E2E: '1',
      TEAMEM_CLAUDE_PLUGIN_STATEFUL_E2E: '1',
      TEAMEM_CLAUDE_PLUGIN_MULTI_PROFILE_E2E: '1',
      CLAUDE_PLUGIN_E2E_ALLOW_UNREDACTED: '1',
      [TEAMEM_CHANNELS_E2E_ENV]: '1'
    });
    expect(enabled).toEqual({
      enabled: true,
      missingGates: [],
      hardFailure: true,
      reason: 'live Teamem Channels gate enabled'
    });
  });

  it('fails hard for missing auth or missing Alice/Bob/Carol credentials only when the live Channels gate is enabled', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'teamem-channels-gates-'));
    const homeDir = join(tempRoot, 'home');
    const personas = defaultTeamemChannelsPersonas({
      TEAMEM_CAROL_PROFILE: 'custom-carol'
    });
    const enabledGate = evaluateTeamemChannelsGate({
      TEAMEM_CLAUDE_PLUGIN_E2E: '1',
      TEAMEM_CLAUDE_PLUGIN_INTERACTIVE_E2E: '1',
      TEAMEM_CLAUDE_PLUGIN_STATEFUL_E2E: '1',
      TEAMEM_CLAUDE_PLUGIN_MULTI_PROFILE_E2E: '1',
      CLAUDE_PLUGIN_E2E_ALLOW_UNREDACTED: '1',
      [TEAMEM_CHANNELS_E2E_ENV]: '1'
    });
    const skippedGate = evaluateTeamemChannelsGate({});
    const missingAuth: RuntimePrerequisite = {
      ok: false,
      reason: 'Claude is not authenticated.'
    };
    const authReady: RuntimePrerequisite = {
      ok: true,
      selectedEntry: {
        server_url: 'https://teamem.example',
        space_id: 'space-1',
        member_name: 'alice',
        jwt: 'jwt',
        jwt_exp: Math.floor(Date.now() / 1000) + 3600,
        label: 'default'
      },
      preflightWhoami: {
        principal: 'alice',
        space_id: 'space-1',
        label: 'default'
      }
    };

    try {
      await expect(
        assertTeamemChannelsLivePrerequisites({
          gate: skippedGate,
          runtimePrerequisite: missingAuth,
          personas,
          homeDir
        })
      ).resolves.toBeUndefined();

      await expect(
        assertTeamemChannelsLivePrerequisites({
          gate: enabledGate,
          runtimePrerequisite: missingAuth,
          personas,
          homeDir
        })
      ).rejects.toThrow(/Claude is not authenticated/);

      await writeProfileCredentials(homeDir, 'alice');
      await writeProfileCredentials(homeDir, 'bob');
      await expect(
        assertTeamemChannelsLivePrerequisites({
          gate: enabledGate,
          runtimePrerequisite: authReady,
          personas,
          homeDir
        })
      ).rejects.toThrow(/custom-carol.*credentials are missing/);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('plans Bob, Carol, then Alice with Channels launch parity and artifact summaries', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'teamem-channels-plan-'));
    const homeDir = join(tempRoot, 'home');
    const teamemRoot = join(tempRoot, 'teamem');
    const demoWorkspaceLaunchCwd = join(tempRoot, 'demo-workspace');
    await Promise.all([
      writeProfileCredentials(homeDir, 'alice'),
      writeProfileCredentials(homeDir, 'bob'),
      writeProfileCredentials(homeDir, 'carol'),
      mkdir(join(teamemRoot, 'plugin'), { recursive: true }),
      mkdir(demoWorkspaceLaunchCwd, { recursive: true })
    ]);
    const invocations: Parameters<MultiProfileCommandRunner>[0][] = [];
    const runner: MultiProfileCommandRunner = (input) => {
      invocations.push(input);
      const profile = input.args[input.args.indexOf('--profile') + 1] ?? '';
      return {
        status: 0,
        stdout: fakeLauncherDryRun({
          profile,
          homeDir,
          teamemRoot,
          demoWorkspaceLaunchCwd,
          defaultSpace: 'space-default'
        }),
        stderr: ''
      };
    };

    try {
      const plan = await planTeamemChannelsSplitCase({
        runId: 'channels',
        splitCase: 'direct',
        teamemRoot,
        workspace: workspace({ teamemRoot, demoWorkspaceLaunchCwd }),
        homeDir,
        artifactsParentDir: tempRoot,
        commandRunner: runner
      });

      expect(invocations.map((call) => call.args.join(' '))).toEqual([
        expect.stringContaining('--profile alice'),
        expect.stringContaining('--profile bob'),
        expect.stringContaining('--profile carol')
      ]);
      expect(plan.recipientOrder).toEqual(['bob', 'carol']);
      expect(plan.sender).toBe('alice');
      expect(plan.personas.map((persona) => persona.persona)).toEqual([
        'bob',
        'carol',
        'alice'
      ]);
      expect(plan.personas.map((persona) => persona.order)).toEqual([1, 2, 3]);
      expect(plan.personas.map((persona) => persona.role)).toEqual([
        'passive-recipient',
        'passive-recipient',
        'sender'
      ]);

      for (const persona of plan.personas) {
        expect(persona.claudeBin).toContain('/bin/claude');
        expect(persona.profileMcpConfigPath).toContain(
          `.teamem/dev-profiles/${persona.profileName}/mcp.json`
        );
        expect(persona.launchOptions).toEqual({
          useSourcePluginDir: true,
          sessionName: `teamem-${persona.profileName}`,
          includePermissionMode: false,
          includeRunInstrumentationEnv: false,
          useInstrumentedMcpConfig: true,
          strictMcpConfig: true,
          channels: [],
          developmentChannels: [{ server: 'teamem-channel' }]
        });
        expect(persona.allowedInstrumentationDifferences).toEqual(
          TEAMEM_CHANNELS_ALLOWED_INSTRUMENTATION_DIFFERENCES
        );
        expect(existsSync(persona.envSummaryPath)).toBe(true);
        expect(existsSync(persona.launcherPlanPath)).toBe(true);
        expect(persona.profileEnv.CLAUDE_CONFIG_DIR).toContain(
          `.teamem/dev-profiles/${persona.profileName}/claude`
        );
        expect(persona.profileEnv.CLAUDE_CODE_PLUGIN_CACHE_DIR).toContain(
          `.teamem/dev-profiles/${persona.profileName}/claude/plugins`
        );
        expect(persona.profileEnv.CLAUDE_PLUGIN_DATA).toContain(
          `.teamem/dev-profiles/${persona.profileName}/plugin-data/teamem`
        );
        expect(persona.profileEnv.CLAUDE_PLUGIN_DATA).not.toContain(
          plan.multiProfilePlan.artifactsDir
        );
        expect(persona.profileEnv.CLAUDE_PLUGIN_ROOT).toBe(
          join(teamemRoot, 'plugin')
        );
        expect(persona.profileEnv.TEAMEM_CREDENTIALS).toContain(
          `.teamem/dev-profiles/${persona.profileName}/credentials.json`
        );
        expect(persona.profileEnv.CLAUDE_PLUGIN_OPTION_DEFAULT_SPACE).toBe(
          'space-default'
        );
        expect(persona.profileEnv.TEAMEM_CLAUDE_LAUNCH_SPACE).toBe(
          'space-default'
        );
        expect(persona.profileEnv.TEAMEM_CHANNEL_POLL_MS).toBe(
          TEAMEM_CHANNEL_POLL_MS
        );
        assertTeamemChannelsLaunchParity({
          personaPlan: persona,
          launchCwd: demoWorkspaceLaunchCwd,
          session: fakeSession({
            cwd: demoWorkspaceLaunchCwd,
            args: [
              '--plugin-dir',
              join(teamemRoot, 'plugin'),
              '--mcp-config',
              join(persona.artifactDir, 'run-mcp-config.json'),
              '--strict-mcp-config',
              '--dangerously-load-development-channels',
              TEAMEM_CHANNEL_SERVER_ARG
            ]
          })
        });
      }

      const launchPlan = JSON.parse(
        await readFile(plan.launchPlanPath, 'utf8')
      ) as Record<string, unknown>;
      expect(launchPlan).toMatchObject({
        runId: 'channels-direct',
        splitCase: 'direct',
        artifactIsolation: 'fresh',
        recipientOrder: ['bob', 'carol'],
        sender: 'alice'
      });
      expect(JSON.stringify(launchPlan)).toContain(
        'reduced-channel-poll-timing'
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('proves recipient readiness and cursor priming happen before Alice launch', async () => {
    const context = await createChannelsPlanFixture('readiness');
    const calls: string[] = [];

    try {
      await runTeamemChannelsRecipientReadinessSequence({
        plan: context.plan,
        runner: async ({ persona, phase }) => {
          calls.push(`${persona.persona}:${phase}`);
        }
      });

      expect(calls).toEqual([
        'bob:launch',
        'bob:channel-ready',
        'bob:cursor-primed',
        'carol:launch',
        'carol:channel-ready',
        'carol:cursor-primed',
        'alice:launch'
      ]);
      for (const persona of context.plan.personas.filter(
        (entry) => entry.role === 'passive-recipient'
      )) {
        expect(existsSync(persona.readinessArtifactPath)).toBe(true);
      }
    } finally {
      await rm(context.tempRoot, { recursive: true, force: true });
    }
  });

  it('requires Alice, Bob, and Carol to be distinct principals in the same Space before sends', () => {
    const valid = [
      runtime('alice', 'alice-principal', 'space-1'),
      runtime('bob', 'bob-principal', 'space-1'),
      runtime('carol', 'carol-principal', 'space-1')
    ];
    expect(() => assertTeamemChannelsPrincipals(valid)).not.toThrow();

    expect(() =>
      assertTeamemChannelsPrincipals([
        runtime('alice', 'alice-principal', 'space-1'),
        runtime('bob', 'alice-principal', 'space-1'),
        runtime('carol', 'carol-principal', 'space-1')
      ])
    ).toThrow(/distinct Teamem principals/);

    expect(() =>
      assertTeamemChannelsPrincipals([
        runtime('alice', 'alice-principal', 'space-1'),
        runtime('bob', 'bob-principal', 'space-2'),
        runtime('carol', 'carol-principal', 'space-1')
      ])
    ).toThrow(/same default Space/);

    expect(() =>
      assertTeamemChannelsPrincipals([
        runtime('alice', 'alice-principal', 'space-1'),
        runtime('bob', 'bob-principal', 'space-1')
      ])
    ).toThrow(/Missing carol/);
  });

  it('creates fresh Alice/Bob/Carol plans for direct, star, and starstar cases and keeps reuse debug-only', async () => {
    const context = await createChannelsPlanFixture('split-freshness');

    try {
      const freshPlans = await planFreshTeamemChannelsSplitCases({
        runId: 'fresh',
        splitCases: ['direct', 'star', 'starstar'],
        teamemRoot: context.teamemRoot,
        homeDir: context.homeDir,
        artifactsParentDir: context.tempRoot,
        workspaceFactory: async ({ splitCase }) => {
          const demoWorkspaceLaunchCwd = join(
            context.tempRoot,
            `demo-workspace-${splitCase}`
          );
          await mkdir(demoWorkspaceLaunchCwd, { recursive: true });
          return workspace({
            teamemRoot: context.teamemRoot,
            demoWorkspaceLaunchCwd
          });
        },
        commandRunner: context.runner
      });

      expect(freshPlans.map((plan) => plan.runId)).toEqual([
        'fresh-direct',
        'fresh-star',
        'fresh-starstar'
      ]);
      expect(
        new Set(freshPlans.map((plan) => plan.multiProfilePlan.artifactsDir))
          .size
      ).toBe(3);
      expect(
        new Set(
          freshPlans.map((plan) => plan.multiProfilePlan.demoWorkspaceLaunchCwd)
        ).size
      ).toBe(3);
      expect(
        new Set(
          freshPlans.flatMap((plan) =>
            plan.personas.map((persona) => persona.artifactDir)
          )
        ).size
      ).toBe(9);
      for (const plan of freshPlans) {
        expect(plan.artifactIsolation).toBe('fresh');
        expect(plan.reuseIsDebugOnly).toBe(false);
        expect(plan.personas.map((persona) => persona.persona)).toEqual([
          'bob',
          'carol',
          'alice'
        ]);
      }

      const reusePlan = await planTeamemChannelsSplitCase({
        runId: 'debug',
        splitCase: 'direct',
        teamemRoot: context.teamemRoot,
        workspace: context.workspace,
        homeDir: context.homeDir,
        artifactsParentDir: context.tempRoot,
        artifactIsolation: 'reuse',
        commandRunner: context.runner
      });
      expect(reusePlan.artifactIsolation).toBe('reuse');
      expect(reusePlan.reuseIsDebugOnly).toBe(true);
    } finally {
      await rm(context.tempRoot, { recursive: true, force: true });
    }
  });

  it('preserves persona, workspace, launch-plan, env-summary, and thrown-error paths on failure', async () => {
    const context = await createChannelsPlanFixture('failure-paths');
    const error = new Error('recipient channel readiness timed out');

    try {
      const cleanup = await finishTeamemChannelsSplitCase(context.plan, {
        success: false,
        error,
        workspacePath: context.demoWorkspaceLaunchCwd
      });
      expect(cleanup.preserved).toBe(true);
      expect(cleanup.failurePathsPath).toBe(
        join(
          context.plan.multiProfilePlan.artifactsDir,
          'channels-failure-paths.json'
        )
      );
      expect(cleanup.failureError?.message).toContain(error.message);
      expect(cleanup.failureError?.message).toContain(cleanup.artifactsDir);
      expect(cleanup.failureError?.message).toContain(
        context.demoWorkspaceLaunchCwd
      );
      expect(cleanup.failureError?.message).toContain(
        context.plan.launchPlanPath
      );
      const failurePaths = JSON.parse(
        await readFile(
          join(
            context.plan.multiProfilePlan.artifactsDir,
            'channels-failure-paths.json'
          ),
          'utf8'
        )
      ) as {
        error: string;
        artifactsDir: string;
        workspace: string;
        launchPlanPath: string;
        personas: Array<{
          persona: string;
          artifactDir: string;
          envSummaryPath: string;
          launcherPlanPath: string;
        }>;
      };

      expect(failurePaths.error).toBe(error.message);
      expect(failurePaths.artifactsDir).toBe(
        context.plan.multiProfilePlan.artifactsDir
      );
      expect(failurePaths.workspace).toBe(context.demoWorkspaceLaunchCwd);
      expect(failurePaths.launchPlanPath).toBe(context.plan.launchPlanPath);
      expect(failurePaths.personas.map((persona) => persona.persona)).toEqual([
        'bob',
        'carol',
        'alice'
      ]);
      for (const persona of failurePaths.personas) {
        expect(existsSync(persona.artifactDir)).toBe(true);
        expect(existsSync(persona.envSummaryPath)).toBe(true);
        expect(existsSync(persona.launcherPlanPath)).toBe(true);
        expect(cleanup.failureError?.message).toContain(persona.artifactDir);
        expect(cleanup.failureError?.message).toContain(persona.envSummaryPath);
        expect(cleanup.failureError?.message).toContain(
          persona.launcherPlanPath
        );
      }
    } finally {
      await rm(context.tempRoot, { recursive: true, force: true });
    }
  });
});

async function createChannelsPlanFixture(label: string): Promise<{
  tempRoot: string;
  homeDir: string;
  teamemRoot: string;
  demoWorkspaceLaunchCwd: string;
  workspace: DemoRepositoryWorkspace;
  runner: MultiProfileCommandRunner;
  plan: Awaited<ReturnType<typeof planTeamemChannelsSplitCase>>;
}> {
  const tempRoot = await mkdtemp(join(tmpdir(), `teamem-channels-${label}-`));
  const homeDir = join(tempRoot, 'home');
  const teamemRoot = join(tempRoot, 'teamem');
  const demoWorkspaceLaunchCwd = join(tempRoot, 'demo-workspace');
  await Promise.all([
    writeProfileCredentials(homeDir, 'alice'),
    writeProfileCredentials(homeDir, 'bob'),
    writeProfileCredentials(homeDir, 'carol'),
    mkdir(join(teamemRoot, 'plugin'), { recursive: true }),
    mkdir(demoWorkspaceLaunchCwd, { recursive: true })
  ]);
  const fixtureWorkspace = workspace({ teamemRoot, demoWorkspaceLaunchCwd });
  const runner: MultiProfileCommandRunner = (input) => {
    const profile = input.args[input.args.indexOf('--profile') + 1] ?? '';
    const launchCwd =
      input.args[input.args.indexOf('--cwd') + 1] ?? demoWorkspaceLaunchCwd;
    return {
      status: 0,
      stdout: fakeLauncherDryRun({
        profile,
        homeDir,
        teamemRoot,
        demoWorkspaceLaunchCwd: launchCwd,
        defaultSpace: 'space-default'
      }),
      stderr: ''
    };
  };
  const plan = await planTeamemChannelsSplitCase({
    runId: label,
    splitCase: 'direct',
    teamemRoot,
    workspace: fixtureWorkspace,
    homeDir,
    artifactsParentDir: tempRoot,
    commandRunner: runner
  });

  return {
    tempRoot,
    homeDir,
    teamemRoot,
    demoWorkspaceLaunchCwd,
    workspace: fixtureWorkspace,
    runner,
    plan
  };
}

async function writeProfileCredentials(
  homeDir: string,
  profileName: string
): Promise<void> {
  const profileRoot = join(homeDir, '.teamem', 'dev-profiles', profileName);
  await mkdir(profileRoot, { recursive: true });
  await writeFile(
    join(profileRoot, 'credentials.json'),
    JSON.stringify({ spaces: [] })
  );
}

function fakeLauncherDryRun(input: {
  profile: string;
  homeDir: string;
  teamemRoot: string;
  demoWorkspaceLaunchCwd: string;
  defaultSpace: string;
}): string {
  return renderDevLaunchDryRun(
    buildDevLaunchPlan({
      source: {
        teamemRoot: input.teamemRoot,
        pluginRoot: join(input.teamemRoot, 'plugin'),
        launchCwd: input.demoWorkspaceLaunchCwd,
        source: 'flag'
      },
      profile: resolveDevProfilePaths({
        homeDir: input.homeDir,
        profileName: input.profile
      }),
      claudeArgs: [],
      pathEnv: '/opt/claude/bin',
      fileSystem: executableFileSystem(['/opt/claude/bin/claude']),
      defaultSpaceId: input.defaultSpace
    })
  );
}

function workspace(input: {
  teamemRoot: string;
  demoWorkspaceLaunchCwd: string;
}): DemoRepositoryWorkspace {
  return {
    teamemSourceRoot: input.teamemRoot,
    templateRoot: join(
      input.teamemRoot,
      'tests/fixtures/demo-repository-template'
    ),
    demoWorkspaceLaunchCwd: input.demoWorkspaceLaunchCwd,
    initialBranch: 'main',
    featureBranches: []
  };
}

function fakeSession(input: {
  cwd: string;
  args: readonly string[];
}): Parameters<typeof assertTeamemChannelsLaunchParity>[0]['session'] {
  return {
    cwd: input.cwd,
    command: {
      command: 'claude',
      args: [...input.args]
    }
  } as Parameters<typeof assertTeamemChannelsLaunchParity>[0]['session'];
}

function executableFileSystem(executableFiles: readonly string[]) {
  const executable = new Set(executableFiles);
  return {
    exists(path: string): boolean {
      return executable.has(path);
    },
    isDirectory(): boolean {
      return false;
    },
    isReadableFile(): boolean {
      return false;
    },
    isExecutableFile(path: string): boolean {
      return executable.has(path);
    },
    readFile(): string {
      return '';
    },
    writeFile(): void {
      // The Channels planner dry-run path only needs executable detection.
    }
  };
}

function runtime(
  persona: TeamemChannelsPersona,
  principal: string,
  spaceId: string
): TeamemChannelsProfileRuntime {
  return {
    persona,
    profileName: persona,
    credentialsPath: `/profiles/${persona}/credentials.json`,
    whoami: {
      principal,
      space_id: spaceId,
      label: 'default'
    }
  };
}
