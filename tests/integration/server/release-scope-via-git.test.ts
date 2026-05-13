import { describe, it, expect, beforeEach } from 'bun:test';
import { runAllMigrations } from '../../helpers/migrations.js';
import { createSqliteClient } from '../../../src/infra/db/sqlite-client.js';
import { SqliteEventStore } from '../../../src/infra/db/sqlite-event-store.js';
import { createTeamemTools } from '../../../src/server/tools/index.js';
import { resetRateLimitBuckets } from '../../../src/server/rate-limit.js';

const TEST_SPACE = 'space-release-git-test';
const REPO_ID = 'github.com/org/repo';
const BRANCH = 'main';
// codex-review task #4: SHAs must be 40 lowercase hex chars to satisfy
// evaluateRelease's syntactic-validity guard.
const HEAD_SHA_ACQUIRE = '0000000000000000000000000000000000000000';
const HEAD_SHA_NEW = '1111111111111111111111111111111111111111';

function buildTestDb() {
  const db = createSqliteClient(':memory:');
  runAllMigrations(db);
  return db;
}

function seedActiveClaim(
  tools: ReturnType<typeof createTeamemTools>,
  db: ReturnType<typeof createSqliteClient>,
  path: string,
  principal = 'alice'
) {
  const result = tools.claimScope({
    space_id: TEST_SPACE,
    principal,
    actor: principal,
    delegation: `${principal}->${principal}`,
    scope: { paths: [path] },
    repo_id: REPO_ID,
    branch: BRANCH,
    current_head_sha: HEAD_SHA_ACQUIRE,
    auto_release_mode: 'on_commit'
  });
  if (!result.ok)
    throw new Error(`claimScope failed: ${JSON.stringify(result)}`);

  // Manually update head_sha_at_acquire and path on the claim row (set by apply-event)
  // The path column is set via apply-event from payload.path
  return result.data.claim_id;
}

beforeEach(() => {
  resetRateLimitBuckets();
});

describe('releaseScopeViaGit', () => {
  it('releases claim when HEAD advanced + working tree clean + branch matches', () => {
    const db = buildTestDb();
    const store = new SqliteEventStore(db);
    const tools = createTeamemTools({ db, store });

    const claimId = seedActiveClaim(tools, db, 'src/Form.tsx');

    const result = tools.releaseScopeViaGit({
      space_id: TEST_SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      repo_id: REPO_ID,
      branch: BRANCH,
      paths_with_status: [{ status: 'M', path: 'src/Form.tsx' }],
      current_head_sha: HEAD_SHA_NEW,
      porcelain_dirty_paths: []
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.released).toBe(1);
    expect(result.data.kept).toBe(0);

    // Check projection updated
    const row = db
      .query(`SELECT status FROM claims WHERE claim_id = ?1`)
      .get(claimId) as { status: string } | null;
    expect(row?.status).toBe('released');

    // Check event emitted
    const event = db
      .query(
        `SELECT event_type FROM events WHERE event_type = 'scope_released_via_git'`
      )
      .get() as { event_type: string } | null;
    expect(event?.event_type).toBe('scope_released_via_git');
  });

  it('is a no-op for paths with no matching active claim', () => {
    const db = buildTestDb();
    const store = new SqliteEventStore(db);
    const tools = createTeamemTools({ db, store });

    const result = tools.releaseScopeViaGit({
      space_id: TEST_SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      repo_id: REPO_ID,
      branch: BRANCH,
      paths_with_status: [{ status: 'M', path: 'src/Unclaimed.tsx' }],
      current_head_sha: HEAD_SHA_NEW,
      porcelain_dirty_paths: []
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.released).toBe(0);
  });

  it('WIP commit: porcelain dirty keeps claim active', () => {
    const db = buildTestDb();
    const store = new SqliteEventStore(db);
    const tools = createTeamemTools({ db, store });

    const claimId = seedActiveClaim(tools, db, 'src/WIP.tsx');

    const result = tools.releaseScopeViaGit({
      space_id: TEST_SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      repo_id: REPO_ID,
      branch: BRANCH,
      paths_with_status: [{ status: 'M', path: 'src/WIP.tsx' }],
      current_head_sha: HEAD_SHA_NEW,
      porcelain_dirty_paths: ['src/WIP.tsx']
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.released).toBe(0);
    expect(result.data.kept).toBe(1);

    const row = db
      .query(`SELECT status FROM claims WHERE claim_id = ?1`)
      .get(claimId) as { status: string } | null;
    expect(row?.status).toBe('active');
  });

  it('both event and projection update happen atomically', () => {
    const db = buildTestDb();
    const store = new SqliteEventStore(db);
    const tools = createTeamemTools({ db, store });

    const claimId = seedActiveClaim(tools, db, 'src/Atomic.tsx');

    tools.releaseScopeViaGit({
      space_id: TEST_SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      repo_id: REPO_ID,
      branch: BRANCH,
      paths_with_status: [{ status: 'A', path: 'src/Atomic.tsx' }],
      current_head_sha: HEAD_SHA_NEW,
      porcelain_dirty_paths: []
    });

    const claimRow = db
      .query(`SELECT status FROM claims WHERE claim_id = ?1`)
      .get(claimId) as { status: string } | null;
    const eventRow = db
      .query(
        `SELECT event_type FROM events WHERE event_type = 'scope_released_via_git' LIMIT 1`
      )
      .get() as { event_type: string } | null;

    // Both must be visible (atomicity invariant)
    expect(claimRow?.status).toBe('released');
    expect(eventRow?.event_type).toBe('scope_released_via_git');
  });

  it('validation: missing repo_id returns error', () => {
    const db = buildTestDb();
    const store = new SqliteEventStore(db);
    const tools = createTeamemTools({ db, store });

    const result = tools.releaseScopeViaGit({
      space_id: TEST_SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      repo_id: '',
      branch: BRANCH,
      paths_with_status: [],
      current_head_sha: HEAD_SHA_NEW,
      porcelain_dirty_paths: []
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_PAYLOAD');
    }
  });
});
