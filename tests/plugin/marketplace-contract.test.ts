import { describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dir, '../..');

describe('teamem alpha marketplace contract', () => {
  it('publishes teamem from the root marketplace and mirrors the plugin version', () => {
    const marketplace = JSON.parse(
      readFileSync(join(REPO_ROOT, '.claude-plugin/marketplace.json'), 'utf8')
    );
    const pluginManifest = JSON.parse(
      readFileSync(join(REPO_ROOT, 'plugin/.claude-plugin/plugin.json'), 'utf8')
    );

    expect(marketplace.name).toBe('teamem-alpha');

    const pluginEntry = marketplace.plugins?.find(
      (plugin: { name?: string }) => plugin.name === 'teamem'
    );
    expect(pluginEntry).toBeDefined();
    expect(pluginEntry.source).toBe('./plugin');
    expect(pluginEntry.version).toBe(pluginManifest.version);
    expect(marketplace.version).toBe(pluginManifest.version);

    // The plugin manifest remains the MCP authority; the marketplace file only
    // points Claude Code at the existing plugin bundle.
    expect(pluginManifest.mcpServers).toBe('./.mcp.json');
    expect(pluginManifest.commands).not.toContain('./commands/claims.md');
    expect(pluginManifest.commands).not.toContain(
      './commands/force-release.md'
    );
    expect(pluginManifest.agents).toEqual(['./agents/teamem-briefer.md']);
    expect(marketplace.mcpServers).toBeUndefined();
  });

  it('maps every command file without repeating the plugin namespace', () => {
    const pluginManifest = JSON.parse(
      readFileSync(join(REPO_ROOT, 'plugin/.claude-plugin/plugin.json'), 'utf8')
    ) as { name: string; commands: string[] };
    const commandFiles = readdirSync(join(REPO_ROOT, 'plugin/commands'))
      .filter((file) => file.endsWith('.md'))
      .sort();

    expect([...pluginManifest.commands].sort()).toEqual(
      commandFiles.map((file) => `./commands/${file}`)
    );
    expect(
      commandFiles.some((file) => file.startsWith(`${pluginManifest.name}-`))
    ).toBe(false);
  });

  it('keeps live smoke command references aligned with short inventory names', () => {
    const smokeFiles = readdirSync(join(REPO_ROOT, 'tests/plugin')).filter(
      (file) =>
        file.endsWith('-smoke.test.ts') ||
        file === 'teamem-channels-evidence.test.ts'
    );
    const staleReferences = smokeFiles.flatMap((file) => {
      const source = readFileSync(
        join(REPO_ROOT, 'tests/plugin', file),
        'utf8'
      );
      return [
        source.match(/slashCommandPrompt\(\s*['"]teamem-/u)
          ? `${file}: slashCommandPrompt`
          : null,
        source.includes('Skill(teamem:teamem-') ? `${file}: Skill` : null,
        source.includes('/teamem:teamem-') ? `${file}: invocation` : null
      ].filter((reference): reference is string => reference !== null);
    });

    expect(staleReferences).toEqual([]);
  });
});
