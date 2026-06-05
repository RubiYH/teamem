import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';

export const DEFAULT_DEMO_INITIAL_BRANCH = 'main';
export const DEFAULT_DEMO_FEATURE_BRANCHES = [
  'feature/briefing-targets',
  'handoff/demo-history'
] as const;

export type DemoRepositoryWorkspace = {
  teamemSourceRoot: string;
  templateRoot: string;
  demoWorkspaceLaunchCwd: string;
  initialBranch: string;
  featureBranches: string[];
  helperCreatedMarkerToken?: string;
};

export type DemoRepositoryCleanupResult = {
  preserved: boolean;
  demoWorkspaceLaunchCwd: string;
  artifactPath?: string;
};

export type CreateDemoRepositoryWorkspaceOptions = {
  teamemSourceRoot?: string;
  tempParentDir?: string;
  initialBranch?: string;
  featureBranches?: string[];
};

export type FinishDemoRepositoryWorkspaceOptions = {
  success: boolean;
  artifactsDir?: string;
};

const DETERMINISTIC_GIT_ENV = {
  GIT_AUTHOR_NAME: 'Teamem Smoke Fixture',
  GIT_AUTHOR_EMAIL: 'teamem-smoke-fixture@example.com',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
  GIT_COMMITTER_NAME: 'Teamem Smoke Fixture',
  GIT_COMMITTER_EMAIL: 'teamem-smoke-fixture@example.com',
  GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z'
} as const;

const ISOLATED_GIT_ENV = {
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_SYSTEM: devNull
} as const;

const DETERMINISTIC_GIT_CONFIG_ARGS = [
  '-c',
  'commit.gpgsign=false',
  '-c',
  'tag.gpgSign=false',
  '-c',
  `core.hooksPath=${devNull}`
] as const;

const GIT_ENV_ALLOWLIST = new Set([
  'PATH',
  'HOME',
  'TMPDIR',
  'TEMP',
  'TMP',
  'SystemRoot',
  'WINDIR',
  'USERPROFILE',
  'LOCALAPPDATA'
]);

const DEMO_WORKSPACE_BASENAME_PREFIX = 'teamem-demo-workspace-';
const DEMO_WORKSPACE_HELPER_MARKER_FILE = 'teamem-demo-workspace.json';
const DEMO_WORKSPACE_HELPER_MARKER_CREATED_BY =
  'tests/plugin/teamem-demo-repository-workspace';

export async function createDemoRepositoryWorkspace(
  options: CreateDemoRepositoryWorkspaceOptions = {}
): Promise<DemoRepositoryWorkspace> {
  const teamemSourceRoot = resolve(options.teamemSourceRoot ?? process.cwd());
  const templateRoot = demoRepositoryTemplateRoot(teamemSourceRoot);
  const tempParentDir = options.tempParentDir ?? tmpdir();
  const demoWorkspaceLaunchCwd = await mkdtemp(
    join(tempParentDir, 'teamem-demo-workspace-')
  );
  const initialBranch = options.initialBranch ?? DEFAULT_DEMO_INITIAL_BRANCH;
  const featureBranches = [
    ...(options.featureBranches ?? DEFAULT_DEMO_FEATURE_BRANCHES)
  ];
  const helperCreatedMarkerToken = randomUUID();

  await cp(templateRoot, demoWorkspaceLaunchCwd, {
    recursive: true,
    errorOnExist: false
  });
  const gitTemplateDir = await mkdtemp(
    join(tempParentDir, 'teamem-empty-git-template-')
  );

  try {
    initializeGitHistory({
      cwd: demoWorkspaceLaunchCwd,
      gitTemplateDir,
      initialBranch,
      featureBranches
    });
    await writeDemoWorkspaceHelperMarker({
      teamemSourceRoot,
      templateRoot,
      demoWorkspaceLaunchCwd,
      helperCreatedMarkerToken
    });
  } finally {
    await rm(gitTemplateDir, { recursive: true, force: true });
  }

  return {
    teamemSourceRoot,
    templateRoot,
    demoWorkspaceLaunchCwd,
    initialBranch,
    featureBranches,
    helperCreatedMarkerToken
  };
}

export async function finishDemoRepositoryWorkspace(
  workspace: DemoRepositoryWorkspace,
  options: FinishDemoRepositoryWorkspaceOptions
): Promise<DemoRepositoryCleanupResult> {
  if (options.success) {
    await assertSafeDemoWorkspaceDeletion(workspace);
    await rm(workspace.demoWorkspaceLaunchCwd, {
      recursive: true,
      force: true
    });

    return {
      preserved: false,
      demoWorkspaceLaunchCwd: workspace.demoWorkspaceLaunchCwd
    };
  }

  const result: DemoRepositoryCleanupResult = {
    preserved: true,
    demoWorkspaceLaunchCwd: workspace.demoWorkspaceLaunchCwd
  };

  if (options.artifactsDir) {
    await mkdir(options.artifactsDir, { recursive: true });
    const artifactPath = join(
      options.artifactsDir,
      `${basename(workspace.demoWorkspaceLaunchCwd)}.json`
    );
    await writeFile(
      artifactPath,
      `${JSON.stringify(formatDemoWorkspaceReport(workspace), null, 2)}\n`
    );
    result.artifactPath = artifactPath;
  }

  return result;
}

