import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_TEAMEM_INTERACTIVE_PERMISSION_MODE,
  SUPPORTED_TEAMEM_INTERACTIVE_PERMISSION_MODES,
  TEAMEM_INTERACTIVE_PERMISSION_MODE_ENV,
  resolveTeamemInteractivePermissionMode
} from './teamem-interactive-permission-mode.js';

describe('Teamem interactive live smoke permission mode', () => {
  it('defaults to auto when no override is set', () => {
    expect(resolveTeamemInteractivePermissionMode({})).toBe(
      DEFAULT_TEAMEM_INTERACTIVE_PERMISSION_MODE
    );
  });

  it('accepts every supported Claude Code permission mode override', () => {
    for (const mode of SUPPORTED_TEAMEM_INTERACTIVE_PERMISSION_MODES) {
      expect(
        resolveTeamemInteractivePermissionMode({
          [TEAMEM_INTERACTIVE_PERMISSION_MODE_ENV]: mode
        })
      ).toBe(mode);
    }
  });

  it('fails fast with an actionable error for unsupported overrides', () => {
    expect(() =>
      resolveTeamemInteractivePermissionMode({
        [TEAMEM_INTERACTIVE_PERMISSION_MODE_ENV]: 'askEveryTime'
      })
    ).toThrow(
      `Invalid ${TEAMEM_INTERACTIVE_PERMISSION_MODE_ENV} value "askEveryTime". Supported values: default, acceptEdits, plan, auto, dontAsk, bypassPermissions.`
    );
  });
});
