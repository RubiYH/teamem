import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import { defaultCredentialsPath } from '../../src/bridge/credentials.js';
import { resolveDevProfilePaths } from '../../packages/bootstrapper-cli/src/dev-profiles.js';
import type { DevProfilePaths } from '../../packages/bootstrapper-cli/src/dev-profiles.js';
import type { DemoRepositoryWorkspace } from './teamem-demo-repository-workspace.js';

export const TEAMEM_MULTI_PROFILE_E2E_ENV =
  'TEAMEM_CLAUDE_PLUGIN_MULTI_PROFILE_E2E';

export type MultiProfileOwnership = 'developer' | 'test';

export type MultiProfilePersona = {
  readonly persona: 'alice' | 'bob' | string;
  readonly profileName: string;
  readonly ownership: MultiProfileOwnership;
};

export type MultiProfileCommandResult = {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

export type MultiProfileCommandRunner = (input: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}) => MultiProfileCommandResult;

export type MultiProfileCoordinatorOptions = {
  readonly runId?: string;
  readonly personas: readonly MultiProfilePersona[];
  readonly teamemRoot: string;
  readonly workspace: DemoRepositoryWorkspace;
  readonly homeDir?: string;
  readonly artifactsParentDir?: string;
  readonly allowTestOwnedSetup?: boolean;
  readonly commandRunner?: MultiProfileCommandRunner;
  readonly env?: NodeJS.ProcessEnv;
};

export type MultiProfilePersonaPlan = {
  readonly persona: string;
  readonly ownership: MultiProfileOwnership;
  readonly profile: DevProfilePaths;
  readonly artifactDir: string;
  readonly launcherPlanPath: string;
  readonly mcpTraceDir: string;
  readonly hookTraceDir: string;
  readonly transcriptDir: string;
  readonly runtimeEvidenceDir: string;
  readonly setupOwnedByTest: boolean;
  readonly result: MultiProfileCommandResult;
};

export type MultiProfileRunPlan = {
  readonly runId: string;
  readonly artifactsDir: string;
  readonly teamemRoot: string;
  readonly demoWorkspaceLaunchCwd: string;
  readonly globalCredentialsPath: string;
  readonly personaPlans: readonly MultiProfilePersonaPlan[];
};

export type MultiProfileCleanupResult = {
  readonly preserved: boolean;
  readonly artifactsDir: string;
};

export async function planTeamemDevClaudeMultiProfileRun(
  options: MultiProfileCoordinatorOptions
): Promise<MultiProfileRunPlan> {
  const runId = options.runId ?? createRunId();
  const teamemRoot = resolve(options.teamemRoot);
  const artifactsDir = join(
    options.artifactsParentDir ?? tmpdir(),
    `teamem-multi-profile-${runId}`
  );
  const runner = options.commandRunner ?? runTeamemDevClaudeDryRun;
  const env = {
    ...process.env,
    ...(options.env ?? {}),
    ...(options.homeDir
      ? {
          HOME: options.homeDir,
          USERPROFILE: options.homeDir
        }
      : {})
  };

  await mkdir(artifactsDir, { recursive: true });

  const personaPlans: MultiProfilePersonaPlan[] = [];
  for (const persona of options.personas) {
    const profile = resolveDevProfilePaths({
      homeDir: options.homeDir,
      profileName: persona.profileName
    });
    const setupOwnedByTest =
      persona.ownership === 'test' && options.allowTestOwnedSetup === true;

    if (!setupOwnedByTest && !existsSync(profile.credentialsPath)) {
      throw new Error(
        `Missing ${persona.ownership}-owned Teamem dev profile credentials for ${persona.persona}: ${profile.credentialsPath}. Refusing to open Claude before profile credentials exist.`
      );
    }

    const personaArtifactDir = join(artifactsDir, persona.persona);
    const launcherPlanPath = join(personaArtifactDir, 'launcher-plan.txt');
    const mcpTraceDir = join(personaArtifactDir, 'mcp-traces');
    const hookTraceDir = join(personaArtifactDir, 'hook-traces');
    const transcriptDir = join(personaArtifactDir, 'transcripts');
    const runtimeEvidenceDir = join(personaArtifactDir, 'runtime-evidence');
    await Promise.all([
      mkdir(mcpTraceDir, { recursive: true }),
      mkdir(hookTraceDir, { recursive: true }),
      mkdir(transcriptDir, { recursive: true }),
      mkdir(runtimeEvidenceDir, { recursive: true })
    ]);

    const args = [
      'run',
      join(teamemRoot, 'packages/bootstrapper-cli/src/bin/teamem.ts'),
      'dev',
      'claude',
      '--dry-run',
      '--profile',
      persona.profileName,
      '--teamem-root',
      teamemRoot,
      '--cwd',
      options.workspace.demoWorkspaceLaunchCwd
    ];
    const result = runner({
      command: 'bun',
      args,
      cwd: teamemRoot,
      env
    });

    await writeFile(
      launcherPlanPath,
      [
        `runId=${runId}`,
        `persona=${persona.persona}`,
        `ownership=${persona.ownership}`,
        `profile=${profile.profileName}`,
        `teamemRoot=${teamemRoot}`,
        `demoWorkspaceLaunchCwd=${options.workspace.demoWorkspaceLaunchCwd}`,
        `globalCredentialsPath=${defaultCredentialsPath()}`,
        `command=bun ${args.join(' ')}`,
        `status=${result.status}`,
        '',
        '[stdout]',
        result.stdout,
        '',
        '[stderr]',
        result.stderr
      ].join('\n')
    );

    if (result.status !== 0) {
      throw new Error(
        `teamem dev claude dry-run failed for ${persona.persona} (${persona.profileName}). Launcher plan: ${launcherPlanPath}`
      );
    }

    personaPlans.push({
      persona: persona.persona,
      ownership: persona.ownership,
      profile,
      artifactDir: personaArtifactDir,
      launcherPlanPath,
      mcpTraceDir,
      hookTraceDir,
      transcriptDir,
      runtimeEvidenceDir,
      setupOwnedByTest,
      result
    });
  }

  return {
    runId,
    artifactsDir,
    teamemRoot,
    demoWorkspaceLaunchCwd: options.workspace.demoWorkspaceLaunchCwd,
    globalCredentialsPath: defaultCredentialsPath(),
    personaPlans
  };
}

