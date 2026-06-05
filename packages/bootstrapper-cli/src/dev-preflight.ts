import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { DevProfilePaths } from './dev-profiles.js';
import type { DevSourceResolution } from './dev-source.js';

const BUNDLES = [
  {
    label: 'bridge',
    src: 'src/bridge/index.ts',
    committed: 'plugin/lib/bridge.js',
    outfile: 'bridge.js'
  },
  {
    label: 'setup',
    src: 'src/cli/setup.ts',
    committed: 'plugin/lib/setup.js',
    outfile: 'setup.js'
  },
  {
    label: 'channel',
    src: 'src/channel/index.ts',
    committed: 'plugin/lib/channel.js',
    outfile: 'channel.js'
  }
] as const;

export interface DevCredentialsReader {
  read(path: string): string | null;
}

export interface DevServerHealthChecker {
  check(url: string): DevServerHealthResult;
}

export type DevServerHealthResult =
  | {
      readonly ok: true;
      readonly checkedUrl: string;
    }
  | {
      readonly ok: false;
      readonly checkedUrl: string;
      readonly message: string;
    };

export interface DevBundleFreshnessChecker {
  check(source: DevSourceResolution): DevBundleFreshnessReport;
}

export interface DevPluginBuilder {
  build(source: DevSourceResolution): DevPluginBuildResult;
}

export interface DevBundleFreshnessReport {
  readonly ok: boolean;
  readonly bundles: readonly DevBundleFreshnessEntry[];
}

export interface DevBundleFreshnessEntry {
  readonly label: string;
  readonly committedPath: string;
  readonly status: 'fresh' | 'missing' | 'stale' | 'build-failed';
  readonly message?: string;
}

export type DevPluginBuildResult =
  | { readonly ok: true; readonly message: string }
  | { readonly ok: false; readonly message: string; readonly exitCode: number };

export type DevProfileServerUrlResult =
  | { readonly ok: true; readonly serverUrl: string }
  | { readonly ok: false; readonly message: string };

export type DevProfileDefaultSpaceResult =
  | { readonly ok: true; readonly defaultSpaceId: string }
  | { readonly ok: false; readonly message: string };

export function createNodeDevCredentialsReader(): DevCredentialsReader {
  return {
    read(path: string): string | null {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return null;
      }
    }
  };
}

export function createNodeDevServerHealthChecker(): DevServerHealthChecker {
  return {
    check(url: string): DevServerHealthResult {
      const checkedUrl = devServerHealthUrl(url);
      const result = spawnSync(
        'bun',
        [
          '-e',
          'const url = Bun.argv[1]; try { const res = await fetch(url); if (!res.ok) { console.error(`HTTP ${res.status}`); process.exit(1); } process.exit(0); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); }',
          checkedUrl
        ],
        { encoding: 'utf8' }
      );
      if (result.status === 0) {
        return { ok: true, checkedUrl };
      }
      return {
        ok: false,
        checkedUrl,
        message:
          result.stderr.trim() ||
          result.stdout.trim() ||
          result.error?.message ||
          'health probe failed'
      };
    }
  };
}

export function createNodeDevBundleFreshnessChecker(): DevBundleFreshnessChecker {
  return {
    check(source: DevSourceResolution): DevBundleFreshnessReport {
      const bundles: DevBundleFreshnessEntry[] = [];
      for (const bundle of BUNDLES) {
        const workdir = mkdtempSync(
          join(tmpdir(), `teamem-bundle-${bundle.label}-`)
        );
        const tmpOut = join(workdir, bundle.outfile);
        const committedPath = join(source.teamemRoot, bundle.committed);

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
            { cwd: source.teamemRoot, encoding: 'utf-8' }
          );
          if (result.status !== 0) {
            bundles.push({
              label: bundle.label,
              committedPath,
              status: 'build-failed',
              message: result.stderr.trim() || result.stdout.trim()
            });
            continue;
          }

          let fresh: Buffer;
          let committed: Buffer;
          try {
            fresh = readFileSync(tmpOut);
            committed = readFileSync(committedPath);
          } catch (error) {
            bundles.push({
              label: bundle.label,
              committedPath,
              status: 'missing',
              message: error instanceof Error ? error.message : String(error)
            });
            continue;
          }

          bundles.push({
            label: bundle.label,
            committedPath,
            status:
              fresh.length === committed.length && fresh.equals(committed)
                ? 'fresh'
                : 'stale'
          });
        } finally {
          rmSync(workdir, { recursive: true, force: true });
        }
      }

      return {
        ok: bundles.every((bundle) => bundle.status === 'fresh'),
        bundles
      };
    }
  };
}

