import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync
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
  '../../plugin/scripts/teamem-rule-init.sh'
);

function stagePlugin(
  tempRoot: string,
  snapshotResponse: Record<string, unknown>
): string {
  const pluginRoot = join(tempRoot, 'plugin');
  mkdirSync(join(pluginRoot, 'scripts'), { recursive: true });
  mkdirSync(join(pluginRoot, 'templates'), { recursive: true });
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
  copyFileSync(SCRIPT_PATH, join(pluginRoot, 'scripts/teamem-rule-init.sh'));
  copyFileSync(
    join(REPO_ROOT, 'plugin/templates/TEAMEM.starter.md'),
    join(pluginRoot, 'templates/TEAMEM.starter.md')
  );
  copyFileSync(
    join(REPO_ROOT, 'plugin/.claude-plugin/plugin.json'),
    join(pluginRoot, '.claude-plugin/plugin.json')
  );

  writeFileSync(
    join(pluginRoot, 'bin/teamem-call'),
    `#!/usr/bin/env bash
set -euo pipefail
cat <<'JSON'
${JSON.stringify(snapshotResponse)}
JSON
`,
    { mode: 0o755 }
  );

  chmodSync(join(pluginRoot, 'scripts/teamem-rule-init.sh'), 0o755);
  chmodSync(join(pluginRoot, 'scripts/space-rules-file.js'), 0o755);
  chmodSync(join(pluginRoot, 'bin/teamem-call'), 0o755);
  return pluginRoot;
}

describe('teamem-rule slash command wiring', () => {
  it('command is self-contained and invokes the bundled init script', () => {
    const text = readFileSync(COMMAND_PATH, 'utf-8');
    expect(text).toContain(
      'bash "${CLAUDE_PLUGIN_ROOT}/scripts/teamem-rule-init.sh"'
    );
    expect(text).not.toContain('CLAUDE_PLUGIN_OPTION_TEAMEM_ROOT');
    expect(text).not.toContain('bun run space ');
  });
});

