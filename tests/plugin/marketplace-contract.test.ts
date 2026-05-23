import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
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
    expect(pluginManifest.commands).not.toContain(
      './commands/teamem-claims.md'
    );
    expect(pluginManifest.commands).not.toContain(
      './commands/teamem-force-release.md'
    );
    expect(pluginManifest.agents).toEqual(['./agents/teamem-briefer.md']);
    expect(marketplace.mcpServers).toBeUndefined();
  });
});
