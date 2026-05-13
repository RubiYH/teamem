import { describe, expect, it } from 'bun:test';

import { createInteractiveCcUpdatePrompter } from '../src/cc-launcher.js';
import { createInteractiveScopePrompter } from '../src/scope-prompt.js';
import type { PrerequisiteReport } from '../src/prerequisites.js';

describe('runtime-backed prompts', () => {
  it('uses runtime prompt for the cc update decision', () => {
    const prompter = createInteractiveCcUpdatePrompter(
      { stdout: { write() {} }, stderr: { write() {} } },
      {
        isInteractive: () => true,
        prompt: (message) => {
          expect(message).toBe(
            'Update Teamem before launching Claude Code? [Y/n]: '
          );
          return 'n';
        }
      }
    );

    expect(prompter()).toBe(false);
  });

  it('uses runtime prompt for scope selection', () => {
    const writes: string[] = [];
    const prompter = createInteractiveScopePrompter(
      {
        stdout: { write: (text) => writes.push(text) },
        stderr: { write() {} }
      },
      {
        isInteractive: () => true,
        prompt: (message) => {
          expect(message).toBe('Choose 1-3 or press Enter for project: ');
          return '3';
        }
      }
    );

    expect(
      prompter({
        recommended: { scope: 'project', source: 'default' },
        report: cleanPrerequisiteReport()
      })
    ).toBe('local');
    expect(writes.join('')).toContain('Select Claude Code plugin scope:');
  });

  it('returns defaults without prompting outside an interactive terminal', () => {
    const updatePrompter = createInteractiveCcUpdatePrompter(
      { stdout: { write() {} }, stderr: { write() {} } },
      {
        isInteractive: () => false,
        prompt: () => {
          throw new Error('should not prompt');
        }
      }
    );
    const scopePrompter = createInteractiveScopePrompter(
      { stdout: { write() {} }, stderr: { write() {} } },
      {
        isInteractive: () => false,
        prompt: () => {
          throw new Error('should not prompt');
        }
      }
    );

    expect(updatePrompter()).toBe(true);
    expect(
      scopePrompter({
        recommended: { scope: 'user', source: 'default' },
        report: cleanPrerequisiteReport()
      })
    ).toBe('user');
  });
});

function cleanPrerequisiteReport(): PrerequisiteReport {
  return {
    hasErrors: false,
    hasWarnings: false,
    diagnostics: [
      {
        id: 'git-repository',
        label: 'Git repository',
        severity: 'ok',
        summary: 'Current directory is inside a git repository.'
      }
    ]
  };
}
