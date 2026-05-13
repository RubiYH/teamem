import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dir, '../..');
const PLUGIN_SRC = join(REPO_ROOT, 'plugin');

describe('plugin install flow simulation', () => {
  it('marketplace cache copy contains a runnable lib/bridge.js with no path-back-to-source', () => {
    const cache = mkdtempSync(join(tmpdir(), 'teamem-marketplace-'));
    try {
      // Simulate marketplace cache by recursively copying plugin/ into a fresh dir.
      cpSync(PLUGIN_SRC, cache, { recursive: true });

      const bridge = join(cache, 'lib/bridge.js');
      expect(existsSync(bridge)).toBe(true);

      const stat = readFileSync(bridge);
      // Sanity: bundle is non-trivial.
      expect(stat.length).toBeGreaterThan(10_000);

      // No reference to the source-tree teamem_root user_config substitution.
      const mcp = readFileSync(join(cache, '.mcp.json'), 'utf-8');
      expect(mcp).not.toContain('user_config.teamem_root');
      expect(mcp).toContain('${CLAUDE_PLUGIN_ROOT}/lib/bridge.js');

      // No reference to ${TEAMEM_ROOT}/hooks/lib/* in plugin scripts.
      for (const script of [
        'scripts/gate-claim.sh',
        'scripts/release-claims.sh'
      ]) {
        const text = readFileSync(join(cache, script), 'utf-8');
        expect(text).not.toContain('${TEAMEM_ROOT}/hooks/lib');
        expect(text).not.toContain('hooks/lib/gate-claim-scope.sh');
        expect(text).not.toContain('hooks/lib/release-claims.sh');
      }

      // The plugin manifest must not require teamem_root anymore.
      const manifest = JSON.parse(
        readFileSync(join(cache, '.claude-plugin/plugin.json'), 'utf-8')
      );
      expect(manifest.userConfig?.teamem_root).toBeUndefined();

      // Bundle is invokable: `bun run <bridge>` exits non-zero (no creds in
      // tmp), but its stderr surfaces the bridge's own startup message — not
      // a "module not found" or syntax error. We assert the runtime got past
      // load by checking for the bridge's own stderr signature.
      const result = spawnSync('bun', ['run', bridge, '--help'], {
        encoding: 'utf-8',
        env: { ...process.env, HOME: cache },
        timeout: 10_000
      });
      const stderr = result.stderr || '';
      // The bridge prints either a credentials hint or the startup line.
      // Both confirm the bundle parsed and ran.
      const bridgeRan =
        stderr.includes('No credentials found') ||
        stderr.includes('teamem-bridge') ||
        stderr.includes("Run 'bun run setup'");
      expect(bridgeRan).toBe(true);
    } finally {
      rmSync(cache, { recursive: true, force: true });
    }
  }, 30_000);
});
