import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dir, '../..');
const PLUGIN_MANIFEST = 'plugin/.claude-plugin/plugin.json';
const MARKETPLACE_MANIFEST = '.claude-plugin/marketplace.json';

const SOURCE_SHIPPING_EXACT = new Set(['src/cli/setup.ts']);
const SOURCE_SHIPPING_PREFIXES = ['src/bridge/', 'src/channel/'];

function isPluginNonShippingPath(path: string): boolean {
  if (path === 'plugin/README.md' || path === 'plugin/AGENTS.md') {
    return true;
  }
  return path.startsWith('plugin/') && path.endsWith('/AGENTS.md');
}

type Marketplace = {
  version?: string;
  plugins?: Array<{ name?: string; version?: string }>;
};

type PluginManifest = {
  version?: string;
};

type GitContext = {
  baseRef: string;
  diffSpec: string;
};

type GitHubPushEvent = {
  before?: string;
  repository?: {
    default_branch?: string;
  };
};

function isShippingPath(path: string): boolean {
  if (path.startsWith('plugin/')) {
    return !isPluginNonShippingPath(path);
  }

  return (
    SOURCE_SHIPPING_EXACT.has(path) ||
    SOURCE_SHIPPING_PREFIXES.some((prefix) => path.startsWith(prefix))
  );
}

function compareNumericVersion(a: string, b: string): number | null {
  if (!/^\d+(?:\.\d+)*$/.test(a) || !/^\d+(?:\.\d+)*$/.test(b)) {
    return null;
  }
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const delta = (left[i] ?? 0) - (right[i] ?? 0);
    if (delta !== 0) return delta > 0 ? 1 : -1;
  }
  return 0;
}

function teamemMarketplaceVersion(
  marketplace: Marketplace
): string | undefined {
  return marketplace.plugins?.find((plugin) => plugin.name === 'teamem')
    ?.version;
}

function validateVersionBump(params: {
  changedFiles: string[];
  pluginManifest: PluginManifest;
  marketplace: Marketplace;
  basePluginManifest: PluginManifest;
}): string[] {
  const shippingChanges = params.changedFiles.filter(isShippingPath);
  if (shippingChanges.length === 0) return [];

  const issues: string[] = [];
  const changed = new Set(params.changedFiles);
  if (!changed.has(PLUGIN_MANIFEST)) {
    issues.push(
      `${PLUGIN_MANIFEST} must change when plugin-shipping files change`
    );
  }
  if (!changed.has(MARKETPLACE_MANIFEST)) {
    issues.push(
      `${MARKETPLACE_MANIFEST} must change when plugin-shipping files change`
    );
  }

  const pluginVersion = params.pluginManifest.version;
  const marketplaceVersion = params.marketplace.version;
  const marketplacePluginVersion = teamemMarketplaceVersion(params.marketplace);
  const baseVersion = params.basePluginManifest.version;

  if (!pluginVersion || !marketplaceVersion || !marketplacePluginVersion) {
    issues.push('plugin and marketplace manifests must all declare versions');
  } else {
    if (pluginVersion !== marketplaceVersion) {
      issues.push('marketplace version must match plugin manifest version');
    }
    if (pluginVersion !== marketplacePluginVersion) {
      issues.push(
        'marketplace teamem plugin version must match plugin manifest version'
      );
    }
  }

  if (!pluginVersion || !baseVersion) {
    issues.push('base and current plugin manifest versions are required');
  } else {
    const comparison = compareNumericVersion(pluginVersion, baseVersion);
    if (comparison === null) {
      issues.push('plugin versions must use numeric dot-separated segments');
    } else if (comparison <= 0) {
      issues.push(
        `plugin version must increase from base (${baseVersion} -> ${pluginVersion})`
      );
    }
  }

  return issues;
}

