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
  db.exec(
    `INSERT INTO spaces (id, label, creator_member_id, created_at)
     VALUES ('${TEST_SPACE}', 'Release Git Space', 'm-alice', '2026-05-27T00:00:00.000Z')`
  );
  db.exec(
    `INSERT INTO members (id, space_id, name, joined_at, is_creator)
     VALUES
       ('m-alice', '${TEST_SPACE}', 'alice', '2026-05-27T00:00:00.000Z', 1),
       ('m-bob', '${TEST_SPACE}', 'bob', '2026-05-27T00:00:01.000Z', 0),
       ('m-carol', '${TEST_SPACE}', 'carol', '2026-05-27T00:00:02.000Z', 0),
       ('m-dana', '${TEST_SPACE}', 'dana', '2026-05-27T00:00:03.000Z', 0)`
  );
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

function storedReleaseEvents(db: ReturnType<typeof createSqliteClient>) {
  return db
    .query(
      `SELECT raw_json
         FROM events
        WHERE event_type = 'scope_released_via_git'
        ORDER BY event_id ASC`
    )
    .all()
    .map((row) => JSON.parse((row as { raw_json: string }).raw_json));
}

function eventIdsFor(
  tools: ReturnType<typeof createTeamemTools>,
  principal: string
): string[] {
  const updates = tools.getUpdates({ space_id: TEST_SPACE, principal });
  expect(updates.ok).toBe(true);
  if (!updates.ok) return [];
  return updates.data.events.map((event) => event.event_id);
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

  it('releases matching Space and Sprint claims for one owner/path using each stored claim context', () => {
    const db = buildTestDb();
    const store = new SqliteEventStore(db);
    const tools = createTeamemTools({ db, store });

    const spaceClaimId = seedActiveClaim(tools, db, 'src/Mixed.tsx');
    const sprint = tools.createSprint({
      space_id: TEST_SPACE,
      principal: 'alice',
      display_name: 'Release Sprint',
      goal: 'Route git releases by claim context'
    });
    expect(sprint.ok).toBe(true);
    if (!sprint.ok) return;
    const sprintId = sprint.data.sprint?.sprint_id ?? null;
    expect(sprintId).toBeTruthy();
    tools.joinSprint({
      space_id: TEST_SPACE,
      principal: 'bob',
      sprint: 'release-sprint'
    });
    tools.createSprint({
      space_id: TEST_SPACE,
      principal: 'carol',
      display_name: 'Other Sprint',
      goal: 'Should not receive release noise'
    });
    const sprintClaimId = seedActiveClaim(tools, db, 'src/Mixed.tsx');

    const result = tools.releaseScopeViaGit({
      space_id: TEST_SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      repo_id: REPO_ID,
      branch: BRANCH,
      paths_with_status: [{ status: 'M', path: 'src/Mixed.tsx' }],
      current_head_sha: HEAD_SHA_NEW,
      porcelain_dirty_paths: []
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({ released: 2, kept: 0 });

    const claimRows = db
      .query(
        `SELECT claim_id, status
           FROM claims
          WHERE claim_id IN (?1, ?2)
          ORDER BY claim_id ASC`
      )
      .all(spaceClaimId, sprintClaimId) as Array<{
      claim_id: string;
      status: string;
    }>;
    expect(claimRows.map((row) => row.status)).toEqual([
      'released',
      'released'
    ]);

    const events = storedReleaseEvents(db);
    expect(events).toHaveLength(2);
    const byClaimId = new Map(
      events.map((event) => [event.payload.claim_id, event])
    );
    expect(byClaimId.get(spaceClaimId)).toMatchObject({
      sprint_id: null,
      delivery_scope: 'space',
      payload: { claim_id: spaceClaimId }
    });
    expect(byClaimId.get(sprintClaimId)).toMatchObject({
      sprint_id: sprintId,
      delivery_scope: 'sprint',
      payload: { claim_id: sprintClaimId }
    });

    const spaceEventId = byClaimId.get(spaceClaimId).event_id;
    const sprintEventId = byClaimId.get(sprintClaimId).event_id;
    expect(eventIdsFor(tools, 'bob')).toContain(sprintEventId);
    expect(eventIdsFor(tools, 'bob')).not.toContain(spaceEventId);
    expect(eventIdsFor(tools, 'dana')).toContain(spaceEventId);
    expect(eventIdsFor(tools, 'dana')).not.toContain(sprintEventId);
    expect(eventIdsFor(tools, 'carol')).not.toContain(sprintEventId);
    expect(eventIdsFor(tools, 'carol')).not.toContain(spaceEventId);
  });

  it('dedupes multi-path matches so one claim releases only once per commit', () => {
    const db = buildTestDb();
    const store = new SqliteEventStore(db);
    const tools = createTeamemTools({ db, store });

    const result = tools.claimScope({
      space_id: TEST_SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      scope: { paths: ['src/One.ts', 'src/Two.ts'] },
      repo_id: REPO_ID,
      branch: BRANCH,
      current_head_sha: HEAD_SHA_ACQUIRE,
      auto_release_mode: 'on_commit'
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const release = tools.releaseScopeViaGit({
      space_id: TEST_SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      repo_id: REPO_ID,
      branch: BRANCH,
      paths_with_status: [
        { status: 'M', path: 'src/One.ts' },
        { status: 'M', path: 'src/Two.ts' }
      ],
      current_head_sha: HEAD_SHA_NEW,
      porcelain_dirty_paths: []
    });

    expect(release.ok).toBe(true);
    if (!release.ok) return;
    expect(release.data).toEqual({ released: 1, kept: 0 });
    expect(storedReleaseEvents(db)).toHaveLength(1);
  });

  it('directly unblocks same-context pending edits when git releases the blocking claim', () => {
    const db = buildTestDb();
    const store = new SqliteEventStore(db);
    const tools = createTeamemTools({ db, store });

    const sprint = tools.createSprint({
      space_id: TEST_SPACE,
      principal: 'alice',
      display_name: 'Pending Sprint',
      goal: 'Route unblocks directly'
    });
    expect(sprint.ok).toBe(true);
    if (!sprint.ok) return;
    const sprintId = sprint.data.sprint?.sprint_id ?? null;
    tools.joinSprint({
      space_id: TEST_SPACE,
      principal: 'bob',
      sprint: 'pending-sprint'
    });

    const claimId = seedActiveClaim(tools, db, 'src/Pending.tsx');
    const queued = tools.queuePendingEdit({
      space_id: TEST_SPACE,
      principal: 'bob',
      actor: 'bob',
      delegation: 'bob->bob',
      blocking_claim_id: claimId,
      paths: ['src/Pending.tsx'],
      intent: 'finish blocked edit'
    });
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;

    const release = tools.releaseScopeViaGit({
      space_id: TEST_SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      repo_id: REPO_ID,
      branch: BRANCH,
      paths_with_status: [{ status: 'M', path: 'src/Pending.tsx' }],
      current_head_sha: HEAD_SHA_NEW,
      porcelain_dirty_paths: []
    });
    expect(release.ok).toBe(true);

    const pendingRow = db
      .prepare('SELECT resolved_at FROM pending_edits WHERE pending_id = ?1')
      .get(queued.data.pending_id) as { resolved_at: string | null };
    expect(pendingRow.resolved_at).not.toBeNull();

    const conflictEvent = db
      .prepare(
        `SELECT raw_json
           FROM events
          WHERE event_type = 'conflict_resolved'
          LIMIT 1`
      )
      .get() as { raw_json: string } | null;
    expect(conflictEvent).not.toBeNull();
    const parsed = JSON.parse(conflictEvent!.raw_json);
    expect(parsed).toMatchObject({
      sprint_id: sprintId,
      delivery_scope: 'direct',
      recipient_principals: ['bob'],
      payload: {
        pending_id: queued.data.pending_id,
        blocked_principal: 'bob',
        blocking_claim_id: claimId
      }
    });
    expect(eventIdsFor(tools, 'bob')).toContain(parsed.event_id);
    expect(eventIdsFor(tools, 'carol')).not.toContain(parsed.event_id);
  });
});
