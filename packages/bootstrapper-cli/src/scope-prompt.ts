import type { CliIo } from './cli.js';
import type { PrerequisiteReport } from './prerequisites.js';
import type { PluginScope, ScopeResolution } from './plugin-installer.js';
import {
  isInteractiveTerminal,
  promptWithRuntime,
  type RuntimePromptEnvironment
} from './runtime-prompt.js';

export interface ScopePromptContext {
  readonly recommended: ScopeResolution;
  readonly report: PrerequisiteReport;
}

export type ScopePrompter = (context: ScopePromptContext) => PluginScope;

export type ScopePromptEnvironment = RuntimePromptEnvironment;

const SCOPE_OPTIONS: ReadonlyArray<{
  readonly scope: PluginScope;
  readonly label: string;
  readonly description: string;
}> = [
  {
    scope: 'project',
    label: 'project',
    description: 'Attach Teamem to the current repository'
  },
  {
    scope: 'user',
    label: 'user',
    description: 'Use one Teamem plugin install across repositories'
  },
  {
    scope: 'local',
    label: 'local',
    description: 'Keep the install isolated for local development'
  }
];

export function createInteractiveScopePrompter(
  io: CliIo,
  environment: ScopePromptEnvironment = {}
): ScopePrompter {
  return ({ recommended, report }) => {
    if (!isInteractiveTerminal(environment)) {
      return recommended.scope;
    }

    const defaultProjectAllowed = report.diagnostics.some(
      (diagnostic) =>
        diagnostic.id === 'git-repository' && diagnostic.severity === 'ok'
    );

    while (true) {
      io.stdout.write('Select Claude Code plugin scope:\n');
      for (const [index, option] of SCOPE_OPTIONS.entries()) {
        const isDefault = option.scope === recommended.scope;
        const suffix =
          option.scope === 'project' && !defaultProjectAllowed
            ? ' (current directory is not a git repository)'
            : '';
        io.stdout.write(
          `  ${index + 1}. ${option.label}${isDefault ? ' [default]' : ''} - ${option.description}${suffix}\n`
        );
      }
      const answer =
        promptWithRuntime(
          `Choose 1-${SCOPE_OPTIONS.length} or press Enter for ${recommended.scope}: `,
          environment
        ) ?? '';
      const normalizedAnswer = answer.trim().toLowerCase();
      if (normalizedAnswer.length === 0) {
        return recommended.scope;
      }

      const numeric = Number(normalizedAnswer);
      if (
        Number.isInteger(numeric) &&
        numeric >= 1 &&
        numeric <= SCOPE_OPTIONS.length
      ) {
        return SCOPE_OPTIONS[numeric - 1]!.scope;
      }

      const named = SCOPE_OPTIONS.find(
        (option) => option.scope === normalizedAnswer
      );
      if (named) {
        return named.scope;
      }

      io.stdout.write(
        'Invalid scope. Enter project, user, local, or the matching number.\n'
      );
    }
  };
}
