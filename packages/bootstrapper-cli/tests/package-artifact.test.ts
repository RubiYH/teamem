import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const PACKAGE_ROOT = resolve(import.meta.dir, '..');
const PACKAGE_JSON_PATH = join(PACKAGE_ROOT, 'package.json');
const REQUIRED_PACKED_FILES = [
  'dist/bin/teamem.js',
  'dist/cli.js',
  'dist/prerequisites.js',
  'dist/plugin-installer.js',
  'dist/update-executor.js',
  'dist/cc-launcher.js',
  'dist/git-hooks.js'
] as const;

describe('package artifact', () => {
  it('only publishes the built CLI artifact set', () => {
    const packageJson = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf8')) as {
      bin?: Record<string, string>;
    };
    expect(packageJson.bin?.teamem).toBe('./dist/bin/teamem.js');
    expect(
      readFileSync(
        join(PACKAGE_ROOT, 'dist', 'bin', 'teamem.js'),
        'utf8'
      ).split('\n')[0]
    ).toBe('#!/usr/bin/env bun');

    const pack = runNpm(['pack', '--dry-run', '--json']);
    expect(pack.status).toBe(0);

    const [artifact] = JSON.parse(pack.stdout) as Array<{
      files: Array<{ path: string }>;
    }>;
    expect(artifact).toBeDefined();

    const packedFiles = artifact.files.map((entry) => entry.path).sort();
    expect(packedFiles).toEqual(
      expect.arrayContaining([...REQUIRED_PACKED_FILES])
    );
    expect(packedFiles.some((path) => path.startsWith('src/'))).toBe(false);
    expect(packedFiles.some((path) => path.startsWith('tests/'))).toBe(false);
    expect(
      packedFiles.some(
        (path) => path.endsWith('.ts') && !path.endsWith('.d.ts')
      )
    ).toBe(false);
  });

  it('installs the packed tarball into an isolated prefix with a working teamem binary', () => {
    const sandboxRoot = mkdtempSync(
      join(tmpdir(), 'teamem-bootstrapper-pack-')
    );
    const packDestination = join(sandboxRoot, 'pack');
    const installPrefix = join(sandboxRoot, 'prefix');

    try {
      mkdirSync(packDestination, { recursive: true });

      const pack = runNpm([
        'pack',
        '--json',
        '--pack-destination',
        packDestination
      ]);
      expect(pack.status).toBe(0);

      const [artifact] = JSON.parse(pack.stdout) as Array<{
        filename: string;
      }>;
      expect(artifact?.filename).toBeTruthy();

      const tarballPath = join(packDestination, artifact.filename);
      const install = runNpm([
        'install',
        '--global',
        '--prefix',
        installPrefix,
        tarballPath
      ]);
      expect(install.status).toBe(0);

      const binaryPath = join(installPrefix, 'bin', 'teamem');
      const help = spawnSync(binaryPath, ['--help'], {
        cwd: installPrefix,
        encoding: 'utf8'
      });

      expect(help.status).toBe(0);
      expect(help.stdout).toContain('Usage:');
      expect(help.stdout).toContain('teamem <command> [options]');
      expect(help.stderr).toBe('');
    } finally {
      rmSync(sandboxRoot, { recursive: true, force: true });
    }
  });
});

function runNpm(args: readonly string[]) {
  const cacheDir = mkdtempSync(
    join(tmpdir(), 'teamem-bootstrapper-npm-cache-')
  );

  try {
    return spawnSync('npm', [...args], {
      cwd: PACKAGE_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        npm_config_cache: cacheDir
      }
    });
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
}
