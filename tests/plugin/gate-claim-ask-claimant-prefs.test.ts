/**
 * Regression: legacy ask-claimant payload values must not route gate-claim
 * into the removed human-approval coordination mode.
 *
 * If a stale server or DB row leaks `incumbent_coord_pref: ask-claimant`, the
 * hook should conservatively normalize to auto-skip: queue the pending edit,
 * deny the local tool call, and never call request_edit_permission.
 */
import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dir, '../..');

function gitInitWorkdir(workdir: string) {
  spawnSync('git', ['init'], { cwd: workdir, encoding: 'utf8' });
  spawnSync('git', ['commit', '--allow-empty', '-m', 'init'], {
    cwd: workdir,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@test.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@test.com'
    }
  });
  mkdirSync(join(workdir, 'src'), { recursive: true });
  writeFileSync(join(workdir, 'src/x.ts'), 'export const x = 1;\n');
}

function stage(workdir: string) {
  mkdirSync(join(workdir, 'plugin/scripts'), { recursive: true });
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

  const sentinel = join(workdir, 'argv.log');
  const stub = `#!/usr/bin/env bun
import { appendFileSync } from 'node:fs';
const argv = process.argv.slice(2);
appendFileSync(${JSON.stringify(sentinel)}, JSON.stringify(argv) + '\\n');

const tool = argv[1];
let response;
if (tool === 'teamem.claim_scope') {
  response = {
    ok: false,
    error: {
      code: 'scope_conflict',
      message: 'bob holds [src/x.ts]',
      conflicting_claim_id: 'incumbent-claim-legacy-ask-1',
      conflicting_principal: 'bob',
      requester_coord_pref: 'auto-skip',
      incumbent_coord_pref: 'ask-claimant',
      colliding_paths: ['src/x.ts']
    }
  };
} else if (tool === 'teamem.whoami') {
  response = {
    ok: true,
    data: { principal: 'alice', space_id: '01ULIDA', label: 'team-alpha' }
  };
} else if (tool === 'teamem.get_briefing') {
  process.exit(2);
} else {
  response = { ok: true, data: {} };
}
process.stdout.write(JSON.stringify(response));
process.exit(0);
`;
  writeFileSync(join(workdir, 'plugin/lib/bridge.js'), stub, { mode: 0o755 });
  return { sentinel };
}

function activate(workdir: string, sessionId: string) {
  const sd = join(workdir, 'plugin-data/sessions', sessionId);
  mkdirSync(sd, { recursive: true });
  writeFileSync(join(sd, 'active'), '');
}

describe('gate-claim.sh legacy ask-claimant routing', () => {
  it('queues as auto-skip and never requests edit permission', () => {
    const work = mkdtempSync(join(tmpdir(), 'teamem-legacy-ask-claimant-'));
    try {
      const { sentinel } = stage(work);
      gitInitWorkdir(work);
      const sessionId = 'sess-legacy-ask-claimant';
      activate(work, sessionId);

      const env: Record<string, string | undefined> = {
        ...process.env,
        CLAUDE_PLUGIN_ROOT: join(work, 'plugin'),
        CLAUDE_PLUGIN_DATA: join(work, 'plugin-data'),
        CLAUDE_SESSION_ID: sessionId
      };
      delete env.TEAMEM_HOOK_DISABLE;
      delete env.TEAMEM_MEMBER_NAME;

      const stdin = JSON.stringify({
        session_id: sessionId,
        tool_name: 'Edit',
        tool_input: { file_path: join(work, 'src/x.ts') },
        cwd: work
      });
      const r = spawnSync(
        'bash',
        [join(work, 'plugin/scripts/gate-claim.sh')],
        { env, input: stdin, encoding: 'utf-8', timeout: 15_000 }
      );
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('"permissionDecision":"deny"');

      const calls = readFileSync(sentinel, 'utf-8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as string[]);
      const toolNames = calls.map((c) => c[1]).filter(Boolean);
      expect(toolNames).toContain('teamem.claim_scope');
      expect(toolNames).toContain('teamem.get_briefing');
      expect(toolNames).toContain('teamem.queue_pending_edit');
      expect(toolNames).not.toContain('teamem.request_edit_permission');

      const queueCall = calls.find((c) => c[1] === 'teamem.queue_pending_edit');
      expect(queueCall).toBeDefined();
      const jsonIdx = queueCall!.indexOf('--json');
      const payload = JSON.parse(queueCall![jsonIdx + 1]) as Record<
        string,
        unknown
      >;
      expect(payload.blocking_claim_id).toBe('incumbent-claim-legacy-ask-1');
      expect(payload.intent).toContain('auto-skip');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 30_000);
});
