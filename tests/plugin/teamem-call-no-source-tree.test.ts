/**
 * Codex F4 regression — `plugin/bin/teamem-call` must work without
 * `TEAMEM_ROOT` and without any source-tree path.
 *
 * Original bug: the script invoked `teamem_require_root`, which checks
 * `${CLAUDE_PLUGIN_OPTION_TEAMEM_ROOT}/src/bridge`. The plugin manifest no
 * longer exposes `teamem_root`, so a marketplace install left
 * `CLAUDE_PLUGIN_OPTION_TEAMEM_ROOT` unset and the wrapper exited 1
 * before invoking the bundled bridge.
 *
 * Fix: rewrite to spawn `bun run "${CLAUDE_PLUGIN_ROOT}/lib/bridge.js" call <tool>`
 * directly. No `teamem_require_root` reference. No source-tree path.
 *
 * This test runs the script in a clean env (no TEAMEM_ROOT, no
 * CLAUDE_PLUGIN_OPTION_TEAMEM_ROOT) and asserts the bundle is invoked.
 */
import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  chmodSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dir, '../..');

describe('teamem-call works without source-tree config (Codex F4)', () => {
  it('invokes the bundled bridge when CLAUDE_PLUGIN_ROOT is set and TEAMEM_ROOT is absent', () => {
    // Stage a fake plugin install: copy scripts/_common.sh + bin/teamem-call,
    // then drop a marker `lib/bridge.js` we can detect being invoked.
    const plugin = mkdtempSync(join(tmpdir(), 'teamem-plugin-'));
    try {
      mkdirSync(join(plugin, 'scripts'));
      mkdirSync(join(plugin, 'bin'));
      mkdirSync(join(plugin, 'lib'));

      // Copy the real plugin files. Using absolute paths keeps the test
      // hermetic against `cwd` drift in the harness.
      const realCommon = join(REPO_ROOT, 'plugin/scripts/_common.sh');
      const realCall = join(REPO_ROOT, 'plugin/bin/teamem-call');
      const fs = require('node:fs');
      fs.copyFileSync(realCommon, join(plugin, 'scripts/_common.sh'));
      fs.copyFileSync(realCall, join(plugin, 'bin/teamem-call'));

      // Replace the bundle with a marker script that just echoes its argv
      // and exits 0. We're testing the wrapper's invocation, not the bridge
      // runtime itself.
      writeFileSync(
        join(plugin, 'lib/bridge.js'),
        `#!/usr/bin/env bun
console.log("BRIDGE_INVOKED", JSON.stringify(process.argv.slice(2)));
process.exit(0);
`,
        { mode: 0o755 }
      );
      chmodSync(join(plugin, 'bin/teamem-call'), 0o755);

      // Run with NO TEAMEM_ROOT, NO CLAUDE_PLUGIN_OPTION_TEAMEM_ROOT.
      const env: Record<string, string | undefined> = {
        ...process.env,
        CLAUDE_PLUGIN_ROOT: plugin
      };
      delete env.TEAMEM_ROOT;
      delete env.CLAUDE_PLUGIN_OPTION_TEAMEM_ROOT;

      const result = spawnSync(
        'bash',
        [
          join(plugin, 'bin/teamem-call'),
          'teamem.get_briefing',
          '--json',
          '{}'
        ],
        { env, encoding: 'utf-8', timeout: 10_000 }
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('BRIDGE_INVOKED');
      // Confirm the bundle path was the one passed to bun, not src/bridge/index.ts.
      expect(result.stdout).toContain('"call"');
      expect(result.stdout).toContain('"teamem.get_briefing"');
      // Negative — wrapper must NOT have errored on missing TEAMEM_ROOT.
      expect(result.stderr).not.toContain('teamem_root_unset');
      expect(result.stderr).not.toContain('TEAMEM_ROOT');
    } finally {
      rmSync(plugin, { recursive: true, force: true });
    }
  }, 30_000);

  it('exports the resolved Teamem data dir to the bundled bridge when Claude exposes another plugin data dir', () => {
    const home = mkdtempSync(join(tmpdir(), 'teamem-plugin-home-'));
    const plugin = join(
      home,
      '.claude/plugins/cache/teamem-alpha/teamem/0.3.29'
    );
    try {
      mkdirSync(join(plugin, 'scripts'), { recursive: true });
      mkdirSync(join(plugin, 'bin'));
      mkdirSync(join(plugin, 'lib'));
      mkdirSync(join(home, '.claude/plugins/data/codex-openai-codex'), {
        recursive: true
      });

      const fs = require('node:fs');
      fs.copyFileSync(
        join(REPO_ROOT, 'plugin/scripts/_common.sh'),
        join(plugin, 'scripts/_common.sh')
      );
      fs.copyFileSync(
        join(REPO_ROOT, 'plugin/bin/teamem-call'),
        join(plugin, 'bin/teamem-call')
      );
      writeFileSync(
        join(plugin, 'lib/bridge.js'),
        `#!/usr/bin/env bun
console.log(JSON.stringify({ teamemData: process.env.TEAMEM_DATA, claudePluginData: process.env.CLAUDE_PLUGIN_DATA }));
process.exit(0);
`,
        { mode: 0o755 }
      );
      chmodSync(join(plugin, 'bin/teamem-call'), 0o755);

      const foreignData = join(home, '.claude/plugins/data/codex-openai-codex');
      const env: Record<string, string | undefined> = {
        ...process.env,
        HOME: home,
        CLAUDE_PLUGIN_ROOT: plugin,
        CLAUDE_PLUGIN_DATA: foreignData
      };
      delete env.TEAMEM_DATA;
      delete env.TEAMEM_ROOT;
      delete env.CLAUDE_PLUGIN_OPTION_TEAMEM_ROOT;

      const result = spawnSync(
        'bash',
        [join(plugin, 'bin/teamem-call'), 'teamem.join_sprint', '--json', '{}'],
        { env, encoding: 'utf-8', timeout: 10_000 }
      );

      expect(result.status).toBe(0);
      const payload = JSON.parse(result.stdout.trim()) as {
        teamemData?: string;
        claudePluginData?: string;
      };
      expect(payload.claudePluginData).toBe(foreignData);
      expect(payload.teamemData).toBe(
        join(home, '.claude/plugins/data/teamem-teamem-alpha')
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);

  it('emits a bridge_bundle_missing error when lib/bridge.js is absent (still does NOT require TEAMEM_ROOT)', () => {
    const plugin = mkdtempSync(join(tmpdir(), 'teamem-plugin-no-bundle-'));
    try {
      mkdirSync(join(plugin, 'scripts'));
      mkdirSync(join(plugin, 'bin'));
      // Intentionally NOT creating lib/.

      const fs = require('node:fs');
      fs.copyFileSync(
        join(REPO_ROOT, 'plugin/scripts/_common.sh'),
        join(plugin, 'scripts/_common.sh')
      );
      fs.copyFileSync(
        join(REPO_ROOT, 'plugin/bin/teamem-call'),
        join(plugin, 'bin/teamem-call')
      );
      chmodSync(join(plugin, 'bin/teamem-call'), 0o755);

      const env: Record<string, string | undefined> = {
        ...process.env,
        CLAUDE_PLUGIN_ROOT: plugin
      };
      delete env.TEAMEM_ROOT;
      delete env.CLAUDE_PLUGIN_OPTION_TEAMEM_ROOT;

      const result = spawnSync(
        'bash',
        [join(plugin, 'bin/teamem-call'), 'teamem.get_briefing'],
        { env, encoding: 'utf-8', timeout: 10_000 }
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('bridge_bundle_missing');
      // The error must reference the bundle path, NOT TEAMEM_ROOT.
      expect(result.stderr).not.toContain('teamem_root_unset');
    } finally {
      rmSync(plugin, { recursive: true, force: true });
    }
  }, 30_000);
});
