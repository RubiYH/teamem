/**
 * Codex F17 regression — gate-claim's session-scoped claim cache must be
 * SPACE-AWARE.
 *
 * Pre-#22 cache entries were keyed only on `(session_id, path)`. After
 * SessionStart/teamem-flag activation rewrote `${SESSION_DIR}/space`, the
 * local cache could treat a path claimed in space-A as safe in space-B. The
 * Stop hook similarly tried to release space-A's claim_id against whatever
 * space was currently resolved, releasing nothing.
 *
 * This test stages a fake plugin install and:
 *   1. Pins the session to space-A, claims `src/x.ts`. Asserts cache write
 *      includes `space: "space-A"`.
 *   2. Re-pins the session to space-B (overwriting `${SESSION_DIR}/space`).
 *      Re-runs gate-claim against `src/x.ts`. Asserts the gate calls
 *      `claim_scope` AGAIN (cache miss because `entry.space !== space-B`).
 *   3. Stop-hook release: with cache holding both space-A and space-B
 *      entries, asserts the release call is made with the cached space,
 *      not the currently-resolved one.
 */
import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  copyFileSync,
  chmodSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { marketplaceEnv } from '../helpers/marketplace-env.js';

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
  copyFileSync(
    join(REPO_ROOT, 'plugin/scripts/release-claims.sh'),
    join(workdir, 'plugin/scripts/release-claims.sh')
  );
  chmodSync(join(workdir, 'plugin/scripts/gate-claim.sh'), 0o755);
  chmodSync(join(workdir, 'plugin/scripts/release-claims.sh'), 0o755);

  const sentinel = join(workdir, 'argv.log');
  // Stub bridge: every claim_scope returns a fresh claim_id, every
  // release_scope returns ok. Cache writes persist space metadata for
  // diagnostics and legacy Stop-hook behavior.
  const stub = `#!/usr/bin/env bun
import { appendFileSync } from 'node:fs';
const argv = process.argv.slice(2);
appendFileSync(${JSON.stringify(sentinel)}, JSON.stringify(argv) + '\\n');

const tool = argv[1];
let response;
if (tool === 'teamem.claim_scope') {
  // Vary claim_id by space so we can later prove releases use the
  // claim_id minted in the original space.
  const spaceIdx = argv.indexOf('--space');
  const space = spaceIdx >= 0 ? argv[spaceIdx + 1] : 'no-space';
  response = {
    ok: true,
    data: {
      claim_id: 'claim-' + space,
      expires_at: new Date(Date.now() + 600_000).toISOString()
    }
  };
} else if (tool === 'teamem.release_scope') {
  response = { ok: true, data: { ok: true } };
} else {
  response = { ok: true, data: {} };
}
process.stdout.write(JSON.stringify(response));
process.exit(0);
`;
  writeFileSync(join(workdir, 'plugin/lib/bridge.js'), stub, { mode: 0o755 });
  return { sentinel };
}

function activate(workdir: string, sessionId: string, space: string) {
  const sd = join(workdir, 'plugin-data/sessions', sessionId);
  mkdirSync(sd, { recursive: true });
  writeFileSync(join(sd, 'active'), '');
  writeFileSync(join(sd, 'space'), space);
  return sd;
}

function runGate(
  workdir: string,
  sessionId: string,
  filePath: string
): { status: number | null; stdout: string } {
  const env = marketplaceEnv({
    CLAUDE_PLUGIN_ROOT: join(workdir, 'plugin'),
    CLAUDE_PLUGIN_DATA: join(workdir, 'plugin-data'),
    CLAUDE_SESSION_ID: sessionId,
    HOME: join(workdir, 'home')
  });
  const stdin = JSON.stringify({
    session_id: sessionId,
    tool_name: 'Edit',
    tool_input: { file_path: filePath },
    cwd: workdir
  });
  const r = spawnSync('bash', [join(workdir, 'plugin/scripts/gate-claim.sh')], {
    env,
    input: stdin,
    encoding: 'utf-8',
    timeout: 15_000
  });
  return { status: r.status, stdout: r.stdout || '' };
}

function runStop(
  workdir: string,
  sessionId: string
): { status: number | null; stdout: string } {
  const env = marketplaceEnv({
    CLAUDE_PLUGIN_ROOT: join(workdir, 'plugin'),
    CLAUDE_PLUGIN_DATA: join(workdir, 'plugin-data'),
    CLAUDE_SESSION_ID: sessionId,
    HOME: join(workdir, 'home')
  });
  const stdin = JSON.stringify({ session_id: sessionId });
  const r = spawnSync(
    'bash',
    [join(workdir, 'plugin/scripts/release-claims.sh')],
    { env, input: stdin, encoding: 'utf-8', timeout: 15_000 }
  );
  return { status: r.status, stdout: r.stdout || '' };
}