export function formatDemoWorkspaceReport(
  workspace: DemoRepositoryWorkspace
): Record<string, unknown> {
  return {
    teamemSourceRoot: workspace.teamemSourceRoot,
    templateRoot: workspace.templateRoot,
    demoWorkspaceLaunchCwd: workspace.demoWorkspaceLaunchCwd,
    initialBranch: workspace.initialBranch,
    featureBranches: workspace.featureBranches
  };
}

function demoRepositoryTemplateRoot(teamemSourceRoot: string): string {
  return join(teamemSourceRoot, 'tests/fixtures/demo-repository-template');
}

async function assertSafeDemoWorkspaceDeletion(
  workspace: DemoRepositoryWorkspace
): Promise<void> {
  const teamemSourceRoot = resolve(workspace.teamemSourceRoot);
  const templateRoot = resolve(workspace.templateRoot);
  const demoWorkspaceLaunchCwd = resolve(workspace.demoWorkspaceLaunchCwd);
  const workspaceBasename = basename(demoWorkspaceLaunchCwd);
  const hasHelperCreatedBasename =
    workspaceBasename.startsWith(DEMO_WORKSPACE_BASENAME_PREFIX) &&
    workspaceBasename.length > DEMO_WORKSPACE_BASENAME_PREFIX.length;

  if (
    isPathAtOrInside(demoWorkspaceLaunchCwd, teamemSourceRoot) ||
    isPathAtOrInside(demoWorkspaceLaunchCwd, templateRoot) ||
    !hasHelperCreatedBasename
  ) {
    throw new Error(
      `Refusing to delete unsafe demo workspace: ${demoWorkspaceLaunchCwd}`
    );
  }

  if (
    !(await hasValidDemoWorkspaceHelperMarker({
      teamemSourceRoot,
      templateRoot,
      demoWorkspaceLaunchCwd,
      helperCreatedMarkerToken: workspace.helperCreatedMarkerToken
    }))
  ) {
    throw new Error(
      `Refusing to delete unsafe demo workspace: ${demoWorkspaceLaunchCwd}`
    );
  }
}

function isPathAtOrInside(candidate: string, parent: string): boolean {
  const relativePath = relative(parent, candidate);
  return (
    relativePath === '' ||
    (!relativePath.startsWith('..') && !isAbsolute(relativePath))
  );
}

async function writeDemoWorkspaceHelperMarker(input: {
  teamemSourceRoot: string;
  templateRoot: string;
  demoWorkspaceLaunchCwd: string;
  helperCreatedMarkerToken: string;
}): Promise<void> {
  await writeFile(
    demoWorkspaceHelperMarkerPath(input.demoWorkspaceLaunchCwd),
    `${JSON.stringify(
      {
        createdBy: DEMO_WORKSPACE_HELPER_MARKER_CREATED_BY,
        token: input.helperCreatedMarkerToken,
        teamemSourceRoot: resolve(input.teamemSourceRoot),
        templateRoot: resolve(input.templateRoot),
        demoWorkspaceLaunchCwd: resolve(input.demoWorkspaceLaunchCwd)
      },
      null,
      2
    )}\n`,
    { mode: 0o600 }
  );
}

async function hasValidDemoWorkspaceHelperMarker(input: {
  teamemSourceRoot: string;
  templateRoot: string;
  demoWorkspaceLaunchCwd: string;
  helperCreatedMarkerToken?: string;
}): Promise<boolean> {
  if (!input.helperCreatedMarkerToken) {
    return false;
  }

  try {
    const marker = JSON.parse(
      await readFile(
        demoWorkspaceHelperMarkerPath(input.demoWorkspaceLaunchCwd),
        'utf8'
      )
    ) as Record<string, unknown>;

    return (
      marker.createdBy === DEMO_WORKSPACE_HELPER_MARKER_CREATED_BY &&
      marker.token === input.helperCreatedMarkerToken &&
      marker.teamemSourceRoot === input.teamemSourceRoot &&
      marker.templateRoot === input.templateRoot &&
      marker.demoWorkspaceLaunchCwd === input.demoWorkspaceLaunchCwd
    );
  } catch {
    return false;
  }
}

function demoWorkspaceHelperMarkerPath(demoWorkspaceLaunchCwd: string): string {
  return join(
    demoWorkspaceLaunchCwd,
    '.git',
    DEMO_WORKSPACE_HELPER_MARKER_FILE
  );
}

function initializeGitHistory(input: {
  cwd: string;
  gitTemplateDir: string;
  initialBranch: string;
  featureBranches: string[];
}): void {
  git(input.cwd, [
    'init',
    '--template',
    input.gitTemplateDir,
    '--initial-branch',
    input.initialBranch
  ]);
  git(input.cwd, ['add', '.']);
  git(input.cwd, [
    'commit',
    '--no-gpg-sign',
    '--no-verify',
    '-m',
    'Initialize Teamem demo workspace'
  ]);

  for (const branch of input.featureBranches) {
    git(input.cwd, ['branch', branch]);
  }
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', [...DETERMINISTIC_GIT_CONFIG_ARGS, ...args], {
    cwd,
    encoding: 'utf8',
    env: deterministicGitEnv()
  });

  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed in ${cwd}: ${result.stderr || result.stdout}`
    );
  }

  return result.stdout.trim();
}

function deterministicGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && GIT_ENV_ALLOWLIST.has(key)) {
      env[key] = value;
    }
  }

  return {
    ...env,
    ...DETERMINISTIC_GIT_ENV,
    ...ISOLATED_GIT_ENV
  };
}
