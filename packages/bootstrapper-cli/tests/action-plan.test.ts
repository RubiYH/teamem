import { describe, expect, it } from 'bun:test';

import { buildActionPlan } from '../src/action-plan.js';

describe('buildActionPlan', () => {
  it('returns init actions without executing anything', () => {
    const plan = buildActionPlan({
      command: 'init',
      dryRun: true,
      scope: 'project'
    });

    expect(plan.command).toBe('init');
    expect(plan.dryRun).toBe(true);
    expect(plan.actions.map((action) => action.kind)).toEqual([
      'diagnose-prerequisites',
      'ensure-marketplace',
      'install-plugin',
      'run-setup-flow'
    ]);
    expect(plan.actions[1]?.externalCommand).toEqual({
      command: 'claude',
      args: ['plugin', 'marketplace', 'add', '<teamem-alpha-source>']
    });
    expect(plan.actions[2]?.externalCommand).toEqual({
      command: 'claude',
      args: ['plugin', 'install', 'teamem@teamem-alpha', '--scope', 'project']
    });
    expect(plan.actions[3]?.externalCommand).toEqual({
      command: 'bun',
      args: ['run', '<installed-teamem-plugin>/lib/setup.js']
    });
  });

  it('returns migration planning for cc without a Claude launch command', () => {
    const plan = buildActionPlan({
      command: 'cc',
      claudeArgs: ['--print', 'hello']
    });

    expect(plan.actions.map((action) => action.kind)).toEqual([
      'report-cc-migration'
    ]);
    expect(plan.actions[0]?.description).toContain('teamem claude install');
    expect(plan.actions[0]?.description).toContain('claude');
    expect(plan.actions[0]?.externalCommand).toBeUndefined();
  });

  it('keeps cc migration planning stable when legacy update check is disabled', () => {
    const plan = buildActionPlan({
      command: 'cc',
      includeUpdateCheck: false
    });

    expect(plan.actions.map((action) => action.kind)).toEqual([
      'report-cc-migration'
    ]);
  });

  it('returns lifecycle action planning for the Teamem-aware Claude launcher', () => {
    const plan = buildActionPlan({ command: 'claude' });

    expect(plan.actions.map((action) => action.kind)).toEqual([
      'manage-claude-launcher'
    ]);
    expect(plan.actions[0]?.description).toContain(
      'Teamem-owned machine-local launcher state'
    );
    expect(plan.actions[0]?.description).toContain('--dry-run');
  });

  it('returns marketplace refresh plus plugin update for update', () => {
    const plan = buildActionPlan({ command: 'update' });

    expect(plan.actions.map((action) => action.kind)).toEqual([
      'ensure-marketplace',
      'install-plugin'
    ]);
    expect(plan.actions[1]?.externalCommand).toEqual({
      command: 'claude',
      args: ['plugin', 'update', 'teamem@teamem-alpha', '--scope', '<scope>']
    });
  });

  it('returns plugin removal plus local cleanup for uninstall', () => {
    const plan = buildActionPlan({ command: 'uninstall', scope: 'user' });

    expect(plan.actions.map((action) => action.kind)).toEqual([
      'uninstall-plugin',
      'remove-marketplace',
      'uninstall-git-hooks',
      'manage-claude-launcher',
      'clear-local-state'
    ]);
    expect(plan.actions[0]?.externalCommand).toEqual({
      command: 'claude',
      args: [
        'plugin',
        'uninstall',
        'teamem@teamem-alpha',
        '--scope',
        'user',
        '--prune',
        '-y'
      ]
    });
  });
});
