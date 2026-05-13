import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dir, '../..');

const BUNDLES = [
  {
    label: 'bridge',
    src: 'src/bridge/index.ts',
    committed: join(REPO_ROOT, 'plugin/lib/bridge.js'),
    outfile: 'bridge.js'
  },
  {
    label: 'setup',
    src: 'src/cli/setup.ts',
    committed: join(REPO_ROOT, 'plugin/lib/setup.js'),
    outfile: 'setup.js'
  },
  {
    label: 'channel',
    src: 'src/channel/index.ts',
    committed: join(REPO_ROOT, 'plugin/lib/channel.js'),
    outfile: 'channel.js'
  }
] as const;

describe('plugin bundle freshness (AC-18, Pre-mortem F3, Codex F7)', () => {
  for (const bundle of BUNDLES) {
    it(`build:plugin output for ${bundle.label} matches the committed plugin/lib/${bundle.outfile} byte-for-byte`, () => {
      const workdir = mkdtempSync(
        join(tmpdir(), `teamem-bundle-${bundle.label}-`)
      );
      const tmpOut = join(workdir, bundle.outfile);

      try {
        const result = spawnSync(
          'bun',
          [
            'build',
            bundle.src,
            '--outfile',
            tmpOut,
            '--target',
            'bun',
            '--external',
            'bun:sqlite'
          ],
          { cwd: REPO_ROOT, encoding: 'utf-8' }
        );
        expect(result.status).toBe(0);

        const fresh = readFileSync(tmpOut);
        const committed = readFileSync(bundle.committed);

        expect(fresh.length).toBe(committed.length);
        expect(fresh.equals(committed)).toBe(true);
      } finally {
        rmSync(workdir, { recursive: true, force: true });
      }
    }, 60_000);
  }
});