function git(args: string[]): string {
  const result = spawnSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed: ${result.stderr.trim() || result.stdout.trim()}`
    );
  }
  return result.stdout.trim();
}

function refExists(ref: string): boolean {
  const result = spawnSync('git', ['rev-parse', '--verify', ref], {
    cwd: REPO_ROOT,
    encoding: 'utf8'
  });
  return result.status === 0;
}

function readGitHubPushEvent(
  env: NodeJS.ProcessEnv
): GitHubPushEvent | undefined {
  const eventPath = env.GITHUB_EVENT_PATH;
  if (!eventPath) return undefined;
  try {
    return JSON.parse(readFileSync(eventPath, 'utf8')) as GitHubPushEvent;
  } catch {
    return undefined;
  }
}

function resolveGitContext(env: NodeJS.ProcessEnv): GitContext {
  const override = env.TEAMEM_VERSION_BUMP_BASE;
  if (override) {
    if (override.includes('..')) {
      const baseRef = override.split(/\.\.\.?/)[0] || 'HEAD^';
      return { baseRef, diffSpec: override };
    }
    return { baseRef: override, diffSpec: `${override}...HEAD` };
  }

  if (env.GITHUB_BASE_REF) {
    const candidates = [`origin/${env.GITHUB_BASE_REF}`, env.GITHUB_BASE_REF];
    const baseRef = candidates.find(refExists) ?? candidates[0];
    return { baseRef, diffSpec: `${baseRef}...HEAD` };
  }

  if (env.GITHUB_ACTIONS) {
    const event = readGitHubPushEvent(env);
    if (!event) {
      throw new Error(
        'GITHUB_EVENT_PATH must point to a readable push event payload in GitHub Actions'
      );
    }
    // ^{commit} forces an object-existence check: rev-parse --verify accepts
    // any well-formed 40-hex SHA without it. A force-push makes the event's
    // `before` unreachable, so fall back to the default branch in that case.
    if (
      event.before &&
      !/^0+$/.test(event.before) &&
      refExists(`${event.before}^{commit}`)
    ) {
      return { baseRef: event.before, diffSpec: `${event.before}..HEAD` };
    }

    const defaultBranch = event.repository?.default_branch ?? 'master';
    const candidates = [
      `origin/${defaultBranch}`,
      defaultBranch,
      'origin/master',
      'master'
    ];
    const baseRef = candidates.find(refExists) ?? `origin/${defaultBranch}`;
    return { baseRef, diffSpec: `${baseRef}...HEAD` };
  }

  return { baseRef: 'origin/master', diffSpec: 'origin/master...HEAD' };
}

function readJsonAtRef<T>(ref: string, path: string): T {
  return JSON.parse(git(['show', `${ref}:${path}`])) as T;
}

function readCurrentJson<T>(path: string): T {
  return JSON.parse(readFileSync(join(REPO_ROOT, path), 'utf8')) as T;
}

function changedFilesFor(diffSpec: string): string[] {
  const output = git(['diff', '--name-only', '--diff-filter=ACMRTD', diffSpec]);
  return output ? output.split('\n').filter(Boolean) : [];
}

describe('plugin version bump guard', () => {
  it('identifies plugin-shipping paths without treating docs/tests as shipping', () => {
    expect(isShippingPath('plugin/monitors/monitors.json')).toBe(true);
    expect(isShippingPath('plugin/.claude-plugin/plugin.json')).toBe(true);
    expect(isShippingPath('plugin/templates/TEAMEM.starter.md')).toBe(true);
    expect(isShippingPath('plugin/future-runtime/file.json')).toBe(true);
    expect(isShippingPath('src/bridge/tool-bindings.ts')).toBe(true);
    expect(isShippingPath('src/cli/setup.ts')).toBe(true);
    expect(isShippingPath('plugin/README.md')).toBe(false);
    expect(isShippingPath('plugin/bin/AGENTS.md')).toBe(false);
    expect(isShippingPath('tests/plugin/version-bump-required.test.ts')).toBe(
      false
    );
    expect(isShippingPath('.docs/adr/example.md')).toBe(false);
  });

  it('allows non-shipping changes without a plugin version bump', () => {
    expect(
      validateVersionBump({
        changedFiles: ['plugin/README.md', 'tests/plugin/foo.test.ts'],
        pluginManifest: { version: '0.3.19' },
        marketplace: {
          version: '0.3.19',
          plugins: [{ name: 'teamem', version: '0.3.19' }]
        },
        basePluginManifest: { version: '0.3.19' }
      })
    ).toEqual([]);
  });

  it('requires both manifests to change for plugin-shipping changes', () => {
    const issues = validateVersionBump({
      changedFiles: ['plugin/bin/teamem-monitor'],
      pluginManifest: { version: '0.3.19' },
      marketplace: {
        version: '0.3.19',
        plugins: [{ name: 'teamem', version: '0.3.19' }]
      },
      basePluginManifest: { version: '0.3.18' }
    });

    expect(issues).toContain(
      `${PLUGIN_MANIFEST} must change when plugin-shipping files change`
    );
    expect(issues).toContain(
      `${MARKETPLACE_MANIFEST} must change when plugin-shipping files change`
    );
  });

  it('rejects stale or mismatched version bumps', () => {
    const stale = validateVersionBump({
      changedFiles: [
        'plugin/monitors/monitors.json',
        PLUGIN_MANIFEST,
        MARKETPLACE_MANIFEST
      ],
      pluginManifest: { version: '0.3.18' },
      marketplace: {
        version: '0.3.18',
        plugins: [{ name: 'teamem', version: '0.3.18' }]
      },
      basePluginManifest: { version: '0.3.18' }
    });
    expect(stale).toContain(
      'plugin version must increase from base (0.3.18 -> 0.3.18)'
    );

    const mismatched = validateVersionBump({
      changedFiles: [
        'plugin/scripts/_common.sh',
        PLUGIN_MANIFEST,
        MARKETPLACE_MANIFEST
      ],
      pluginManifest: { version: '0.3.19' },
      marketplace: {
        version: '0.3.19',
        plugins: [{ name: 'teamem', version: '0.3.18' }]
      },
      basePluginManifest: { version: '0.3.18' }
    });
    expect(mismatched).toContain(
      'marketplace teamem plugin version must match plugin manifest version'
    );
  });

  it('allows a mirrored numeric version increase for plugin-shipping changes', () => {
    expect(
      validateVersionBump({
        changedFiles: [
          'src/channel/index.ts',
          PLUGIN_MANIFEST,
          MARKETPLACE_MANIFEST
        ],
        pluginManifest: { version: '0.3.19' },
        marketplace: {
          version: '0.3.19',
          plugins: [{ name: 'teamem', version: '0.3.19' }]
        },
        basePluginManifest: { version: '0.3.18' }
      })
    ).toEqual([]);
  });

  it('uses the full GitHub push range when push event metadata has a before SHA', () => {
    const before = git(['rev-parse', 'HEAD']);
    const work = mkdtempSync(join(tmpdir(), 'teamem-version-guard-'));
    try {
      const eventPath = join(work, 'event.json');
      writeFileSync(
        eventPath,
        JSON.stringify({
          before,
          repository: { default_branch: 'master' }
        })
      );

      expect(
        resolveGitContext({
          GITHUB_ACTIONS: 'true',
          GITHUB_EVENT_PATH: eventPath
        })
      ).toEqual({ baseRef: before, diffSpec: `${before}..HEAD` });
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('falls back to the default branch when the push before SHA is unreachable (force push)', () => {
    const work = mkdtempSync(join(tmpdir(), 'teamem-version-guard-'));
    try {
      const eventPath = join(work, 'event.json');
      writeFileSync(
        eventPath,
        JSON.stringify({
          before: 'f'.repeat(40),
          repository: { default_branch: 'master' }
        })
      );

      expect(
        resolveGitContext({
          GITHUB_ACTIONS: 'true',
          GITHUB_EVENT_PATH: eventPath
        })
      ).toEqual({
        baseRef: 'origin/master',
        diffSpec: 'origin/master...HEAD'
      });
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('fails closed in GitHub Actions when push event metadata is unreadable', () => {
    expect(() =>
      resolveGitContext({
        GITHUB_ACTIONS: 'true',
        GITHUB_EVENT_PATH: '/path/that/does/not/exist'
      })
    ).toThrow(
      'GITHUB_EVENT_PATH must point to a readable push event payload in GitHub Actions'
    );
  });

  it('validates the current git diff against the resolved base', () => {
    const context = resolveGitContext(process.env);
    const issues = validateVersionBump({
      changedFiles: changedFilesFor(context.diffSpec),
      pluginManifest: readCurrentJson<PluginManifest>(PLUGIN_MANIFEST),
      marketplace: readCurrentJson<Marketplace>(MARKETPLACE_MANIFEST),
      basePluginManifest: readJsonAtRef<PluginManifest>(
        context.baseRef,
        PLUGIN_MANIFEST
      )
    });

    expect(issues).toEqual([]);
  });
});
