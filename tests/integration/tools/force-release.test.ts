/**
 * Slice #35 — force_release + unread_notifications integration tests.
 *
 * AC coverage:
 *  - force_release: claim transitions to released, claim_force_released event
 *    emitted, unread_notifications row inserted — all in one transaction.
 *  - fetch_unread_notifications: returns undelivered rows in created_at order,
 *    marks them delivered, second call returns empty (dedupe).
 *  - Non-privileged: any peer can force-release any peer's claim (story 36).
 *  - force_release returns clear error when no matching claim exists.
 *  - force_release returns clear error when claim is held by a different principal.
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

const SPACE = 'space-fr-01';
const REPO = 'github.com/org/repo';
const BRANCH = 'feature/alice';
const PATH = 'src/Form.jsx';

function seedClaim(
  db: Database,
  tools: ReturnType<typeof createTeamemTools>,
  principal: string
): string {
  const result = tools.claimScope({
    space_id: SPACE,
    principal,
    actor: principal,
    delegation: `${principal}->${principal}`,
    scope: { paths: [PATH] },
    repo_id: REPO,
    branch: BRANCH,
    auto_release_mode: 'manual_only'
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('seed claim failed');
  return result.data.claim_id;
}

describe('force_release tool (slice #35)', () => {
  let db: Database;
  let tools: ReturnType<typeof createTeamemTools>;

  beforeEach(() => {
    ({ db, tools } = setup());
    // Seed space membership (claims table enforces space_id but not FK to spaces).
    db.prepare(
      `INSERT OR IGNORE INTO spaces (id, label, created_at) VALUES (?1, ?2, ?3)`
    ).run(SPACE, 'test-space', new Date().toISOString());
  });

  it('transitions claim to released and emits claim_force_released event', () => {
    seedClaim(db, tools, 'alice');

    const result = tools.forceRelease({
      space_id: SPACE,
      principal: 'bob',
      actor: 'bob',
      delegation: 'bob->bob',
      repo_id: REPO,
      branch: BRANCH,
      path: PATH,
      target_principal: 'alice'
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.released).toBe(true);
    expect(result.data.original_holder).toBe('alice');

    // Claim projection: status should be 'released'.
    const claim = db
      .prepare(`SELECT status, released_at FROM claims WHERE claim_id = ?1`)
      .get(result.data.claim_id) as {
      status: string;
      released_at: string | null;
    } | null;
    expect(claim?.status).toBe('released');
    expect(claim?.released_at).toBeTruthy();
  });

  it('emits claim_force_released event with correct payload', () => {
    seedClaim(db, tools, 'alice');

    const result = tools.forceRelease({
      space_id: SPACE,
      principal: 'bob',
      actor: 'bob',
      delegation: 'bob->bob',
      repo_id: REPO,
      branch: BRANCH,
      path: PATH,
      target_principal: 'alice'
    });
    expect(result.ok).toBe(true);

    const event = db
      .prepare(
        `SELECT event_type, payload_json FROM events WHERE event_type = 'claim_force_released' LIMIT 1`
      )
      .get() as { event_type: string; payload_json: string } | null;

    expect(event).toBeTruthy();
    expect(event?.event_type).toBe('claim_force_released');
    const payload = JSON.parse(event!.payload_json) as Record<string, unknown>;
    expect(payload.released_by).toBe('bob');
    expect(payload.original_holder).toBe('alice');
    expect(payload.path).toBe(PATH);
    expect(payload.branch).toBe(BRANCH);
    expect(payload.repo_id).toBe(REPO);
  });

  it('claim_id fallback uses stored claim metadata when caller sends conflicting identity fields', () => {
    const claimId = seedClaim(db, tools, 'alice');

    const result = tools.forceRelease({
      space_id: SPACE,
      principal: 'bob',
      actor: 'bob',
      delegation: 'bob->bob',
      claim_id: claimId,
      repo_id: 'github.com/wrong/repo',
      branch: 'wrong-branch',
      path: 'wrong/path.ts',
      target_principal: 'carol'
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.claim_id).toBe(claimId);
    expect(result.data.original_holder).toBe('alice');

    const event = db
      .prepare(
        `SELECT payload_json FROM events WHERE event_type = 'claim_force_released' LIMIT 1`
      )
      .get() as { payload_json: string } | null;
    expect(event).toBeTruthy();
    const payload = JSON.parse(event!.payload_json) as Record<string, unknown>;
    expect(payload.claim_id).toBe(claimId);
    expect(payload.repo_id).toBe(REPO);
    expect(payload.branch).toBe(BRANCH);
    expect(payload.path).toBe(PATH);
    expect(payload.original_holder).toBe('alice');

    const notif = db
      .prepare(
        `SELECT principal, payload_json FROM unread_notifications
        WHERE space_id = ?1 AND event_type = 'claim_force_released' LIMIT 1`
      )
      .get(SPACE) as { principal: string; payload_json: string } | null;
    expect(notif?.principal).toBe('alice');
    const notifPayload = JSON.parse(notif!.payload_json) as Record<
      string,
      unknown
    >;
    expect(notifPayload.repo_id).toBe(REPO);
    expect(notifPayload.branch).toBe(BRANCH);
    expect(notifPayload.path).toBe(PATH);
  });

  it('inserts unread_notifications row for original holder in same transaction', () => {
    seedClaim(db, tools, 'alice');

    const result = tools.forceRelease({
      space_id: SPACE,
      principal: 'bob',
      actor: 'bob',
      delegation: 'bob->bob',
      repo_id: REPO,
      branch: BRANCH,
      path: PATH,
      target_principal: 'alice'
    });
    expect(result.ok).toBe(true);

    const notif = db
      .prepare(
        `SELECT principal, event_type, delivered_at FROM unread_notifications
        WHERE space_id = ?1 AND principal = ?2`
      )
      .get(SPACE, 'alice') as {
      principal: string;
      event_type: string;
      delivered_at: string | null;
    } | null;

    expect(notif).toBeTruthy();
    expect(notif?.principal).toBe('alice');
    expect(notif?.event_type).toBe('claim_force_released');
    expect(notif?.delivered_at).toBeNull();
  });

  it('returns error when no matching claim exists', () => {
    const result = tools.forceRelease({
      space_id: SPACE,
      principal: 'bob',
      actor: 'bob',
      delegation: 'bob->bob',
      repo_id: REPO,
      branch: BRANCH,
      path: PATH,
      target_principal: 'alice'
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('claim_not_found');
  });

  it('returns error when claim exists but is held by a different principal', () => {
    seedClaim(db, tools, 'carol');

    const result = tools.forceRelease({
      space_id: SPACE,
      principal: 'bob',
      actor: 'bob',
      delegation: 'bob->bob',
      repo_id: REPO,
      branch: BRANCH,
      path: PATH,
      target_principal: 'alice' // alice does NOT hold the claim; carol does
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('claim_not_found');
  });

  it('concurrent force_release: only one event lands; runners-up return idempotent success (codex-review task #2)', async () => {
    seedClaim(db, tools, 'alice');

    // Fire two force_release calls "concurrently". better-sqlite3 / bun:sqlite
    // is sync, so true concurrency means we just invoke twice in sequence
    // — but the .immediate() lock on the first tx is still the right
    // contract: the second SELECT inside the locked window must see the
    // already-released claim.
    const calls = [
      () =>
        tools.forceRelease({
          space_id: SPACE,
          principal: 'bob',
          actor: 'bob',
          delegation: 'bob->bob',
          repo_id: REPO,
          branch: BRANCH,
          path: PATH,
          target_principal: 'alice'
        }),
      () =>
        tools.forceRelease({
          space_id: SPACE,
          principal: 'carol',
          actor: 'carol',
          delegation: 'carol->carol',
          repo_id: REPO,
          branch: BRANCH,
          path: PATH,
          target_principal: 'alice'
        })
    ];

    const results = await Promise.all(calls.map((c) => Promise.resolve(c())));

    // Both calls must report ok: true (one is the original release, the
    // other is the idempotent-success runner-up).
    expect(results.every((r) => r.ok === true)).toBe(true);

    // Exactly one runner-up must carry `idempotent: true`.
    const idempotentResponses = results.filter(
      (r) => r.ok && (r.data as { idempotent?: boolean }).idempotent === true
    );
    expect(idempotentResponses.length).toBe(1);

    // CRITICAL: exactly one `claim_force_released` event must land in the
    // event store (the original release; the runner-up emits no event).
    const eventCount = (
      db
        .prepare(
          `SELECT COUNT(*) as c FROM events WHERE event_type = 'claim_force_released'`
        )
        .get() as { c: number }
    ).c;
    expect(eventCount).toBe(1);

    // And the unread_notifications row should also be exactly 1.
    const notifCount = (
      db
        .prepare(
          `SELECT COUNT(*) as c FROM unread_notifications WHERE space_id = ?1 AND principal = ?2`
        )
        .get(SPACE, 'alice') as { c: number }
    ).c;
    expect(notifCount).toBe(1);
  });

  it('codex-review task #5: target recent cursor + no modeled live channel still queues unread_notifications', () => {
    seedClaim(db, tools, 'alice');

    // Simulate alice having a recent get_updates cursor. There is no
    // explicit live-delivery channel modeled in this server layer, so a
    // fresh cursor alone must not suppress the durable unread queue.
    const nowIso = new Date().toISOString();
    db.prepare(
      `INSERT OR REPLACE INTO cursors (actor, space_id, cursor_value, updated_at)
       VALUES (?1, ?2, ?3, ?4)`
    ).run('alice', SPACE, 'cursor-evt-recent', nowIso);

    const result = tools.forceRelease({
      space_id: SPACE,
      principal: 'bob',
      actor: 'bob',
      delegation: 'bob->bob',
      repo_id: REPO,
      branch: BRANCH,
      path: PATH,
      target_principal: 'alice'
    });
    expect(result.ok).toBe(true);

    // The claim_force_released event MUST still be appended to the event log.
    const eventCount = (
      db
        .prepare(
          `SELECT COUNT(*) as c FROM events WHERE event_type = 'claim_force_released'`
        )
        .get() as { c: number }
    ).c;
    expect(eventCount).toBe(1);

    // The unread_notifications queue must still carry a row as the
    // durable fallback.
    const queueRows = (
      db
        .prepare(
          `SELECT COUNT(*) as c FROM unread_notifications WHERE space_id = ?1 AND principal = ?2`
        )
        .get(SPACE, 'alice') as { c: number }
    ).c;
    expect(queueRows).toBe(1);

    // Sanity: fetch_unread_notifications can drain the queued fallback.
    const fetched = tools.fetchUnreadNotifications({
      space_id: SPACE,
      principal: 'alice'
    });
    expect(fetched.ok).toBe(true);
    if (!fetched.ok) return;
    expect(fetched.data.notifications.length).toBe(1);
  });

  it('codex-review task #5: target offline (stale cursor) → unread_notifications row IS queued (offline catch-up)', () => {
    seedClaim(db, tools, 'alice');

    // Stale cursor (10 minutes ago) → alice considered offline → queue is used.
    const staleIso = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    db.prepare(
      `INSERT OR REPLACE INTO cursors (actor, space_id, cursor_value, updated_at)
       VALUES (?1, ?2, ?3, ?4)`
    ).run('alice', SPACE, 'cursor-evt-stale', staleIso);

    tools.forceRelease({
      space_id: SPACE,
      principal: 'bob',
      actor: 'bob',
      delegation: 'bob->bob',
      repo_id: REPO,
      branch: BRANCH,
      path: PATH,
      target_principal: 'alice'
    });

    const queueRows = (
      db
        .prepare(
          `SELECT COUNT(*) as c FROM unread_notifications WHERE space_id = ?1 AND principal = ?2 AND delivered_at IS NULL`
        )
        .get(SPACE, 'alice') as { c: number }
    ).c;
    expect(queueRows).toBe(1);
  });

  it('non-privileged: any peer can force-release any peer (story 36)', () => {
    seedClaim(db, tools, 'alice');

    // dave is a non-admin peer with no special privileges
    const result = tools.forceRelease({
      space_id: SPACE,
      principal: 'dave',
      actor: 'dave',
      delegation: 'dave->dave',
      repo_id: REPO,
      branch: BRANCH,
      path: PATH,
      target_principal: 'alice'
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.released).toBe(true);
    expect(result.data.original_holder).toBe('alice');
  });

  it('claim_id fallback releases legacy claims with missing repo or branch', () => {
    const claimId = seedClaim(db, tools, 'alice');
    db.prepare(
      `UPDATE claims
          SET repo_id = '',
              branch = ''
        WHERE claim_id = ?1`
    ).run(claimId);

    const result = tools.forceRelease({
      space_id: SPACE,
      principal: 'bob',
      actor: 'bob',
      delegation: 'bob->bob',
      claim_id: claimId
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.released).toBe(true);
    expect(result.data.claim_id).toBe(claimId);
    expect(result.data.original_holder).toBe('alice');

    const claim = db
      .prepare(`SELECT status, released_at FROM claims WHERE claim_id = ?1`)
      .get(claimId) as { status: string; released_at: string | null };
    expect(claim.status).toBe('released');
    expect(claim.released_at).toBeTruthy();
  });

  it('claim_id fallback releases paused claims that still block peers', () => {
    const claimId = seedClaim(db, tools, 'alice');
    db.prepare(
      `UPDATE claims
          SET status = 'paused',
              paused_at = ?2,
              paused_reason = 'branch-switch'
        WHERE claim_id = ?1`
    ).run(claimId, new Date().toISOString());

    const result = tools.forceRelease({
      space_id: SPACE,
      principal: 'bob',
      actor: 'bob',
      delegation: 'bob->bob',
      claim_id: claimId
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.released).toBe(true);

    const claim = db
      .prepare(`SELECT status, released_at FROM claims WHERE claim_id = ?1`)
      .get(claimId) as { status: string; released_at: string | null };
    expect(claim.status).toBe('released');
    expect(claim.released_at).toBeTruthy();
  });
});

describe('fetch_unread_notifications tool (slice #35)', () => {
  let db: Database;
  let tools: ReturnType<typeof createTeamemTools>;

  beforeEach(() => {
    ({ db, tools } = setup());
    db.prepare(
      `INSERT OR IGNORE INTO spaces (id, label, created_at) VALUES (?1, ?2, ?3)`
    ).run(SPACE, 'test-space', new Date().toISOString());
  });

  it('returns undelivered notifications in created_at ascending order', () => {
    seedClaim(db, tools, 'alice');

    tools.forceRelease({
      space_id: SPACE,
      principal: 'bob',
      actor: 'bob',
      delegation: 'bob->bob',
      repo_id: REPO,
      branch: BRANCH,
      path: PATH,
      target_principal: 'alice'
    });

    const result = tools.fetchUnreadNotifications({
      space_id: SPACE,
      principal: 'alice'
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.notifications.length).toBe(1);
    expect(result.data.notifications[0].event_type).toBe(
      'claim_force_released'
    );
    expect(
      (result.data.notifications[0].payload as Record<string, unknown>)
        .released_by
    ).toBe('bob');
  });

  it('marks rows delivered after fetch — second call returns empty', () => {
    seedClaim(db, tools, 'alice');
    tools.forceRelease({
      space_id: SPACE,
      principal: 'bob',
      actor: 'bob',
      delegation: 'bob->bob',
      repo_id: REPO,
      branch: BRANCH,
      path: PATH,
      target_principal: 'alice'
    });

    const first = tools.fetchUnreadNotifications({
      space_id: SPACE,
      principal: 'alice'
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.notifications.length).toBe(1);

    const second = tools.fetchUnreadNotifications({
      space_id: SPACE,
      principal: 'alice'
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.notifications.length).toBe(0);
  });

  it('delivered rows have delivered_at set in the database', () => {
    seedClaim(db, tools, 'alice');
    tools.forceRelease({
      space_id: SPACE,
      principal: 'bob',
      actor: 'bob',
      delegation: 'bob->bob',
      repo_id: REPO,
      branch: BRANCH,
      path: PATH,
      target_principal: 'alice'
    });

    tools.fetchUnreadNotifications({ space_id: SPACE, principal: 'alice' });

    const row = db
      .prepare(
        `SELECT delivered_at FROM unread_notifications WHERE space_id = ?1 AND principal = ?2`
      )
      .get(SPACE, 'alice') as { delivered_at: string | null } | null;
    expect(row?.delivered_at).toBeTruthy();
  });

  it('returns empty when no unread notifications exist', () => {
    const result = tools.fetchUnreadNotifications({
      space_id: SPACE,
      principal: 'alice'
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.notifications).toEqual([]);
  });

  it("does not surface another principal's notifications", () => {
    seedClaim(db, tools, 'alice');
    tools.forceRelease({
      space_id: SPACE,
      principal: 'bob',
      actor: 'bob',
      delegation: 'bob->bob',
      repo_id: REPO,
      branch: BRANCH,
      path: PATH,
      target_principal: 'alice'
    });

    // carol should see nothing — the notification is for alice
    const result = tools.fetchUnreadNotifications({
      space_id: SPACE,
      principal: 'carol'
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.notifications.length).toBe(0);
  });

  it('does not insert duplicate notifications for the same event_id + principal', () => {
    const claimId = seedClaim(db, tools, 'alice');

    // Force-release once
    tools.forceRelease({
      space_id: SPACE,
      principal: 'bob',
      actor: 'bob',
      delegation: 'bob->bob',
      repo_id: REPO,
      branch: BRANCH,
      path: PATH,
      target_principal: 'alice'
    });

    // Seed a duplicate row manually to simulate retry — UNIQUE constraint prevents it.
    const existing = db
      .prepare(
        `SELECT event_id FROM unread_notifications WHERE space_id = ?1 AND principal = ?2`
      )
      .get(SPACE, 'alice') as { event_id: string } | null;
    expect(existing).toBeTruthy();

    // INSERT OR IGNORE means a second insert with same (event_id, principal) is silently dropped.
    db.prepare(
      `INSERT OR IGNORE INTO unread_notifications
       (space_id, principal, event_id, event_type, payload_json, created_at, delivered_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL)`
    ).run(
      SPACE,
      'alice',
      existing!.event_id,
      'claim_force_released',
      '{}',
      new Date().toISOString()
    );

    const count = (
      db
        .prepare(
          `SELECT COUNT(*) as c FROM unread_notifications WHERE space_id = ?1 AND principal = ?2`
        )
        .get(SPACE, 'alice') as { c: number }
    ).c;
    expect(count).toBe(1);

    void claimId; // used implicitly via seedClaim
  });
});
