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

  it('returns launcher planning for cc', () => {
    const plan = buildActionPlan({
      command: 'cc',
      claudeArgs: ['--print', 'hello']
    });

    expect(plan.actions.map((action) => action.kind)).toEqual([
      'check-for-updates',
      'launch-claude'
    ]);
    expect(plan.actions[1]?.externalCommand?.args).toEqual([
      '--dangerously-load-development-channels',
      'plugin:teamem@teamem-alpha',
      '--print',
      'hello'
    ]);
  });

  it('can render cc planning without the update check', () => {
    const plan = buildActionPlan({
      command: 'cc',
      includeUpdateCheck: false
    });

    expect(plan.actions.map((action) => action.kind)).toEqual([
      'launch-claude'
    ]);
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
});