export function createNodeDevPluginBuilder(): DevPluginBuilder {
  return {
    build(source: DevSourceResolution): DevPluginBuildResult {
      const result = spawnSync('bun', ['run', 'build:plugin'], {
        cwd: source.teamemRoot,
        encoding: 'utf8',
        stdio: 'inherit'
      });
      if (result.status === 0) {
        return {
          ok: true,
          message: 'Plugin bundles rebuilt with `bun run build:plugin`.'
        };
      }
      return {
        ok: false,
        exitCode: result.status ?? 1,
        message: `Plugin bundle build failed with exit code ${result.status ?? 1}.`
      };
    }
  };
}

export function readDevProfileServerUrl(options: {
  readonly profile: DevProfilePaths;
  readonly credentialsReader: DevCredentialsReader;
}): DevProfileServerUrlResult {
  const raw = options.credentialsReader.read(options.profile.credentialsPath);
  if (raw === null) {
    return {
      ok: false,
      message: `Profile credentials are missing: ${options.profile.credentialsPath}`
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      message: `Profile credentials are malformed: ${options.profile.credentialsPath}`
    };
  }

  if (!isRecord(parsed) || !isRecord(parsed.spaces)) {
    return {
      ok: false,
      message: `Profile credentials do not contain Teamem spaces: ${options.profile.credentialsPath}`
    };
  }

  const defaultSpaceId =
    typeof parsed.default_space_id === 'string'
      ? parsed.default_space_id
      : undefined;
  const selected = defaultSpaceId
    ? parsed.spaces[defaultSpaceId]
    : Object.values(parsed.spaces)[0];
  if (!isRecord(selected) || typeof selected.server_url !== 'string') {
    return {
      ok: false,
      message: `Profile credentials do not contain a server URL: ${options.profile.credentialsPath}`
    };
  }

  return { ok: true, serverUrl: selected.server_url };
}

export function readDevProfileDefaultSpaceId(options: {
  readonly profile: DevProfilePaths;
  readonly credentialsReader: DevCredentialsReader;
}): DevProfileDefaultSpaceResult {
  const raw = options.credentialsReader.read(options.profile.credentialsPath);
  if (raw === null) {
    return {
      ok: false,
      message: `Profile credentials are missing: ${options.profile.credentialsPath}`
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      message: `Profile credentials are malformed: ${options.profile.credentialsPath}`
    };
  }

  if (!isRecord(parsed) || !isRecord(parsed.spaces)) {
    return {
      ok: false,
      message: `Profile credentials do not contain Teamem spaces: ${options.profile.credentialsPath}`
    };
  }

  const defaultSpaceId =
    typeof parsed.default_space_id === 'string'
      ? parsed.default_space_id
      : undefined;
  if (defaultSpaceId && isRecord(parsed.spaces[defaultSpaceId])) {
    return { ok: true, defaultSpaceId };
  }

  return {
    ok: false,
    message: `Profile credentials do not contain a default Space: ${options.profile.credentialsPath}`
  };
}

export function renderDevServerHealth(result: DevServerHealthResult): string {
  if (result.ok) {
    return `Server health: reachable (${result.checkedUrl})`;
  }
  return `Server health: unreachable (${result.checkedUrl})\n    ${result.message}`;
}

export function devServerHealthUrl(serverUrl: string): string {
  const trimmed = serverUrl.trim().replace(/\/+$/, '');
  return `${trimmed}/health`;
}

export function renderDevBundleFreshness(
  report: DevBundleFreshnessReport
): string {
  const lines = ['Plugin bundle freshness'];
  for (const bundle of report.bundles) {
    lines.push(
      `${bundle.status === 'fresh' ? '[ok]' : '[error]'} ${bundle.label}: ${bundle.status} (${bundle.committedPath})`
    );
    if (bundle.message) {
      lines.push(`    details: ${bundle.message}`);
    }
  }
  lines.push(
    report.ok
      ? 'Bundle freshness passed: committed plugin/lib bundles match source builds byte-for-byte.'
      : 'Bundle freshness failed: run `bun run build:plugin` from the selected Teamem source checkout.'
  );
  return lines.join('\n');
}

export function hasDevBundleFreshnessFailure(
  report: DevBundleFreshnessReport
): boolean {
  return !report.ok;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
