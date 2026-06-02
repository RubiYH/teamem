import type { ClaudeLaunchOptions, InstrumentedPlugin } from './types.js';

export const DEFAULT_CLAUDE_PERMISSION_MODE = 'auto';

export function buildClaudeLaunchOptionArgs(
  options: ClaudeLaunchOptions = {},
  instrumentedPlugin?: Pick<InstrumentedPlugin, 'mcpPath'>
): string[] {
  return [
    ...buildNonVariadicLaunchOptionArgs(options, instrumentedPlugin),
    ...buildToolOptionArgs(options)
  ];
}

export function buildHeadlessClaudeLaunchOptionArgs(
  options: ClaudeLaunchOptions = {},
  instrumentedPlugin: Pick<InstrumentedPlugin, 'mcpPath'>,
  maxTurns: number
): string[] {
  return [
    ...buildNonVariadicLaunchOptionArgs(options, instrumentedPlugin),
    '--max-turns',
    String(maxTurns),
    ...buildToolOptionArgs(options)
  ];
}

function buildNonVariadicLaunchOptionArgs(
  options: ClaudeLaunchOptions,
  instrumentedPlugin?: Pick<InstrumentedPlugin, 'mcpPath'>
): string[] {
  return [
    '--permission-mode',
    options.permissionMode ?? DEFAULT_CLAUDE_PERMISSION_MODE,
    ...buildMcpConfigArgs(options, instrumentedPlugin),
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

function buildToolOptionArgs(options: ClaudeLaunchOptions): string[] {
  return [
    ...appendRepeatedStringOption('--allowedTools', options.allowedTools),
    ...appendRepeatedStringOption('--disallowedTools', options.disallowedTools)
  ];
}

function buildMcpConfigArgs(
  options: ClaudeLaunchOptions,
  instrumentedPlugin?: Pick<InstrumentedPlugin, 'mcpPath'>
): string[] {
  const mcpConfigPath = options.useInstrumentedMcpConfig
    ? instrumentedPlugin?.mcpPath
    : options.mcpConfig;

  if (!mcpConfigPath) {
    return [];
  }

  return [
    '--mcp-config',
    mcpConfigPath,
    ...(options.strictMcpConfig ? ['--strict-mcp-config'] : [])
  ];
}

function appendRepeatedStringOption(flag: string, values?: string[]): string[] {
  return values?.flatMap((value) => [flag, value]) ?? [];
}

function appendStringOption(flag: string, value?: string): string[] {
  return value === undefined ? [] : [flag, value];
}
