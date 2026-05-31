import { ClaudeBinaryError } from './errors.js';
import type {
  ClaudeCommand,
  ClaudePluginTesterOptions,
  NormalizedClaudeCommand
} from './types.js';

export const DEFAULT_CLAUDE_BIN = 'claude';

export function normalizeClaudeCommand(
  options: Pick<ClaudePluginTesterOptions, 'claudeBin' | 'claudeCommand'>
): NormalizedClaudeCommand {
  if (options.claudeCommand && options.claudeBin) {
    throw new ClaudeBinaryError(
      'Pass either claudeCommand or claudeBin, not both.'
    );
  }

  if (options.claudeCommand) {
    return normalizeStructuredCommand(options.claudeCommand);
  }

  return {
    command: options.claudeBin ?? DEFAULT_CLAUDE_BIN,
    args: []
  };
}

function normalizeStructuredCommand(
  claudeCommand: ClaudeCommand
): NormalizedClaudeCommand {
  if (!claudeCommand.command.trim()) {
    throw new ClaudeBinaryError('claudeCommand.command must not be empty.');
  }

  return {
    command: claudeCommand.command,
    args: [...(claudeCommand.args ?? [])]
  };
}

export function withClaudeArgs(
  claudeCommand: NormalizedClaudeCommand,
  args: string[]
): NormalizedClaudeCommand {
  return {
    command: claudeCommand.command,
    args: [...claudeCommand.args, ...args]
  };
}
