/**
 * Slice #32 — rename/delete release semantics integration tests.
 *
 * AC coverage:
 *  - rename (R): claim on old path releases; claim on new path also releases if held
 *  - delete (D): claim on deleted path releases even if porcelain lists the deletion
 *  - cherry-pick (no claim on destination branch): server returns {released:0}, no error, no spurious claim
 *  - no-op path (no active claim): returns {released:0, kept:0}
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import { createSqliteClient } from '../../../src/infra/db/sqlite-client.js';
import { SqliteEventStore } from '../../../src/infra/db/sqlite-event-store.js';
import { createTeamemTools } from '../../../src/server/tools/index.js';
import { runAllMigrations } from '../../helpers/migrations.js';
import type { Database } from 'bun:sqlite';

function setup(): {
  db: Database;
  tools: ReturnType<typeof createTeamemTools>;
} {
  const db = createSqliteClient(':memory:');
  runAllMigrations(db);
  const store = new SqliteEventStore(db);
  const tools = createTeamemTools({ db, store });
  return { db, tools };
}

const SPACE = 'space-rd-01';
const REPO = 'github.com/org/repo';
const BRANCH = 'feature/alice';
const ALICE = 'alice';
// codex-review task #4: SHAs must be 40 lowercase hex chars to satisfy
// evaluateRelease's syntactic-validity guard.
const HEAD_SHA_BEFORE = 'aaa1111111111111111111111111111111111111';
const HEAD_SHA_AFTER = 'bbb2222222222222222222222222222222222222';

function seedClaim(
  tools: ReturnType<typeof createTeamemTools>,
  path: string,
  principal = ALICE,
  headSha = HEAD_SHA_BEFORE
): string {
  const result = tools.claimScope({
    space_id: SPACE,
    principal,
    actor: principal,
    delegation: `${principal}->${principal}`,
    scope: { paths: [path] },
    repo_id: REPO,
    branch: BRANCH,
    current_head_sha: headSha,
    auto_release_mode: 'on_commit'
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`seed claim failed for ${path}`);
  return (result.data as { claim_id: string }).claim_id;
}

function claimStatus(db: Database, claimId: string): string {
  const row = db
    .prepare('SELECT status FROM claims WHERE claim_id = ?')
    .get(claimId) as { status: string } | null;
  return row?.status ?? 'not_found';
}

function hasEvent(db: Database, eventType: string, claimId: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM events WHERE event_type = ? AND payload_json LIKE ? LIMIT 1`
    )
    .get(eventType, `%${claimId}%`) as unknown;
  return row != null;
}

describe('release_scope_via_git rename/delete semantics (slice #32)', () => {
  let db: Database;
  let tools: ReturnType<typeof createTeamemTools>;

  beforeEach(() => {
    ({ db, tools } = setup());
  });

  it('rename: claim on old_path releases when R entry includes old_path', () => {
    const oldPath = 'src/Form.jsx';
    const newPath = 'src/NewForm.jsx';
    const claimId = seedClaim(tools, oldPath);

    const result = tools.releaseScopeViaGit({
      space_id: SPACE,
      principal: ALICE,
      actor: ALICE,
      delegation: `${ALICE}->${ALICE}`,
      repo_id: REPO,
      branch: BRANCH,
      paths_with_status: [{ status: 'R', path: newPath, old_path: oldPath }],
      current_head_sha: HEAD_SHA_AFTER,
      porcelain_dirty_paths: []
    });

    expect(result.ok).toBe(true);
    if (result.ok)
      expect((result.data as { released: number }).released).toBe(1);
    expect(claimStatus(db, claimId)).toBe('released');
    expect(hasEvent(db, 'scope_released_via_git', claimId)).toBe(true);
  });

  it('rename: claim on both old_path and new_path both release', () => {
    const oldPath = 'src/Form.jsx';
    const newPath = 'src/NewForm.jsx';
    const oldClaimId = seedClaim(tools, oldPath);
    const newClaimId = seedClaim(tools, newPath);

    const result = tools.releaseScopeViaGit({
      space_id: SPACE,
      principal: ALICE,
      actor: ALICE,
      delegation: `${ALICE}->${ALICE}`,
      repo_id: REPO,
      branch: BRANCH,
      paths_with_status: [{ status: 'R', path: newPath, old_path: oldPath }],
      current_head_sha: HEAD_SHA_AFTER,
      porcelain_dirty_paths: []
    });

    expect(result.ok).toBe(true);
    if (result.ok)
      expect((result.data as { released: number }).released).toBe(2);
    expect(claimStatus(db, oldClaimId)).toBe('released');
    expect(claimStatus(db, newClaimId)).toBe('released');
  });

  it('delete: claim on deleted path releases even when porcelain lists the deletion', () => {
    const path = 'src/Old.jsx';
    const claimId = seedClaim(tools, path);

    const result = tools.releaseScopeViaGit({
      space_id: SPACE,
      principal: ALICE,
      actor: ALICE,
      delegation: `${ALICE}->${ALICE}`,
      repo_id: REPO,
      branch: BRANCH,
      paths_with_status: [{ status: 'D', path }],
      current_head_sha: HEAD_SHA_AFTER,
      porcelain_dirty_paths: [path]
    });

    expect(result.ok).toBe(true);
    if (result.ok)
      expect((result.data as { released: number }).released).toBe(1);
    expect(claimStatus(db, claimId)).toBe('released');
  });

  it('cherry-pick: no claim on destination branch → released:0, no error, no spurious claim', () => {
    // Alice has a claim on feature/alice but NOT on feature/b
    seedClaim(tools, 'src/Form.jsx');

    const result = tools.releaseScopeViaGit({
      space_id: SPACE,
      principal: ALICE,
      actor: ALICE,
      delegation: `${ALICE}->${ALICE}`,
      repo_id: REPO,
      branch: 'feature/b', // different branch — no claim here
      paths_with_status: [{ status: 'M', path: 'src/Form.jsx' }],
      current_head_sha: HEAD_SHA_AFTER,
      porcelain_dirty_paths: []
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.data as { released: number }).released).toBe(0);
    }

    // Verify no spurious claim was created on feature/b
    const spurious = db
      .prepare(`SELECT COUNT(*) as cnt FROM claims WHERE branch = 'feature/b'`)
      .get() as { cnt: number };
    expect(spurious.cnt).toBe(0);
  });

  it('no-op: path with no active claim returns released:0, kept:0, no error', () => {
    const result = tools.releaseScopeViaGit({
      space_id: SPACE,
      principal: ALICE,
      actor: ALICE,
      delegation: `${ALICE}->${ALICE}`,
      repo_id: REPO,
      branch: BRANCH,
      paths_with_status: [{ status: 'M', path: 'src/Unclaimed.tsx' }],
      current_head_sha: HEAD_SHA_AFTER,
      porcelain_dirty_paths: []
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.data as { released: number; kept: number }).released).toBe(
        0
      );
      expect((result.data as { released: number; kept: number }).kept).toBe(0);
    }
  });

  it('codex-review task #10: concurrent post-commit releases on same branch (different principals) commit independently', async () => {
    const BOB = 'bob';
    const aliceClaim = seedClaim(tools, 'src/AliceFile.tsx', ALICE);
    const bobClaim = seedClaim(tools, 'src/BobFile.tsx', BOB);

    const release = (principal: string, path: string) =>
      Promise.resolve().then(() =>
        tools.releaseScopeViaGit({
          space_id: SPACE,
          principal,
          actor: principal,
          delegation: `${principal}->${principal}`,
          repo_id: REPO,
          branch: BRANCH,
          paths_with_status: [{ status: 'M', path }],
          current_head_sha: HEAD_SHA_AFTER,
          porcelain_dirty_paths: []
        })
      );

    const [aliceRes, bobRes] = await Promise.all([
      release(ALICE, 'src/AliceFile.tsx'),
      release(BOB, 'src/BobFile.tsx')
    ]);

    expect(aliceRes.ok).toBe(true);
    expect(bobRes.ok).toBe(true);
    expect(claimStatus(db, aliceClaim)).toBe('released');
    expect(claimStatus(db, bobClaim)).toBe('released');
    expect(hasEvent(db, 'scope_released_via_git', aliceClaim)).toBe(true);
    expect(hasEvent(db, 'scope_released_via_git', bobClaim)).toBe(true);

    const aliceEventCount = db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM events WHERE event_type = 'scope_released_via_git' AND payload_json LIKE ?`
      )
      .get(`%${aliceClaim}%`) as { cnt: number };
    const bobEventCount = db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM events WHERE event_type = 'scope_released_via_git' AND payload_json LIKE ?`
      )
      .get(`%${bobClaim}%`) as { cnt: number };
    expect(aliceEventCount.cnt).toBe(1);
    expect(bobEventCount.cnt).toBe(1);
  });

  it('OMC review: multi-path claim releases when commit touches paths[1+] (json_each lookup)', () => {
    // Prior bug: projection.path stored only paths[0], so a release_scope_via_git
    // call referencing paths[1+] of a multi-path claim missed the WHERE filter
    // and returned released:0 even though the commit legitimately touched a
    // claimed path. Fix: WHERE clause uses json_each on scope_json.paths.
    const claimResult = tools.claimScope({
      space_id: SPACE,
      principal: ALICE,
      actor: ALICE,
      delegation: `${ALICE}->${ALICE}`,
      scope: { paths: ['src/Multi.tsx', 'src/Helper.ts', 'src/Util.ts'] },
      repo_id: REPO,
      branch: BRANCH,
      current_head_sha: HEAD_SHA_BEFORE,
      auto_release_mode: 'on_commit'
    });
    expect(claimResult.ok).toBe(true);
    if (!claimResult.ok) throw new Error('multi-path seed failed');
    const claimId = (claimResult.data as { claim_id: string }).claim_id;

    // Commit modifies the SECOND path in the claim's paths array.
    const releaseResult = tools.releaseScopeViaGit({
      space_id: SPACE,
      principal: ALICE,
      actor: ALICE,
      delegation: `${ALICE}->${ALICE}`,
      repo_id: REPO,
      branch: BRANCH,
      paths_with_status: [{ status: 'M', path: 'src/Helper.ts' }],
      current_head_sha: HEAD_SHA_AFTER,
      porcelain_dirty_paths: []
    });
    expect(releaseResult.ok).toBe(true);
    if (releaseResult.ok) {
      expect((releaseResult.data as { released: number }).released).toBe(1);
    }
    expect(claimStatus(db, claimId)).toBe('released');
    expect(hasEvent(db, 'scope_released_via_git', claimId)).toBe(true);
  });
});
