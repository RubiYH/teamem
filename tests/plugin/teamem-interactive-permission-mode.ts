import type { ClaudePermissionMode } from '../../plugin-e2e-module/src/index.js';

export const TEAMEM_INTERACTIVE_PERMISSION_MODE_ENV =
  'TEAMEM_CLAUDE_PLUGIN_INTERACTIVE_PERMISSION_MODE';
export const DEFAULT_TEAMEM_INTERACTIVE_PERMISSION_MODE = 'auto';
export const SUPPORTED_TEAMEM_INTERACTIVE_PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'plan',
  'auto',
  'dontAsk',
  'bypassPermissions'
] as const satisfies readonly ClaudePermissionMode[];

export function resolveTeamemInteractivePermissionMode(
  env: NodeJS.ProcessEnv = process.env
): ClaudePermissionMode {
  const rawMode = env[TEAMEM_INTERACTIVE_PERMISSION_MODE_ENV]?.trim();

  if (!rawMode) {
    return DEFAULT_TEAMEM_INTERACTIVE_PERMISSION_MODE;
  }

  if (isSupportedTeamemInteractivePermissionMode(rawMode)) {
    return rawMode;
  }

  throw new Error(
    `Invalid ${TEAMEM_INTERACTIVE_PERMISSION_MODE_ENV} value "${rawMode}". Supported values: ${SUPPORTED_TEAMEM_INTERACTIVE_PERMISSION_MODES.join(
      ', '
    )}.`
  );
}

function isSupportedTeamemInteractivePermissionMode(
  value: string
): value is ClaudePermissionMode {
  return SUPPORTED_TEAMEM_INTERACTIVE_PERMISSION_MODES.includes(
    value as ClaudePermissionMode
  );
}
