/**
 * Compatibility regression — gate-claim.sh must no longer invoke
 * `teamem.open_dispute` when the resolved coord-pref is `auto-discuss`.
 *
 * Watcher/negotiator subagents are postponed in the current plugin
 * build. A stale or legacy `auto-discuss` preference must degrade to the
 * same queued path as `auto-skip`, not open a dispute with no active
 * runtime to advance it.
 *
 * This test stages a fake plugin install with a stub `lib/bridge.js` that
 * returns:
 *   - `claim_scope`           → `scope_conflict` (drives the deny branch)
 *   - `get_briefing`          → both alice + bob with coord_pref=auto-discuss
 *   - `queue_pending_edit`    → success
 * and asserts gate-claim invokes `teamem.queue_pending_edit` with the
 * blocking_claim_id in the JSON payload, while the deny advisory explains
 * that auto-discuss automation is postponed.
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
  readFileSync
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
  // Stub bridge that branches on the requested tool name.
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
      conflicting_claim_id: 'incumbent-claim-1',
      conflicting_principal: 'bob',
      colliding_paths: ['src/x.ts']
    }
  };
} else if (tool === 'teamem.whoami') {
  // Codex F18 — gate-claim now derives the caller principal via
  // teamem.whoami instead of process.env.TEAMEM_MEMBER_NAME. Stub
  // returns alice so the resolver finds her in recent_joins below.
  response = {
    ok: true,
    data: { principal: 'alice', space_id: '01ULIDA', label: 'team-alpha' }
  };
} else if (tool === 'teamem.get_briefing') {
  response = {
    ok: true,
    data: {
      current_plan: null,
      active_claims: [],
      recent_decisions: [],
      active_risks: { open_blockers: [], standing_conflicts: [] },
      recent_progress: [],
      recent_findings: [],
      recent_joins: [
        { member_name: 'alice', joined_at: '2026-05-04T00:00:00Z', is_creator: true,  coord_pref: 'auto-discuss' },
        { member_name: 'bob',   joined_at: '2026-05-04T00:01:00Z', is_creator: false, coord_pref: 'auto-discuss' }
      ],
      meta: { token_estimate: 0, cursor: null, lag_seconds: null, heuristic_trust: 'unverified' }
    }
  };
} else if (tool === 'teamem.queue_pending_edit') {
  response = { ok: true, data: { queued: true } };
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

describe('gate-claim.sh auto-discuss compatibility fallback', () => {
  it('queues work instead of opening a dispute when both parties prefer auto-discuss', () => {
    const work = mkdtempSync(join(tmpdir(), 'teamem-autodiscuss-'));
    try {
      const { sentinel } = stage(work);
      gitInitWorkdir(work);
      const sessionId = 'sess-autodiscuss';
      activate(work, sessionId);

      const env: Record<string, string | undefined> = {
        ...process.env,
        CLAUDE_PLUGIN_ROOT: join(work, 'plugin'),
        CLAUDE_PLUGIN_DATA: join(work, 'plugin-data'),
        CLAUDE_SESSION_ID: sessionId,
        // Inline `myName` heuristic in gate-claim's resolver reads
        // TEAMEM_MEMBER_NAME — set it so resolveCoordMode finds the
        // caller's coord_pref in the briefing's recent_joins.
        TEAMEM_MEMBER_NAME: 'alice'
      };
      delete env.TEAMEM_HOOK_DISABLE;

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
      // Hook emits the deny JSON for Claude Code to act on.
      const denyOutput = r.stdout || '';
      expect(denyOutput).toContain('"permissionDecision":"deny"');
      expect(denyOutput).toContain('auto-discuss automation is postponed');
      expect(denyOutput).toContain('auto-discuss');

      // Bridge invocations: must queue work and must not open a dispute.
      const calls = readFileSync(sentinel, 'utf-8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as string[]);
      const toolNames = calls.map((c) => c[1]).filter(Boolean);
      expect(toolNames).toContain('teamem.claim_scope');
      expect(toolNames).toContain('teamem.get_briefing');
      expect(toolNames).toContain('teamem.queue_pending_edit');
      expect(toolNames).not.toContain('teamem.open_dispute');

      // The queue_pending_edit call's --json payload contains the
      // blocking_claim_id from the conflict response.
      const queuedCall = calls.find(
        (c) => c[1] === 'teamem.queue_pending_edit'
      );
      expect(queuedCall).toBeDefined();
      const jsonIdx = queuedCall!.indexOf('--json');
      expect(jsonIdx).toBeGreaterThan(-1);
      const payload = JSON.parse(queuedCall![jsonIdx + 1]) as Record<
        string,
        unknown
      >;
      expect(payload.blocking_claim_id).toBe('incumbent-claim-1');
      expect(payload.intent).toContain('postponed');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 30_000);
});
