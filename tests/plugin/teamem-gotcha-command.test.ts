import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const COMMAND_PATH = resolve(
  import.meta.dir,
  '../../plugin/commands/gotcha.md'
);
const SCRIPT_PATH = resolve(
  import.meta.dir,
  '../../plugin/scripts/teamem-gotcha.sh'
);

function frontmatter(text: string): Record<string, string> {
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  expect(match).not.toBeNull();
  const entries = (match?.[1] ?? '')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const idx = line.indexOf(':');
      return [
        line.slice(0, idx),
        line
          .slice(idx + 1)
          .trim()
          .replace(/^"|"$/g, '')
      ] as const;
    });
  return Object.fromEntries(entries);
}

describe('/teamem:gotcha slash command', () => {
  it('uses the bundled bash script so tags are sent as JSON arrays', () => {
    expect(existsSync(COMMAND_PATH)).toBe(true);
    const text = readFileSync(COMMAND_PATH, 'utf-8');
    const fm = frontmatter(text);

    expect(fm['allowed-tools']).toBe('Bash(bash:*)');
    expect(text).toContain('scripts/teamem-gotcha.sh');
    expect(text).toContain('kind: "gotcha"');
  });

  it('script sends kind=gotcha with parsed tags and severity', () => {
    const root = mkdtempSync(join(tmpdir(), 'teamem-gotcha-command-'));
    const binDir = join(root, 'bin');
    const scriptDir = join(root, 'scripts');
    spawnSync('mkdir', ['-p', binDir, scriptDir]);
    spawnSync('cp', [SCRIPT_PATH, join(scriptDir, 'teamem-gotcha.sh')]);

    const capturePath = join(root, 'capture.json');
    const teamemCallPath = join(binDir, 'teamem-call');
    writeFileSync(
      teamemCallPath,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s' "$3" > "${capturePath}"
printf '{"ok":true,"data":{"finding_id":"finding-1","severity":"warning","expires_at":null}}'
`
    );
    chmodSync(teamemCallPath, 0o755);

    const result = spawnSync(
      'bash',
      [
        join(scriptDir, 'teamem-gotcha.sh'),
        'I had hard time debugging React error, but restart dev server fixed it #build --severity=warning'
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          CLAUDE_PLUGIN_ROOT: root
        },
        encoding: 'utf-8'
      }
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Shared gotcha finding-1');
    const payload = JSON.parse(readFileSync(capturePath, 'utf-8')) as {
      kind: string;
      summary: string;
      tags: string[];
      severity: string;
    };
    expect(payload.kind).toBe('gotcha');
    expect(payload.tags).toEqual(['build']);
    expect(payload.severity).toBe('warning');
    expect(payload.summary).toBe(
      'I had hard time debugging React error, but restart dev server fixed it'
    );
  });
});
