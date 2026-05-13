import { spawnSync } from 'node:child_process';

export type DiagnosticSeverity = 'ok' | 'warning' | 'error';

export interface CommandProbeResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly errorCode?: string;
}

export interface CommandRunner {
  run(command: string, args: readonly string[]): CommandProbeResult;
}

export interface PrerequisiteEnvironment {
  readonly platform: NodeJS.Platform;
  readonly cwd: string;
  readonly commandRunner: CommandRunner;
}

export interface PrerequisiteDiagnostic {
  readonly id: 'platform' | 'claude' | 'bun' | 'git' | 'git-repository';
  readonly label: string;
  readonly severity: DiagnosticSeverity;
  readonly summary: string;
  readonly nextStep?: string;
  readonly details?: string;
}

export interface PrerequisiteReport {
  readonly diagnostics: readonly PrerequisiteDiagnostic[];
  readonly hasErrors: boolean;
  readonly hasWarnings: boolean;
}

export function createSystemCommandRunner(
  cwd: string = process.cwd()
): CommandRunner {
  return {
    run(command: string, args: readonly string[]): CommandProbeResult {
      const result = spawnSync(command, [...args], {
        cwd,
        encoding: 'utf8'
      });

      return {
        exitCode: result.status,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        errorCode:
          result.error && 'code' in result.error
            ? String(result.error.code)
            : undefined
      };
    }
  };
}

export function detectPrerequisites(
  environment: PrerequisiteEnvironment
): PrerequisiteReport {
  const diagnostics: PrerequisiteDiagnostic[] = [];

  diagnostics.push(diagnosePlatform(environment.platform));

  const claude = diagnoseCommand({
    id: 'claude',
    label: 'Claude Code',
    command: 'claude',
    args: ['--version'],
    missingSeverity: 'error',
    missingSummary: 'The `claude` command is not available on PATH.',
    missingNextStep:
      'Install Claude Code and make sure the `claude` command is available before rerunning `teamem init`.',
    failureSummary:
      'The `claude --version` probe failed, so Teamem cannot verify Claude Code availability.'
  });
  diagnostics.push(runCommandDiagnostic(environment.commandRunner, claude));

  const bun = diagnoseCommand({
    id: 'bun',
    label: 'Bun',
    command: 'bun',
    args: ['--version'],
    missingSeverity: 'error',
    missingSummary: 'The `bun` command is not available on PATH.',
    missingNextStep:
      'Install Bun and make sure the `bun` command is available before rerunning `teamem init`.',
    failureSummary:
      'The `bun --version` probe failed, so Teamem cannot verify the plugin runtime prerequisite.'
  });
  diagnostics.push(runCommandDiagnostic(environment.commandRunner, bun));

  const git = diagnoseCommand({
    id: 'git',
    label: 'Git',
    command: 'git',
    args: ['--version'],
    missingSeverity: 'warning',
    missingSummary: 'The `git` command is not available on PATH.',
    missingNextStep:
      'Install Git if you need repository-aware setup, project-scope workflows, or Teamem git hooks.',
    failureSummary:
      'The `git --version` probe failed, so Teamem cannot verify repository-aware features.'
  });
  const gitDiagnostic = runCommandDiagnostic(environment.commandRunner, git);
  diagnostics.push(gitDiagnostic);

  diagnostics.push(
    diagnoseGitRepository({
      cwd: environment.cwd,
      commandRunner: environment.commandRunner,
      gitAvailable: gitDiagnostic.severity === 'ok'
    })
  );

  return {
    diagnostics,
    hasErrors: diagnostics.some(
      (diagnostic) => diagnostic.severity === 'error'
    ),
    hasWarnings: diagnostics.some(
      (diagnostic) => diagnostic.severity === 'warning'
    )
  };
}

export function renderPrerequisiteReport(
  report: PrerequisiteReport,
  options: { dryRun: boolean }
): string {
  const lines = [
    'teamem init',
    options.dryRun
      ? 'dry-run: reporting prerequisite diagnostics only'
      : 'diagnostics-only: no install, setup, or launch actions were executed',
    ''
  ];

  for (const diagnostic of report.diagnostics) {
    lines.push(
      `${renderSeverity(diagnostic.severity)} ${diagnostic.label}: ${diagnostic.summary}`
    );
    if (diagnostic.details) {
      lines.push(`    details: ${diagnostic.details}`);
    }
    if (diagnostic.nextStep) {
      lines.push(`    next: ${diagnostic.nextStep}`);
    }
  }

  lines.push('');
  if (report.hasErrors) {
    lines.push(
      'Blocking issues were found. Teamem did not attempt any marketplace install or setup actions.'
    );
  } else {
    lines.push(
      'Prerequisite checks completed. Marketplace install/setup remains out of scope for this slice.'
    );
  }

  return `${lines.join('\n')}\n`;
}

