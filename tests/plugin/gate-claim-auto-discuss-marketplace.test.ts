/**
 * Compatibility regression — gate-claim.sh must degrade stale
 * `auto-discuss` conflicts to `teamem.queue_pending_edit` WITHOUT relying on
 * the `TEAMEM_MEMBER_NAME`
 * env var (which production marketplace installs do not set).
 *
 * Pre-#22 the gate's coord-pref resolver looked the caller up via
 * `process.env.TEAMEM_MEMBER_NAME`. The plugin manifest only exports
 * `TEAMEM_SPACE`. Without the member name the resolver always returned
 * `auto-skip`, and the compatibility fallback would have missed the
 * caller's stored preference in production.
 *
 * The F15 regression test "passed" by setting `TEAMEM_MEMBER_NAME='alice'`
 * explicitly. This test is the F15 scenario MINUS that injection — using
 * the new `marketplaceEnv()` helper that strips every TEAMEM_* var the
 * production install never sets.
 *
 * Assertions:
 *   1. Gate calls `teamem.whoami` (server-authoritative principal lookup).
 *   2. Gate calls `teamem.queue_pending_edit` with the conflict's blocking_claim_id.
 *   3. The deny advisory explains that auto-discuss automation is postponed.
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
import {
  marketplaceEnv,
  assertMarketplaceEnv
} from '../helpers/marketplace-env.js';

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
  // Stub bridge: branches on the requested tool name. Returns:
  //   - claim_scope          → scope_conflict (drives the deny branch)
  //   - whoami               → ok with principal=alice (server-authoritative)
  //   - get_briefing         → both alice + bob with coord_pref=auto-discuss
  //   - queue_pending_edit   → ok
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
      conflicting_claim_id: 'incumbent-claim-marketplace',
      conflicting_principal: 'bob',
      colliding_paths: ['src/x.ts']
    }
  };
} else if (tool === 'teamem.whoami') {
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

describe('gate-claim.sh auto-discuss compatibility fallback under marketplace env', () => {
  it('uses teamem.whoami (no TEAMEM_MEMBER_NAME) and queues work instead of opening a dispute', () => {
    const work = mkdtempSync(join(tmpdir(), 'teamem-f18-'));
    try {
      const { sentinel } = stage(work);
      gitInitWorkdir(work);
      const sessionId = 'sess-f18';
      activate(work, sessionId);

      const env = marketplaceEnv({
        CLAUDE_PLUGIN_ROOT: join(work, 'plugin'),
        CLAUDE_PLUGIN_DATA: join(work, 'plugin-data'),
        CLAUDE_SESSION_ID: sessionId
        // Notably absent: TEAMEM_MEMBER_NAME, TEAMEM_SPACE — production
        // marketplace installs do not set either.
      });
      // Smoke: assert the env helper actually stripped what it should.
      assertMarketplaceEnv(env);
      expect(env.TEAMEM_MEMBER_NAME).toBeUndefined();
      expect(env.TEAMEM_SPACE).toBeUndefined();

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
      const denyOutput = r.stdout || '';
      expect(denyOutput).toContain('"permissionDecision":"deny"');
      expect(denyOutput).toContain('auto-discuss automation is postponed');
      expect(denyOutput).toContain('auto-discuss');

      const calls = readFileSync(sentinel, 'utf-8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as string[]);
      const toolNames = calls.map((c) => c[1]).filter(Boolean);

      // F18: the gate must hit `teamem.whoami` to derive the caller's
      // principal — no env-var crutch.
      expect(toolNames).toContain('teamem.whoami');
      expect(toolNames).toContain('teamem.queue_pending_edit');
      expect(toolNames).not.toContain('teamem.open_dispute');

      // The queued payload references the conflict's blocking_claim_id.
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
      expect(payload.blocking_claim_id).toBe('incumbent-claim-marketplace');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 30_000);

  it('caches the whoami result per session (subsequent gate-claim invocations skip the round-trip)', () => {
    // Exercises the `${SESSION_DIR}/whoami` cache: two consecutive
    // gate-claim invocations against the same session should result in
    // exactly ONE `teamem.whoami` call from the second pass (the first
    // primes the cache; both should still queue work).
    const work = mkdtempSync(join(tmpdir(), 'teamem-f18-cache-'));
    try {
      const { sentinel } = stage(work);
      gitInitWorkdir(work);
      const sessionId = 'sess-f18-cache';
      activate(work, sessionId);

      const env = marketplaceEnv({
        CLAUDE_PLUGIN_ROOT: join(work, 'plugin'),
        CLAUDE_PLUGIN_DATA: join(work, 'plugin-data'),
        CLAUDE_SESSION_ID: sessionId
      });

      const buildStdin = (path: string) =>
        JSON.stringify({
          session_id: sessionId,
          tool_name: 'Edit',
          tool_input: { file_path: join(work, path) },
          cwd: work
        });

      // First invocation primes the whoami cache.
      const r1 = spawnSync(
        'bash',
        [join(work, 'plugin/scripts/gate-claim.sh')],
        {
          env,
          input: buildStdin('src/a.ts'),
          encoding: 'utf-8',
          timeout: 15_000
        }
      );
      expect(r1.status).toBe(0);

      // Second invocation should reuse the cache.
      const r2 = spawnSync(
        'bash',
        [join(work, 'plugin/scripts/gate-claim.sh')],
        {
          env,
          input: buildStdin('src/b.ts'),
          encoding: 'utf-8',
          timeout: 15_000
        }
      );
      expect(r2.status).toBe(0);

      const calls = readFileSync(sentinel, 'utf-8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as string[]);
      const whoamiCount = calls.filter((c) => c[1] === 'teamem.whoami').length;
      // Cache should keep the count at 1 — the second call reuses the
      // cached principal.
      expect(whoamiCount).toBe(1);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 30_000);
});
