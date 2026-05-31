import type { ClaudeLaunchOptions } from './types.js';

export const DEFAULT_CLAUDE_PERMISSION_MODE = 'auto';

export function buildClaudeLaunchOptionArgs(
  options: ClaudeLaunchOptions = {}
): string[] {
  return [
    '--permission-mode',
    options.permissionMode ?? DEFAULT_CLAUDE_PERMISSION_MODE,
    ...appendRepeatedStringOption('--allowedTools', options.allowedTools),
    ...appendRepeatedStringOption('--disallowedTools', options.disallowedTools),
    ...appendStringOption(
      '--setting-sources',
      Array.isArray(options.settingSources)
        ? options.settingSources.join(',')
        : options.settingSources
    ),
    ...appendStringOption('--system-prompt', options.systemPrompt),
    ...appendStringOption('--append-system-prompt', options.appendSystemPrompt),
    ...appendStringOption('--model', options.model),
    ...appendStringOption(
      '--max-budget-usd',
      options.maxBudgetUsd === undefined
        ? undefined
        : String(options.maxBudgetUsd)
    )
  ];
}

function appendRepeatedStringOption(flag: string, values?: string[]): string[] {
  return values?.flatMap((value) => [flag, value]) ?? [];
}

function appendStringOption(flag: string, value?: string): string[] {
  return value === undefined ? [] : [flag, value];
}
