import { describe, expect, it } from 'bun:test';

import {
  detectInstalledTeamemScopeFromJson,
  findInstalledTeamemPlugin,
  parseClaudePluginListJson
} from '../src/claude-plugin-list.js';

describe('parseClaudePluginListJson', () => {
  it('accepts top-level arrays and wrapped plugin objects', () => {
    expect(
      parseClaudePluginListJson(
        JSON.stringify([
          {
            id: 'teamem@teamem-alpha',
            scope: 'user',
            installPath: '/plugins/teamem-user'
          }
        ])
      )
    ).toEqual([
      {
        id: 'teamem@teamem-alpha',
        name: undefined,
        plugin: undefined,
        scope: 'user',
        installPath: '/plugins/teamem-user'
      }
    ]);

    expect(
      parseClaudePluginListJson(
        JSON.stringify({
          plugins: [
            {
              name: 'teamem',
              scope: 'local',
              installPath: '/plugins/teamem-local'
            }
          ]
        })
      )
    ).toEqual([
      {
        id: undefined,
        name: 'teamem',
        plugin: undefined,
        scope: 'local',
        installPath: '/plugins/teamem-local'
      }
    ]);
  });

  it('fails closed on malformed plugin-list JSON', () => {
    expect(parseClaudePluginListJson('{not json')).toEqual([]);
    expect(
      detectInstalledTeamemScopeFromJson('{not json', 'teamem@teamem-alpha')
    ).toBeUndefined();
    expect(
      findInstalledTeamemPlugin('{not json', 'teamem@teamem-alpha', 'project')
    ).toBeUndefined();
  });
});

describe('detectInstalledTeamemScopeFromJson', () => {
  it('preserves project -> user -> local precedence across a single plugin list', () => {
    const scope = detectInstalledTeamemScopeFromJson(
      JSON.stringify({
        plugins: [
          { id: 'teamem@teamem-alpha', scope: 'local' },
          { id: 'teamem@teamem-alpha', scope: 'user' },
          { id: 'teamem@teamem-alpha', scope: 'project' }
        ]
      }),
      'teamem@teamem-alpha'
    );

    expect(scope).toBe('project');
  });

  it('ignores ambiguous bare teamem names while detecting installed scope', () => {
    expect(
      detectInstalledTeamemScopeFromJson(
        JSON.stringify({
          plugins: [
            { name: 'teamem', scope: 'project' },
            { plugin: 'teamem', scope: 'user' }
          ]
        }),
        'teamem@teamem-alpha'
      )
    ).toBeUndefined();

    expect(
      detectInstalledTeamemScopeFromJson(
        JSON.stringify({
          plugins: [
            { name: 'teamem', scope: 'project' },
            { id: 'teamem@teamem-alpha', scope: 'user' }
          ]
        }),
        'teamem@teamem-alpha'
      )
    ).toBe('user');
  });

  it('ignores ambiguous bare teamem names without the pinned marketplace id', () => {
    const plugin = findInstalledTeamemPlugin(
      JSON.stringify({
        plugins: [
          {
            name: 'teamem',
            scope: 'project',
            installPath: '/plugins/ambiguous-teamem'
          },
          {
            id: 'teamem@teamem-alpha',
            scope: 'project',
            installPath: '/plugins/teamem-alpha'
          }
        ]
      }),
      'teamem@teamem-alpha',
      'project'
    );

    expect(plugin?.installPath).toBe('/plugins/teamem-alpha');
    expect(
      findInstalledTeamemPlugin(
        JSON.stringify({
          plugins: [
            {
              name: 'teamem',
              scope: 'project',
              installPath: '/plugins/ambiguous-teamem'
            }
          ]
        }),
        'teamem@teamem-alpha',
        'project'
      )
    ).toBeUndefined();
  });
});