export async function finishMultiProfileRun(
  plan: MultiProfileRunPlan,
  options: { readonly success: boolean }
): Promise<MultiProfileCleanupResult> {
  if (options.success) {
    await rm(plan.artifactsDir, { recursive: true, force: true });
    for (const personaPlan of plan.personaPlans) {
      if (personaPlan.setupOwnedByTest) {
        await rm(personaPlan.profile.profileRoot, {
          recursive: true,
          force: true
        });
      }
    }
    return { preserved: false, artifactsDir: plan.artifactsDir };
  }

  await writeFile(
    join(plan.artifactsDir, 'failure-evidence.json'),
    `${JSON.stringify(formatMultiProfileRunEvidence(plan), null, 2)}\n`
  );
  return { preserved: true, artifactsDir: plan.artifactsDir };
}

export function formatMultiProfileRunEvidence(
  plan: MultiProfileRunPlan
): Record<string, unknown> {
  return {
    runId: plan.runId,
    artifactsDir: plan.artifactsDir,
    teamemRoot: plan.teamemRoot,
    demoWorkspaceLaunchCwd: plan.demoWorkspaceLaunchCwd,
    globalCredentialsPath: plan.globalCredentialsPath,
    personas: plan.personaPlans.map((personaPlan) => ({
      persona: personaPlan.persona,
      ownership: personaPlan.ownership,
      profileName: personaPlan.profile.profileName,
      profileRoot: personaPlan.profile.profileRoot,
      credentialsPath: personaPlan.profile.credentialsPath,
      artifactDir: personaPlan.artifactDir,
      launcherPlanPath: personaPlan.launcherPlanPath,
      mcpTraceDir: personaPlan.mcpTraceDir,
      hookTraceDir: personaPlan.hookTraceDir,
      transcriptDir: personaPlan.transcriptDir,
      runtimeEvidenceDir: personaPlan.runtimeEvidenceDir,
      setupOwnedByTest: personaPlan.setupOwnedByTest
    }))
  };
}

export function defaultMultiProfilePersonas(): readonly MultiProfilePersona[] {
  return [
    {
      persona: 'alice',
      profileName: process.env.TEAMEM_ALICE_PROFILE ?? 'alice',
      ownership: 'developer'
    },
    {
      persona: 'bob',
      profileName: process.env.TEAMEM_BOB_PROFILE ?? 'bob',
      ownership: 'developer'
    }
  ];
}

function runTeamemDevClaudeDryRun(input: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}): MultiProfileCommandResult {
  const result = spawnSync(input.command, [...input.args], {
    cwd: input.cwd,
    env: input.env,
    encoding: 'utf8'
  });

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr || formatSpawnError(result.error)
  };
}

function formatSpawnError(error: Error | undefined): string {
  return error ? error.message : '';
}

function createRunId(): string {
  return `${new Date().toISOString().replace(/[:.]/g, '-')}-${basename(
    process.cwd()
  )}`;
}
