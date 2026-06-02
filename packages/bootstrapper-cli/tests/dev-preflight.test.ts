import { describe, expect, it } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createNodeDevBundleFreshnessChecker,
  createNodeDevServerHealthChecker,
  readDevProfileServerUrl,
  renderDevBundleFreshness
} from '../src/dev-preflight.js';
import type { DevProfilePaths } from '../src/dev-profiles.js';
import type { DevSourceResolution } from '../src/dev-source.js';

describe('dev preflight', () => {
  it('reads the selected profile credentials server URL', () => {
    const result = readDevProfileServerUrl({
      profile: profilePaths(),
      credentialsReader: {
        read: () =>
          JSON.stringify({
            version: 1,
            default_space_id: 'space-2',
            spaces: {
              'space-1': { server_url: 'https://wrong.example' },
              'space-2': { server_url: 'https://teamem.example' }
            }
          })
      }
    });

    expect(result).toEqual({
      ok: true,
      serverUrl: 'https://teamem.example'
    });
  });

  it('passes the checked health URL into the Bun probe', () => {
    const result =
      createNodeDevServerHealthChecker().check('http://127.0.0.1:9');

    expect(result.ok).toBe(false);
    expect(result.checkedUrl).toBe('http://127.0.0.1:9/health');
    if (result.ok) {
      throw new Error('expected health probe to fail against closed port');
    }
    expect(result.message).not.toContain('blank string');
  });

  it('byte-compares committed plugin bundles against fresh bun build output', () => {
    const root = mkdtempSync(join(tmpdir(), 'teamem-preflight-'));
    try {
      writeBundleSource(root, 'src/bridge/index.ts', 'bridge');
      writeBundleSource(root, 'src/cli/setup.ts', 'setup');
      writeBundleSource(root, 'src/channel/index.ts', 'channel');
      mkdirSync(join(root, 'plugin/lib'), { recursive: true });

      const checker = createNodeDevBundleFreshnessChecker();
      const source = sourceResolution(root);

      const first = checker.check(source);
      expect(first.ok).toBe(false);
      expect(first.bundles.map((bundle) => bundle.status)).toEqual([
        'missing',
        'missing',
        'missing'
      ]);

      for (const bundle of first.bundles) {
        writeFileSync(bundle.committedPath, 'stale\n', 'utf8');
      }
      const stale = checker.check(source);
      expect(stale.ok).toBe(false);
      expect(stale.bundles.map((bundle) => bundle.status)).toEqual([
        'stale',
        'stale',
        'stale'
      ]);

      for (const bundle of ['bridge', 'setup', 'channel'] as const) {
        const labelToPath = {
          bridge: ['src/bridge/index.ts', 'plugin/lib/bridge.js'],
          setup: ['src/cli/setup.ts', 'plugin/lib/setup.js'],
          channel: ['src/channel/index.ts', 'plugin/lib/channel.js']
        }[bundle];
        const tempOut = join(root, `${bundle}.fresh.js`);
        const result = Bun.spawnSync(
          [
            'bun',
            'build',
            labelToPath[0],
            '--outfile',
            tempOut,
            '--target',
            'bun',
            '--external',
            'bun:sqlite'
          ],
          {
            cwd: root
          }
        );
        expect(result.exitCode).toBe(0);
        writeFileSync(join(root, labelToPath[1]), readFileSync(tempOut));
      }

      const fresh = checker.check(source);
      expect(fresh.ok).toBe(true);
      expect(renderDevBundleFreshness(fresh)).toContain(
        'match source builds byte-for-byte'
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});

function writeBundleSource(root: string, path: string, label: string): void {
  const fullPath = join(root, path);
  mkdirSync(fullPath.slice(0, fullPath.lastIndexOf('/')), { recursive: true });
  writeFileSync(fullPath, `console.log(${JSON.stringify(label)});\n`, 'utf8');
}

function sourceResolution(root: string): DevSourceResolution {
  return {
    teamemRoot: root,
    pluginRoot: join(root, 'plugin'),
    launchCwd: root,
    source: 'flag'
  };
}

function profilePaths(): DevProfilePaths {
  return {
    profileName: 'alice',
    profilesRoot: '/tmp/home/.teamem/dev-profiles',
    profileRoot: '/tmp/home/.teamem/dev-profiles/alice',
    claudeConfigDir: '/tmp/home/.teamem/dev-profiles/alice/claude',
    pluginCacheDir: '/tmp/home/.teamem/dev-profiles/alice/claude/plugins',
    pluginDataDir: '/tmp/home/.teamem/dev-profiles/alice/plugin-data/teamem',
    credentialsPath: '/tmp/home/.teamem/dev-profiles/alice/credentials.json',
    mcpConfigPath: '/tmp/home/.teamem/dev-profiles/alice/mcp.json',
    metadataPath: '/tmp/home/.teamem/dev-profiles/alice/metadata.json',
    logsDir: '/tmp/home/.teamem/dev-profiles/alice/logs'
  };
}
