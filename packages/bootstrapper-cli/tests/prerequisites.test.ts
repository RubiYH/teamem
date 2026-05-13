import { describe, expect, it } from 'bun:test';

import {
  detectPrerequisites,
  renderPrerequisiteReport,
  type CommandProbeResult,
  type CommandRunner
} from '../src/prerequisites.js';

describe('detectPrerequisites', () => {
  it('reports a clean supported environment inside a git repository', () => {
    const report = detectPrerequisites({
      platform: 'darwin',
      cwd: '/repo',
      commandRunner: createFakeRunner({
        'claude --version': ok('1.0.0'),
        'bun --version': ok('1.2.0'),
        'git --version': ok('git version 2.47.0'),
        'git rev-parse --is-inside-work-tree': ok('true')
      })
    });

    expect(report.hasErrors).toBe(false);
    expect(report.hasWarnings).toBe(false);
    expect(report.diagnostics.map((diagnostic) => diagnostic.severity)).toEqual(
      ['ok', 'ok', 'ok', 'ok', 'ok']
    );
  });

  it('reports missing Claude Code and Bun without attempting installation', () => {
    const report = detectPrerequisites({
      platform: 'linux',
      cwd: '/repo',
      commandRunner: createFakeRunner({
        'claude --version': missing(),
        'bun --version': missing(),
        'git --version': ok('git version 2.47.0'),
        'git rev-parse --is-inside-work-tree': ok('true')
      })
    });

    expect(report.hasErrors).toBe(true);
    expect(report.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'claude',
          severity: 'error',
          nextStep: expect.stringContaining('Install Claude Code')
        }),
        expect.objectContaining({
          id: 'bun',
          severity: 'error',
          nextStep: expect.stringContaining('Install Bun')
        })
      ])
    );

    const rendered = renderPrerequisiteReport(report, { dryRun: false });
    expect(rendered).toContain(
      'Teamem did not attempt any marketplace install or setup actions.'
    );
  });

  it('warns when Git is missing and skips repository detection', () => {
    const report = detectPrerequisites({
      platform: 'linux',
      cwd: '/workspace',
      commandRunner: createFakeRunner({
        'claude --version': ok('1.0.0'),
        'bun --version': ok('1.2.0'),
        'git --version': missing()
      })
    });

    expect(report.hasErrors).toBe(false);
    expect(report.hasWarnings).toBe(true);
    expect(report.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'git',
          severity: 'warning',
          summary: expect.stringContaining('not available on PATH')
        }),
        expect.objectContaining({
          id: 'git-repository',
          severity: 'warning',
          summary: expect.stringContaining(
            'could not be checked because Git is unavailable'
          )
        })
      ])
    );
  });

  it('warns when the current directory is outside a git repository', () => {
    const report = detectPrerequisites({
      platform: 'linux',
      cwd: '/tmp/not-a-repo',
      commandRunner: createFakeRunner({
        'claude --version': ok('1.0.0'),
        'bun --version': ok('1.2.0'),
        'git --version': ok('git version 2.47.0'),
        'git rev-parse --is-inside-work-tree': fail('')
      })
    });

    expect(report.hasErrors).toBe(false);
    expect(report.hasWarnings).toBe(true);
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({
        id: 'git-repository',
        severity: 'warning',
        details: '/tmp/not-a-repo'
      })
    );
  });

  it('fails clearly on Windows and warns on other unverified platforms', () => {
    const windows = detectPrerequisites({
      platform: 'win32',
      cwd: 'C:\\repo',
      commandRunner: createFakeRunner({
        'claude --version': ok('1.0.0'),
        'bun --version': ok('1.2.0'),
        'git --version': ok('git version 2.47.0'),
        'git rev-parse --is-inside-work-tree': ok('true')
      })
    });
    const freebsd = detectPrerequisites({
      platform: 'freebsd',
      cwd: '/repo',
      commandRunner: createFakeRunner({
        'claude --version': ok('1.0.0'),
        'bun --version': ok('1.2.0'),
        'git --version': ok('git version 2.47.0'),
        'git rev-parse --is-inside-work-tree': ok('true')
      })
    });

    expect(windows.hasErrors).toBe(true);
    expect(windows.diagnostics[0]).toEqual(
      expect.objectContaining({
        id: 'platform',
        severity: 'error'
      })
    );
    expect(freebsd.hasErrors).toBe(false);
    expect(freebsd.hasWarnings).toBe(true);
    expect(freebsd.diagnostics[0]).toEqual(
      expect.objectContaining({
        id: 'platform',
        severity: 'warning',
        summary: expect.stringContaining('unverified')
      })
    );
  });
});

function createFakeRunner(
  table: Record<string, CommandProbeResult>
): CommandRunner {
  return {
    run(command: string, args: readonly string[]): CommandProbeResult {
      const key = [command, ...args].join(' ');
      const result = table[key];
      if (result) {
        return result;
      }
      throw new Error(`Unexpected command probe: ${key}`);
    }
  };
}

function ok(stdout: string): CommandProbeResult {
  return {
    exitCode: 0,
    stdout,
    stderr: ''
  };
}

function fail(stderr: string): CommandProbeResult {
  return {
    exitCode: 1,
    stdout: '',
    stderr
  };
}

function missing(): CommandProbeResult {
  return {
    exitCode: null,
    stdout: '',
    stderr: '',
    errorCode: 'ENOENT'
  };
}