describe('teamem-rule init script', () => {
  it('creates TEAMEM.md from the starter template when no server snapshot exists', () => {
    const temp = mkdtempSync(join(tmpdir(), 'teamem-rule-starter-'));
    const repo = join(temp, 'repo');
    mkdirSync(repo, { recursive: true });
    const pluginRoot = stagePlugin(temp, {
      ok: true,
      data: {
        has_server_rules: false,
        rendered_rules_body: '',
        metadata: {
          format_version: 1,
          source: 'none',
          managed_begin: '<!-- BEGIN TEAMEM SPACE RULES -->',
          managed_end: '<!-- END TEAMEM SPACE RULES -->',
          rules_version: 0,
          rules_hash: 'hash-none',
          generated_at: '2026-05-10T00:00:00.000Z',
          space_id: 'space-starter',
          space_label: 'starter-only',
          source_event_id: null,
          snapshot_updated_at: null,
          snapshot_updated_by: null
        }
      }
    });
    try {
      const result = spawnSync('bash', [SCRIPT_PATH], {
        cwd: repo,
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: join(temp, 'home'),
          CLAUDE_PLUGIN_ROOT: pluginRoot,
          CLAUDE_SESSION_ID: 'sess-rule-1'
        }
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        'Initialized TEAMEM.md from the local starter template.'
      );
      expect(existsSync(join(repo, 'TEAMEM.md'))).toBe(true);
      expect(
        existsSync(join(repo, '.teamem', 'space-rules-snapshot.json'))
      ).toBe(true);

      const teamem = readFileSync(join(repo, 'TEAMEM.md'), 'utf8');
      expect(teamem).toContain('## Teamem Space Rules');
      expect(teamem).not.toContain('<!-- BEGIN TEAMEM SPACE RULES -->');
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it('creates one managed block from the starter when a server snapshot exists', () => {
    const temp = mkdtempSync(join(tmpdir(), 'teamem-rule-fresh-snapshot-'));
    const repo = join(temp, 'repo');
    mkdirSync(repo, { recursive: true });
    const pluginRoot = stagePlugin(temp, {
      ok: true,
      data: {
        has_server_rules: true,
        rendered_rules_body: 'Prefer focused diffs.',
        metadata: {
          format_version: 1,
          source: 'server',
          managed_begin: '<!-- BEGIN TEAMEM SPACE RULES -->',
          managed_end: '<!-- END TEAMEM SPACE RULES -->',
          rules_version: 1,
          rules_hash: 'hash-fresh',
          generated_at: '2026-05-10T03:04:05.000Z',
          space_id: 'space-fresh',
          space_label: 'fresh-space',
          source_event_id: 'evt-rule-fresh',
          snapshot_updated_at: '2026-05-10T03:04:05.000Z',
          snapshot_updated_by: 'alice'
        }
      }
    });

    try {
      const result = spawnSync('bash', [SCRIPT_PATH], {
        cwd: repo,
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: join(temp, 'home'),
          CLAUDE_PLUGIN_ROOT: pluginRoot,
          CLAUDE_SESSION_ID: 'sess-rule-fresh'
        }
      });

      expect(result.status).toBe(0);
      const teamem = readFileSync(join(repo, 'TEAMEM.md'), 'utf8');
      expect(teamem.match(/^## Teamem Space Rules$/gm)).toHaveLength(1);
      expect(
        teamem.match(/^<!-- BEGIN TEAMEM SPACE RULES -->$/gm)
      ).toHaveLength(1);
      expect(teamem.match(/^<!-- END TEAMEM SPACE RULES -->$/gm)).toHaveLength(
        1
      );
      expect(teamem).toContain('Prefer focused diffs.');
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it('refreshes only the managed block when a server snapshot exists', () => {
    const temp = mkdtempSync(join(tmpdir(), 'teamem-rule-snapshot-'));
    const repo = join(temp, 'repo');
    mkdirSync(repo, { recursive: true });
    const pluginRoot = stagePlugin(temp, {
      ok: true,
      data: {
        has_server_rules: true,
        rendered_rules_body:
          'Always check team claims before large edits.\nKeep local notes outside the managed block.',
        metadata: {
          format_version: 1,
          source: 'server',
          managed_begin: '<!-- BEGIN TEAMEM SPACE RULES -->',
          managed_end: '<!-- END TEAMEM SPACE RULES -->',
          rules_version: 4,
          rules_hash: 'hash-server',
          generated_at: '2026-05-10T03:04:05.000Z',
          space_id: 'space-snapshot',
          space_label: 'snapshot-space',
          source_event_id: 'evt-rule-script',
          snapshot_updated_at: '2026-05-10T03:04:05.000Z',
          snapshot_updated_by: 'alice'
        }
      }
    });
    writeFileSync(
      join(repo, 'TEAMEM.md'),
      `# TEAMEM.md

Local intro that must survive.

## Teamem Space Rules

<!-- BEGIN TEAMEM SPACE RULES -->
<!-- teamem:space-rules {"format_version":1,"source":"server","managed_begin":"<!-- BEGIN TEAMEM SPACE RULES -->","managed_end":"<!-- END TEAMEM SPACE RULES -->","rules_version":3,"rules_hash":"old","generated_at":"2026-05-01T00:00:00.000Z","space_id":"space-snapshot","space_label":"snapshot-space","source_event_id":"evt-old","snapshot_updated_at":"2026-05-01T00:00:00.000Z","snapshot_updated_by":"alice"} -->
Old managed content.
<!-- END TEAMEM SPACE RULES -->

Local outro that must also survive.
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
          CLAUDE_SESSION_ID: 'sess-rule-2'
        }
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        'Initialized TEAMEM.md and refreshed the Teamem-managed Space Rules block.'
      );

      const teamem = readFileSync(join(repo, 'TEAMEM.md'), 'utf8');
      expect(teamem).toContain('Local intro that must survive.');
      expect(teamem).toContain('Local outro that must also survive.\n');
      expect(teamem).toContain('Always check team claims before large edits.');
      expect(teamem).toContain('<!-- BEGIN TEAMEM SPACE RULES -->');
      expect(teamem).toContain('<!-- END TEAMEM SPACE RULES -->');
      expect(teamem).not.toContain('Old managed content.');

      const cache = JSON.parse(
        readFileSync(join(repo, '.teamem', 'space-rules-snapshot.json'), 'utf8')
      ) as {
        snapshot: {
          metadata: { rules_hash: string; snapshot_updated_by: string };
        };
      };
      expect(cache.snapshot.metadata.rules_hash).toBeTruthy();
      expect(cache.snapshot.metadata.snapshot_updated_by).toBe('alice');
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it('preserves trailing content outside the managed block byte-for-byte', () => {
    const temp = mkdtempSync(join(tmpdir(), 'teamem-rule-preserve-'));
    const repo = join(temp, 'repo');
    mkdirSync(repo, { recursive: true });
    const pluginRoot = stagePlugin(temp, {
      ok: true,
      data: {
        has_server_rules: true,
        rendered_rules_body: 'New managed rules.',
        metadata: {
          format_version: 1,
          source: 'server',
          managed_begin: '<!-- BEGIN TEAMEM SPACE RULES -->',
          managed_end: '<!-- END TEAMEM SPACE RULES -->',
          rules_version: 2,
          rules_hash: 'hash-preserve',
          generated_at: '2026-05-10T03:04:05.000Z',
          space_id: 'space-preserve',
          space_label: 'preserve-space',
          source_event_id: 'evt-rule-preserve',
          snapshot_updated_at: '2026-05-10T03:04:05.000Z',
          snapshot_updated_by: 'alice'
        }
      }
    });
    const prefix = '# TEAMEM.md\n\nLocal intro.\n\n';
    const suffix = '\nLocal outro.\n\n\n';
    writeFileSync(
      join(repo, 'TEAMEM.md'),
      `${prefix}<!-- BEGIN TEAMEM SPACE RULES -->\nold\n<!-- END TEAMEM SPACE RULES -->${suffix}`
    );

    try {
      const result = spawnSync('bash', [SCRIPT_PATH], {
        cwd: repo,
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: join(temp, 'home'),
          CLAUDE_PLUGIN_ROOT: pluginRoot,
          CLAUDE_SESSION_ID: 'sess-rule-preserve'
        }
      });

      expect(result.status).toBe(0);
      const teamem = readFileSync(join(repo, 'TEAMEM.md'), 'utf8');
      const begin = teamem.indexOf('<!-- BEGIN TEAMEM SPACE RULES -->');
      const end =
        teamem.indexOf('<!-- END TEAMEM SPACE RULES -->') +
        '<!-- END TEAMEM SPACE RULES -->'.length;
      expect(teamem.slice(0, begin)).toBe(prefix);
      expect(teamem.slice(end)).toBe(suffix);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it('escapes metadata so comment-breaking labels cannot inject markdown', () => {
    const temp = mkdtempSync(join(tmpdir(), 'teamem-rule-metadata-'));
    const repo = join(temp, 'repo');
    mkdirSync(repo, { recursive: true });
    const maliciousLabel = 'bad -->\n# injected label';
    const maliciousAuthor = 'alice -->\n# injected author';
    const pluginRoot = stagePlugin(temp, {
      ok: true,
      data: {
        has_server_rules: true,
        rendered_rules_body: 'Safe server-authored rules.',
        metadata: {
          format_version: 1,
          source: 'server',
          managed_begin: '<!-- BEGIN TEAMEM SPACE RULES -->',
          managed_end: '<!-- END TEAMEM SPACE RULES -->',
          rules_version: 5,
          rules_hash: 'hash-encoded',
          generated_at: '2026-05-10T03:04:05.000Z',
          space_id: 'space-encoded',
          space_label: maliciousLabel,
          source_event_id: 'evt-rule-encoded',
          snapshot_updated_at: '2026-05-10T03:04:05.000Z',
          snapshot_updated_by: maliciousAuthor
        }
      }
    });

    try {
      const result = spawnSync('bash', [SCRIPT_PATH], {
        cwd: repo,
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: join(temp, 'home'),
          CLAUDE_PLUGIN_ROOT: pluginRoot,
          CLAUDE_SESSION_ID: 'sess-rule-encoded'
        }
      });

      expect(result.status).toBe(0);
      const teamem = readFileSync(join(repo, 'TEAMEM.md'), 'utf8');
      expect(teamem).not.toContain('\n# injected label');
      expect(teamem).not.toContain('\n# injected author');
      const metadataLine = teamem
        .split('\n')
        .find((line) => line.startsWith('<!-- teamem:space-rules '));
      expect(metadataLine).toBeTruthy();
      expect(metadataLine).toContain('"space_id":"space-encoded"');
      expect(metadataLine).toContain('"rules_version":5');
      expect(metadataLine).toContain('"rules_hash":"hash-encoded"');
      const rawMetadata = metadataLine
        ?.replace('<!-- teamem:space-rules ', '')
        .replace(' -->', '');
      expect(rawMetadata).not.toContain('-->');
      const decoded = JSON.parse(rawMetadata ?? '') as {
        space_label: string;
        snapshot_updated_by: string;
      };
      expect(decoded.space_label).toBe(maliciousLabel);
      expect(decoded.snapshot_updated_by).toBe(maliciousAuthor);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});
