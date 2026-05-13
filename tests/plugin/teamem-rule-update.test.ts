import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dir, '../..');
const COMMAND_PATH = resolve(
  import.meta.dir,
  '../../plugin/commands/teamem-rule.md'
);
const SCRIPT_PATH = resolve(
  import.meta.dir,
  '../../plugin/scripts/teamem-rule-update.sh'
);

function stagePlugin(
  tempRoot: string,
  response: Record<string, unknown>
): string {
  const pluginRoot = join(tempRoot, 'plugin');
  mkdirSync(join(pluginRoot, 'scripts'), { recursive: true });
  mkdirSync(join(pluginRoot, 'bin'), { recursive: true });
  mkdirSync(join(pluginRoot, '.claude-plugin'), { recursive: true });

  copyFileSync(
    join(REPO_ROOT, 'plugin/scripts/_common.sh'),
    join(pluginRoot, 'scripts/_common.sh')
  );
  copyFileSync(
    join(REPO_ROOT, 'plugin/scripts/space-rules-file.js'),
    join(pluginRoot, 'scripts/space-rules-file.js')
  );
  copyFileSync(SCRIPT_PATH, join(pluginRoot, 'scripts/teamem-rule-update.sh'));
  copyFileSync(
    join(REPO_ROOT, 'plugin/.claude-plugin/plugin.json'),
    join(pluginRoot, '.claude-plugin/plugin.json')
  );

  writeFileSync(
    join(pluginRoot, 'bin/teamem-call'),
    `#!/usr/bin/env bash
set -euo pipefail
cat <<'JSON'
${JSON.stringify(response)}
JSON
`,
    { mode: 0o755 }
  );

  chmodSync(join(pluginRoot, 'scripts/teamem-rule-update.sh'), 0o755);
  chmodSync(join(pluginRoot, 'scripts/space-rules-file.js'), 0o755);
  chmodSync(join(pluginRoot, 'bin/teamem-call'), 0o755);
  return pluginRoot;
}

describe('teamem-rule update slash command wiring', () => {
  it('command invokes the bundled update script', () => {
    const text = readFileSync(COMMAND_PATH, 'utf8');
    expect(text).toContain(
      'bash "${CLAUDE_PLUGIN_ROOT}/scripts/teamem-rule-update.sh"'
    );
    expect(text).toContain('init | update');
  });
});

describe('teamem-rule update script', () => {
  it('publishes a local draft and rewrites TEAMEM.md from the server snapshot', () => {
    const temp = mkdtempSync(join(tmpdir(), 'teamem-rule-update-'));
    const repo = join(temp, 'repo');
    mkdirSync(repo, { recursive: true });
    const pluginRoot = stagePlugin(temp, {
      ok: true,
      data: {
        has_server_rules: true,
        rendered_rules_body: 'Prefer focused diffs.\nRead the briefing first.',
        metadata: {
          format_version: 1,
          source: 'server',
          managed_begin: '<!-- BEGIN TEAMEM SPACE RULES -->',
          managed_end: '<!-- END TEAMEM SPACE RULES -->',
          rules_version: 1,
          rules_hash:
            '5797b8e8a572908a5b812e5e89d5c368dd3415f860b9a19f12ac56879da79ac8',
          generated_at: '2026-05-10T10:00:00.000Z',
          space_id: 'space-rules',
          space_label: 'Rules Space',
          source_event_id: 'evt-space-rule-added',
          snapshot_updated_at: '2026-05-10T10:00:00.000Z',
          snapshot_updated_by: 'alice'
        }
      }
    });
    writeFileSync(
      join(repo, 'TEAMEM.md'),
      `# TEAMEM.md

## Local Notes

These notes must survive.

## Teamem Space Rules

Prefer focused diffs.
Read the briefing first.
`
    );

    try {
      const result = spawnSync('bash', [SCRIPT_PATH], {
        cwd: repo,
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: join(temp, 'home'),
          CLAUDE_PLUGIN_ROOT: pluginRoot,
          CLAUDE_SESSION_ID: 'sess-rule-update-1'
        }
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        'Published Space Rules snapshot version 1'
      );

      const teamem = readFileSync(join(repo, 'TEAMEM.md'), 'utf8');
      expect(teamem).toContain('These notes must survive.');
      expect(teamem).toContain('<!-- BEGIN TEAMEM SPACE RULES -->');
      expect(teamem).toContain('Prefer focused diffs.');
      expect(teamem).toContain('Read the briefing first.');
      expect(teamem).toContain('"rules_version":1');
      const cache = readFileSync(
        join(repo, '.teamem', 'space-rules-snapshot.json'),
        'utf8'
      );
      expect(cache).toContain('"rules_version": 1');
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it('surfaces stale publish conflicts and preserves the local file', () => {
    const temp = mkdtempSync(join(tmpdir(), 'teamem-rule-update-stale-'));
    const repo = join(temp, 'repo');
    mkdirSync(repo, { recursive: true });
    const pluginRoot = stagePlugin(temp, {
      ok: false,
      error: {
        code: 'space_rules_conflict',
        message: 'stale Space Rules draft; refresh before publishing',
        details: {
          current_version: 3,
          current_hash: 'server-hash',
          current_source_event_id: 'evt-space-rule-amended',
          has_server_rules: true
        }
      }
    });
    const original = `# TEAMEM.md

## Teamem Space Rules

<!-- BEGIN TEAMEM SPACE RULES -->
<!-- teamem:space-rules {"format_version":1,"source":"server","managed_begin":"\\u003c!-- BEGIN TEAMEM SPACE RULES --\\u003e","managed_end":"\\u003c!-- END TEAMEM SPACE RULES --\\u003e","rules_version":2,"rules_hash":"old-hash","generated_at":"2026-05-10T09:00:00.000Z","space_id":"space-rules","space_label":"Rules Space","source_event_id":"evt-space-rule-added","snapshot_updated_at":"2026-05-10T09:00:00.000Z","snapshot_updated_by":"alice"} -->
Prefer focused diffs.
<!-- END TEAMEM SPACE RULES -->
`;
    writeFileSync(join(repo, 'TEAMEM.md'), original);

    try {
      const result = spawnSync('bash', [SCRIPT_PATH], {
        cwd: repo,
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: join(temp, 'home'),
          CLAUDE_PLUGIN_ROOT: pluginRoot,
          CLAUDE_SESSION_ID: 'sess-rule-update-2'
        }
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('stale Space Rules draft');
      expect(result.stderr).toContain('current_version=3');
      expect(readFileSync(join(repo, 'TEAMEM.md'), 'utf8')).toBe(original);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});
