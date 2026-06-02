import { describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  finishMultiProfileRun,
  formatMultiProfileRunEvidence,
  planTeamemDevClaudeMultiProfileRun,
  type MultiProfileCommandRunner
} from './teamem-multi-profile-coordinator.js';
import type { DemoRepositoryWorkspace } from './teamem-demo-repository-workspace.js';

describe('Teamem multi-profile coordinator', () => {
  it('plans Alice and Bob through teamem dev claude dry-run with persona-separated artifacts', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'teamem-multi-profile-'));
    const homeDir = join(tempRoot, 'home');
    const teamemRoot = join(tempRoot, 'teamem');
    const demoWorkspaceLaunchCwd = join(tempRoot, 'demo-workspace');
    await Promise.all([
      writeProfileCredentials(homeDir, 'alice'),
      writeProfileCredentials(homeDir, 'bob'),
      mkdir(teamemRoot, { recursive: true }),
      mkdir(demoWorkspaceLaunchCwd, { recursive: true })
    ]);
    const invocations: Parameters<MultiProfileCommandRunner>[0][] = [];
    const runner: MultiProfileCommandRunner = (input) => {
      invocations.push(input);
      return {
        status: 0,
        stdout: `Selected dev profile: ${input.args[input.args.indexOf('--profile') + 1]}\ndry-run: Claude Code will not be launched\n`,
        stderr: ''
      };
    };

    try {
      const plan = await planTeamemDevClaudeMultiProfileRun({
        runId: 'run-11',
        personas: [
          { persona: 'alice', profileName: 'alice', ownership: 'developer' },
          { persona: 'bob', profileName: 'bob', ownership: 'developer' }
        ],
        teamemRoot,
        workspace: workspace({ teamemRoot, demoWorkspaceLaunchCwd }),
        homeDir,
        artifactsParentDir: tempRoot,
        commandRunner: runner,
        env: {
          TEAMEM_CREDENTIALS: '/must/not/be/used/as/global-impersonation.json'
        }
      });

      expect(invocations).toHaveLength(2);
      expect(invocations.map((call) => call.args.join(' '))).toEqual([
        expect.stringContaining(
          `dev claude --dry-run --profile alice --teamem-root ${teamemRoot} --cwd ${demoWorkspaceLaunchCwd}`
        ),
        expect.stringContaining(
          `dev claude --dry-run --profile bob --teamem-root ${teamemRoot} --cwd ${demoWorkspaceLaunchCwd}`
        )
      ]);
      for (const call of invocations) {
        expect(call.env.HOME).toBe(homeDir);
        expect(call.env.USERPROFILE).toBe(homeDir);
      }
      expect(plan.personaPlans.map((persona) => persona.persona)).toEqual([
        'alice',
        'bob'
      ]);
      for (const personaPlan of plan.personaPlans) {
        expect(personaPlan.artifactDir).toBe(
          join(plan.artifactsDir, personaPlan.persona)
        );
        expect(existsSync(personaPlan.launcherPlanPath)).toBe(true);
        expect(existsSync(personaPlan.mcpTraceDir)).toBe(true);
        expect(existsSync(personaPlan.hookTraceDir)).toBe(true);
        expect(existsSync(personaPlan.transcriptDir)).toBe(true);
        expect(existsSync(personaPlan.runtimeEvidenceDir)).toBe(true);
        expect(personaPlan.profile.credentialsPath).toContain(
          `dev-profiles/${personaPlan.profile.profileName}/credentials.json`
        );
        expect(personaPlan.profile.credentialsPath).not.toBe(
          plan.globalCredentialsPath
        );
        const launcherPlan = await readFile(
          personaPlan.launcherPlanPath,
          'utf8'
        );
        expect(launcherPlan).toContain('dev claude --dry-run');
        expect(launcherPlan).toContain(
          'dry-run: Claude Code will not be launched'
        );
      }

      const evidence = formatMultiProfileRunEvidence(plan);
      expect(evidence).toMatchObject({
        runId: 'run-11',
        teamemRoot,
        demoWorkspaceLaunchCwd
      });
      expect(JSON.stringify(evidence)).toContain('launcherPlanPath');
      expect(JSON.stringify(evidence)).toContain('runtimeEvidenceDir');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('fails before invoking Claude planning when developer-owned profile credentials are missing', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'teamem-multi-profile-'));
    let invocationCount = 0;

    try {
      await expect(
        planTeamemDevClaudeMultiProfileRun({
          runId: 'missing-creds',
          personas: [
            {
              persona: 'alice',
              profileName: 'alice',
              ownership: 'developer'
            }
          ],
          teamemRoot: join(tempRoot, 'teamem'),
          workspace: workspace({
            teamemRoot: join(tempRoot, 'teamem'),
            demoWorkspaceLaunchCwd: join(tempRoot, 'demo-workspace')
          }),
          homeDir: join(tempRoot, 'home'),
          artifactsParentDir: tempRoot,
          commandRunner: () => {
            invocationCount += 1;
            return { status: 0, stdout: '', stderr: '' };
          }
        })
      ).rejects.toThrow(
        /Missing developer-owned Teamem dev profile credentials/
      );
      expect(invocationCount).toBe(0);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('allows explicitly test-owned setup and cleans success state while preserving failure evidence', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'teamem-multi-profile-'));
    const runner: MultiProfileCommandRunner = () => ({
      status: 0,
      stdout: 'dry-run: profile-scoped Teamem setup would run\n',
      stderr: ''
    });

    try {
      const successPlan = await planTeamemDevClaudeMultiProfileRun({
        runId: 'test-owned-success',
        personas: [
          { persona: 'alice', profileName: 'alice', ownership: 'test' }
        ],
        teamemRoot: join(tempRoot, 'teamem'),
        workspace: workspace({
          teamemRoot: join(tempRoot, 'teamem'),
          demoWorkspaceLaunchCwd: join(tempRoot, 'demo-workspace')
        }),
        homeDir: join(tempRoot, 'home'),
        artifactsParentDir: tempRoot,
        allowTestOwnedSetup: true,
        commandRunner: runner
      });
      expect(successPlan.personaPlans[0]?.setupOwnedByTest).toBe(true);
      const successCleanup = await finishMultiProfileRun(successPlan, {
        success: true
      });
      expect(successCleanup.preserved).toBe(false);
      expect(existsSync(successPlan.artifactsDir)).toBe(false);
      expect(
        existsSync(successPlan.personaPlans[0]?.profile.profileRoot ?? '')
      ).toBe(false);

      const failurePlan = await planTeamemDevClaudeMultiProfileRun({
        runId: 'test-owned-failure',
        personas: [{ persona: 'bob', profileName: 'bob', ownership: 'test' }],
        teamemRoot: join(tempRoot, 'teamem'),
        workspace: workspace({
          teamemRoot: join(tempRoot, 'teamem'),
          demoWorkspaceLaunchCwd: join(tempRoot, 'demo-workspace')
        }),
        homeDir: join(tempRoot, 'home'),
        artifactsParentDir: tempRoot,
        allowTestOwnedSetup: true,
        commandRunner: runner
      });
      const failureCleanup = await finishMultiProfileRun(failurePlan, {
        success: false
      });
      expect(failureCleanup.preserved).toBe(true);
      expect(existsSync(failurePlan.artifactsDir)).toBe(true);
      expect(
        existsSync(join(failurePlan.artifactsDir, 'failure-evidence.json'))
      ).toBe(true);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

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
