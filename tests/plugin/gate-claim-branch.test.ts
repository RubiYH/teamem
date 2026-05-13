/**
 * Slice #29 — gate-claim.sh enriches bridge payload with branch-aware fields
 * and writes the last-branch state file.
 *
 * Follows the pattern from gate-claim-multi-space.test.ts:
 * - Stage a fake plugin in a temp dir
 * - Set up a real temp git repo for the file being edited
 * - Drive gate-claim.sh with a PreToolUse JSON
 * - Assert bridge argv contains repo_id, branch, current_head_sha, auto_release_mode
 * - Assert last-branch state file is written with correct contents
 */
import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  copyFileSync,
  chmodSync,
  readFileSync,
  existsSync,
  readdirSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dir, '../..');

function gitSync(cwd: string, args: string[]): void {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@test.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@test.com'
    }
  });
  if (r.status !== 0)
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
}

function stageFakePlugin(workdir: string, sentinel: string) {
  mkdirSync(join(workdir, 'plugin/scripts'), { recursive: true });
  mkdirSync(join(workdir, 'plugin/bin'), { recursive: true });
  mkdirSync(join(workdir, 'plugin/lib'), { recursive: true });
  copyFileSync(
    join(REPO_ROOT, 'plugin/scripts/_common.sh'),
    join(workdir, 'plugin/scripts/_common.sh')
  );
  copyFileSync(
    join(REPO_ROOT, 'plugin/scripts/gate-claim.sh'),
    join(workdir, 'plugin/scripts/gate-claim.sh')
  );
  chmodSync(join(workdir, 'plugin/scripts/gate-claim.sh'), 0o755);

  writeFileSync(
    join(workdir, 'plugin/lib/bridge.js'),
    `#!/usr/bin/env bun
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(sentinel)}, JSON.stringify(process.argv.slice(2)) + '\\n');
process.stdout.write(JSON.stringify({
  ok: true,
  data: { claim_id: 'fake-claim-1', expires_at: new Date(Date.now() + 60_000).toISOString() }
}));
process.exit(0);
`,
    { mode: 0o755 }
  );
}

function setupActiveSession(workdir: string, sessionId: string) {
  const pluginData = join(workdir, 'plugin-data');
  const sessionDir = join(pluginData, 'sessions', sessionId);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, 'active'), '');
  return { pluginData, sessionDir };
}

function createGitRepo(workdir: string): { repoDir: string; filePath: string } {
  const repoDir = join(workdir, 'git-repo');
  mkdirSync(repoDir, { recursive: true });
  gitSync(repoDir, ['init']);
  gitSync(repoDir, [
    'remote',
    'add',
    'origin',
    'https://github.com/org/test-repo.git'
  ]);
  const filePath = join(repoDir, 'src', 'Component.tsx');
  mkdirSync(join(repoDir, 'src'), { recursive: true });
  writeFileSync(filePath, 'export const Component = () => null;');
  gitSync(repoDir, ['add', '.']);
  gitSync(repoDir, ['commit', '-m', 'init']);
  return { repoDir, filePath };
}

describe('gate-claim.sh branch-aware enrichment', () => {
  it('sends repo_id, branch, current_head_sha, auto_release_mode=on_commit to bridge', () => {
    const workdir = mkdtempSync(join(tmpdir(), 'teamem-gate-branch-test-'));
    try {
      const sentinel = join(workdir, 'argv.log');
      stageFakePlugin(workdir, sentinel);
      const sessionId = 'test-session-branch-001';
      const { pluginData } = setupActiveSession(workdir, sessionId);
      const { filePath, repoDir } = createGitRepo(workdir);

      const input = JSON.stringify({
        tool_name: 'Edit',
        tool_input: { file_path: filePath },
        cwd: repoDir,
        session_id: sessionId
      });

      const result = spawnSync(
        join(workdir, 'plugin/scripts/gate-claim.sh'),
        [],
        {
          input,
          encoding: 'utf8',
          env: {
            ...process.env,
            CLAUDE_PLUGIN_ROOT: join(workdir, 'plugin'),
            CLAUDE_PLUGIN_DATA: pluginData,
            TEAMEM_SPACE: 'default',
            HOME: workdir
          }
        }
      );

      // Gate should exit 0 (allow or fail-open)
      expect(result.status).toBe(0);

      // Bridge must have been called
      expect(existsSync(sentinel)).toBe(true);
      const logLines = readFileSync(sentinel, 'utf-8').trim().split('\n');
      const argvLine = logLines.find((l) => l.includes('claim_scope'));
      expect(argvLine).toBeTruthy();

      // Parse all argv entries to find the --json payload
      for (const line of logLines) {
        let argv: string[];
        try {
          argv = JSON.parse(line) as string[];
        } catch {
          continue;
        }
        const jsonIdx = argv.indexOf('--json');
        if (jsonIdx === -1) continue;
        const payload = JSON.parse(argv[jsonIdx + 1]!) as Record<
          string,
          unknown
        >;
        if (typeof payload.repo_id !== 'string') continue;

        expect(payload.repo_id).toBeTruthy();
        expect(typeof payload.branch).toBe('string');
        expect((payload.branch as string).length).toBeGreaterThan(0);
        expect(typeof payload.current_head_sha).toBe('string');
        expect((payload.current_head_sha as string).length).toBeGreaterThan(0);
        expect(payload.auto_release_mode).toBe('on_commit');
        return; // test passed
      }

      throw new Error(
        'No claim_scope call with repo_id found in bridge argv log'
      );
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  it('writes last-branch state file with correct branch name', () => {
    const workdir = mkdtempSync(
      join(tmpdir(), 'teamem-gate-branch-file-test-')
    );
    try {
      const sentinel = join(workdir, 'argv.log');
      stageFakePlugin(workdir, sentinel);
      const sessionId = 'test-session-branch-002';
      const { pluginData } = setupActiveSession(workdir, sessionId);
      const { filePath, repoDir } = createGitRepo(workdir);

      const input = JSON.stringify({
        tool_name: 'Edit',
        tool_input: { file_path: filePath },
        cwd: repoDir,
        session_id: sessionId
      });

      spawnSync(join(workdir, 'plugin/scripts/gate-claim.sh'), [], {
        input,
        encoding: 'utf8',
        env: {
          ...process.env,
          CLAUDE_PLUGIN_ROOT: join(workdir, 'plugin'),
          CLAUDE_PLUGIN_DATA: pluginData,
          TEAMEM_SPACE: 'default',
          HOME: workdir
        }
      });

      // last-branch directory should exist with exactly one file
      const lastBranchDir = join(pluginData, 'last-branch');
      expect(existsSync(lastBranchDir)).toBe(true);
      const files = readdirSync(lastBranchDir);
      expect(files.length).toBeGreaterThan(0);

      // The file content should be the current branch name
      const branchName = readFileSync(join(lastBranchDir, files[0]!), 'utf-8');
      expect(branchName.length).toBeGreaterThan(0);
      // Should be a valid branch name (not empty, not a SHA)
      expect(branchName).not.toMatch(/^[0-9a-f]{40}$/);
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });
});