describe('gate-claim cache is space-aware (Codex F17)', () => {
  it('after session space pin switches from space-A to space-B, gate calls claim_scope again (cache invalidated by space mismatch)', () => {
    const work = mkdtempSync(join(tmpdir(), 'teamem-f17-'));
    try {
      const { sentinel } = stage(work);
      gitInitWorkdir(work);
      const sessionId = 'sess-f17-switch';
      activate(work, sessionId, 'space-A');
      const filePath = join(work, 'src/x.ts');

      // 1. Claim x.ts in space-A.
      const r1 = runGate(work, sessionId, filePath);
      expect(r1.status).toBe(0);

      // 2. Switch to space-B by rewriting ${SESSION_DIR}/space.
      writeFileSync(
        join(work, 'plugin-data/sessions', sessionId, 'space'),
        'space-B'
      );

      // 3. Try to claim x.ts again under space-B.
      const r2 = runGate(work, sessionId, filePath);
      expect(r2.status).toBe(0);

      const calls = readFileSync(sentinel, 'utf-8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as string[]);
      const claimCalls = calls.filter((c) => c[1] === 'teamem.claim_scope');
      // F17 fix: claim_scope MUST be called again under space-B. Pre-#22
      // behavior returned without ever hitting the bridge.
      expect(claimCalls.length).toBe(2);

      // First call carried `--space space-A`.
      const sIdx1 = claimCalls[0].indexOf('--space');
      expect(claimCalls[0][sIdx1 + 1]).toBe('space-A');

      // Second call carried `--space space-B`.
      const sIdx2 = claimCalls[1].indexOf('--space');
      expect(claimCalls[1][sIdx2 + 1]).toBe('space-B');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 30_000);

  it('Stop hook is a no-op — does NOT call release_scope (claims survive turn end, slice #28)', () => {
    const work = mkdtempSync(join(tmpdir(), 'teamem-f17-stop-'));
    try {
      const { sentinel } = stage(work);
      gitInitWorkdir(work);
      const sessionId = 'sess-f17-stop';
      activate(work, sessionId, 'space-A');

      // Claim a path in space-A.
      runGate(work, sessionId, join(work, 'src/x.ts'));

      // Switch to space-B before running the Stop hook (regression: old
      // code would release space-A's claim; new code releases nothing).
      writeFileSync(
        join(work, 'plugin-data/sessions', sessionId, 'space'),
        'space-B'
      );

      runStop(work, sessionId);

      const calls = readFileSync(sentinel, 'utf-8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as string[]);

      // Stop hook must NOT invoke release_scope — claims survive turn end.
      const releaseCalls = calls.filter((c) => c[1] === 'teamem.release_scope');
      expect(releaseCalls.length).toBe(0);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 30_000);

  it('same-space edits revalidate with the server instead of trusting stale local cache', () => {
    const work = mkdtempSync(join(tmpdir(), 'teamem-f17-hit-'));
    try {
      const { sentinel } = stage(work);
      gitInitWorkdir(work);
      const sessionId = 'sess-f17-hit';
      activate(work, sessionId, 'space-A');

      const filePath = join(work, 'src/y.ts');
      runGate(work, sessionId, filePath);
      runGate(work, sessionId, filePath);

      const calls = readFileSync(sentinel, 'utf-8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as string[]);
      const claimCalls = calls.filter((c) => c[1] === 'teamem.claim_scope');
      // A prior on_commit claim may have been released by post-commit, or
      // force-released by a teammate, while this session still has a local
      // cache entry. Revalidate every edit so a newly acquired peer claim
      // cannot be bypassed by stale local state.
      expect(claimCalls.length).toBe(2);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 30_000);

  it('same-space stale cache does not hide a later peer conflict', () => {
    const work = mkdtempSync(join(tmpdir(), 'teamem-stale-cache-conflict-'));
    try {
      const { sentinel } = stage(work);
      const stateFile = join(work, 'claim-count.txt');
      writeFileSync(
        join(work, 'plugin/lib/bridge.js'),
        `#!/usr/bin/env bun
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const argv = process.argv.slice(2);
appendFileSync(${JSON.stringify(sentinel)}, JSON.stringify(argv) + '\\n');
const tool = argv[1];
if (tool === 'teamem.claim_scope') {
  let count = 0;
  try { count = Number(readFileSync(${JSON.stringify(stateFile)}, 'utf8')) || 0; } catch {}
  count += 1;
  writeFileSync(${JSON.stringify(stateFile)}, String(count));
  if (count === 1) {
    process.stdout.write(JSON.stringify({ ok: true, data: { claim_id: 'claim-bob-old', expires_at: null } }));
  } else {
    process.stdout.write(JSON.stringify({
      ok: false,
      error: {
        code: 'scope_conflict',
        message: 'Scope conflicts with active claim claim-alice-new held by alice',
        conflicting_claim_id: 'claim-alice-new',
        conflicting_principal: 'alice',
        colliding_paths: ['src/z.ts']
      }
    }));
  }
} else if (tool === 'teamem.agent_focus_changed') {
  process.stdout.write(JSON.stringify({ ok: true, data: {} }));
} else if (tool === 'teamem.get_briefing') {
  process.stdout.write(JSON.stringify({ ok: true, data: { recent_joins: [] } }));
} else if (tool === 'teamem.queue_pending_edit') {
  process.stdout.write(JSON.stringify({ ok: true, data: {} }));
} else {
  process.stdout.write(JSON.stringify({ ok: true, data: {} }));
}
`
      );
      chmodSync(join(work, 'plugin/lib/bridge.js'), 0o755);

      gitInitWorkdir(work);
      const sessionId = 'sess-stale-conflict';
      activate(work, sessionId, 'space-A');

      const filePath = join(work, 'src/z.ts');
      const first = runGate(work, sessionId, filePath);
      const second = runGate(work, sessionId, filePath);

      expect(first.stdout).not.toContain('"permissionDecision":"deny"');
      expect(second.stdout).toContain('"permissionDecision":"deny"');
      expect(second.stdout).toContain('alice holds');
      expect(second.stdout).toContain('claim-alice-new');

      const calls = readFileSync(sentinel, 'utf-8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as string[]);
      const claimCalls = calls.filter((c) => c[1] === 'teamem.claim_scope');
      expect(claimCalls.length).toBe(2);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 30_000);

  it('force-release then peer reclaim still denies the original holder', () => {
    const work = mkdtempSync(join(tmpdir(), 'teamem-peer-reclaim-'));
    try {
      const { sentinel } = stage(work);
      const stateFile = join(work, 'claim-count.txt');
      writeFileSync(
        join(work, 'plugin/lib/bridge.js'),
        `#!/usr/bin/env bun
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const argv = process.argv.slice(2);
appendFileSync(${JSON.stringify(sentinel)}, JSON.stringify(argv) + '\\n');
const tool = argv[1];
if (tool === 'teamem.claim_scope') {
  let count = 0;
  try { count = Number(readFileSync(${JSON.stringify(stateFile)}, 'utf8')) || 0; } catch {}
  count += 1;
  writeFileSync(${JSON.stringify(stateFile)}, String(count));
  if (count === 1) {
    // Bob's original edit before Alice force-released him.
    process.stdout.write(JSON.stringify({ ok: true, data: { claim_id: 'claim-bob-before-force-release', expires_at: null } }));
  } else {
    // Alice force-released Bob, edited immediately, and now owns the path.
    process.stdout.write(JSON.stringify({
      ok: false,
      error: {
        code: 'scope_conflict',
        message: 'Scope conflicts with active claim claim-alice-after-force-release held by alice',
        conflicting_claim_id: 'claim-alice-after-force-release',
        conflicting_principal: 'alice',
        colliding_paths: ['src/components/Todo.jsx']
      }
    }));
  }
} else if (tool === 'teamem.agent_focus_changed') {
  process.stdout.write(JSON.stringify({ ok: true, data: {} }));
} else if (tool === 'teamem.get_briefing') {
  process.stdout.write(JSON.stringify({ ok: true, data: { recent_joins: [] } }));
} else if (tool === 'teamem.queue_pending_edit') {
  process.stdout.write(JSON.stringify({ ok: true, data: {} }));
} else {
  process.stdout.write(JSON.stringify({ ok: true, data: {} }));
}
`
      );
      chmodSync(join(work, 'plugin/lib/bridge.js'), 0o755);

      gitInitWorkdir(work);
      const sessionId = 'sess-force-release-reclaim';
      activate(work, sessionId, 'space-A');

      const filePath = join(work, 'src/components/Todo.jsx');
      const beforeForceRelease = runGate(work, sessionId, filePath);
      const afterAliceReclaim = runGate(work, sessionId, filePath);

      expect(beforeForceRelease.stdout).not.toContain(
        '"permissionDecision":"deny"'
      );
      expect(afterAliceReclaim.stdout).toContain('"permissionDecision":"deny"');
      expect(afterAliceReclaim.stdout).toContain('alice holds');
      expect(afterAliceReclaim.stdout).toContain(
        'claim-alice-after-force-release'
      );

      const calls = readFileSync(sentinel, 'utf-8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as string[]);
      const claimCalls = calls.filter((c) => c[1] === 'teamem.claim_scope');
      expect(claimCalls.length).toBe(2);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 30_000);
});