function renderSeverity(severity: DiagnosticSeverity): string {
  switch (severity) {
    case 'ok':
      return '[ok]';
    case 'warning':
      return '[warning]';
    case 'error':
      return '[error]';
  }
}

function diagnosePlatform(platform: NodeJS.Platform): PrerequisiteDiagnostic {
  if (platform === 'darwin' || platform === 'linux') {
    return {
      id: 'platform',
      label: 'Platform',
      severity: 'ok',
      summary: `Platform \`${platform}\` is supported for this bootstrapper.`
    };
  }

  if (platform === 'win32') {
    return {
      id: 'platform',
      label: 'Platform',
      severity: 'error',
      summary:
        'Windows is not supported by this bootstrapper yet, so Teamem stopped before any partial setup.',
      nextStep:
        'Use a supported macOS or Linux environment before rerunning `teamem init`.'
    };
  }

  return {
    id: 'platform',
    label: 'Platform',
    severity: 'warning',
    summary: `Platform \`${platform}\` is unverified for this bootstrapper.`,
    nextStep:
      'Proceed cautiously on this platform; if setup matters, prefer a verified macOS or Linux environment.'
  };
}

function diagnoseGitRepository(options: {
  cwd: string;
  commandRunner: CommandRunner;
  gitAvailable: boolean;
}): PrerequisiteDiagnostic {
  if (!options.gitAvailable) {
    return {
      id: 'git-repository',
      label: 'Git repository',
      severity: 'warning',
      summary:
        'Repository context could not be checked because Git is unavailable.',
      nextStep:
        'Install Git first if you need Teamem to detect project-scope setup or git hook eligibility.'
    };
  }

  const probe = options.commandRunner.run('git', [
    'rev-parse',
    '--is-inside-work-tree'
  ]);
  if (probe.exitCode === 0 && probe.stdout.trim() === 'true') {
    return {
      id: 'git-repository',
      label: 'Git repository',
      severity: 'ok',
      summary: `Current directory is inside a git repository.`,
      details: options.cwd
    };
  }

  return {
    id: 'git-repository',
    label: 'Git repository',
    severity: 'warning',
    summary:
      'Current directory is not inside a git repository, so project-scope and git-hook setup are unavailable here.',
    details: options.cwd,
    nextStep:
      'Run `teamem init` inside a git repository if you need Teamem project scope or repository-local hooks.'
  };
}

function diagnoseCommand(options: {
  id: 'claude' | 'bun' | 'git';
  label: string;
  command: string;
  args: readonly string[];
  missingSeverity: Exclude<DiagnosticSeverity, 'ok'>;
  missingSummary: string;
  missingNextStep: string;
  failureSummary: string;
}): {
  readonly id: 'claude' | 'bun' | 'git';
  readonly label: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly missingSeverity: Exclude<DiagnosticSeverity, 'ok'>;
  readonly missingSummary: string;
  readonly missingNextStep: string;
  readonly failureSummary: string;
} {
  return options;
}

function runCommandDiagnostic(
  commandRunner: CommandRunner,
  command: ReturnType<typeof diagnoseCommand>
): PrerequisiteDiagnostic {
  const probe = commandRunner.run(command.command, command.args);
  if (probe.exitCode === 0) {
    return {
      id: command.id,
      label: command.label,
      severity: 'ok',
      summary: `Detected via \`${command.command} ${command.args.join(' ')}\`.`,
      details: probe.stdout.trim() || undefined
    };
  }

  if (probe.errorCode === 'ENOENT') {
    return {
      id: command.id,
      label: command.label,
      severity: command.missingSeverity,
      summary: command.missingSummary,
      nextStep: command.missingNextStep
    };
  }

  return {
    id: command.id,
    label: command.label,
    severity: command.missingSeverity,
    summary: command.failureSummary,
    details: [probe.stderr.trim(), probe.stdout.trim()]
      .filter((value) => value.length > 0)
      .join(' | '),
    nextStep: command.missingNextStep
  };
}
