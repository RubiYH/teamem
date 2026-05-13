/**
 * Codex round-2 review fix (#16) — regression test for the
 * `fetchUnreadNotifications` SELECT-then-UPDATE race.
 *
 * Pre-fix: two concurrent fetches by the same principal could both SELECT
 * the same undelivered rows before either UPDATE committed → the same
 * notification surfaced twice.
 *
 * Fix: wrap the SELECT-then-UPDATE in `db.transaction(...).immediate()`. The
 * RESERVED lock at BEGIN serializes the two transactions; the second
 * re-runs its SELECT and sees no undelivered rows.
 *
 * This test seeds 5 unread notifications for a principal, fires two
 * concurrent `fetchUnreadNotifications` calls via `Promise.all`, and asserts:
 *   - the union of returned event_ids has exactly 5 distinct ids
 *   - no event_id appears in both responses (no double-delivery)
 *   - all 5 rows have delivered_at set
 */
import { describe, expect, it } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { createSqliteClient } from '../../../src/infra/db/sqlite-client.js';
import { SqliteEventStore } from '../../../src/infra/db/sqlite-event-store.js';
import { createTeamemTools } from '../../../src/server/tools/index.js';
import { runAllMigrations } from '../../helpers/migrations.js';

const SPACE = 'space-fetch-race';

function setup(): {
  db: Database;
  tools: ReturnType<typeof createTeamemTools>;
} {
  const db = createSqliteClient(':memory:');
  runAllMigrations(db);
  db.prepare(
    `INSERT OR IGNORE INTO spaces (id, label, created_at) VALUES (?1, ?2, ?3)`
  ).run(SPACE, 'test-space', new Date().toISOString());
  const store = new SqliteEventStore(db);
  return { db, tools: createTeamemTools({ db, store }) };
}

function seedNotification(
  db: Database,
  eventId: string,
  principal: string
): void {
  db.prepare(
    `INSERT INTO unread_notifications
       (space_id, principal, event_id, event_type, payload_json, created_at, delivered_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL)`
  ).run(
    SPACE,
    principal,
    eventId,
    'claim_force_released',
    JSON.stringify({ claim_id: `claim-${eventId}` }),
    new Date().toISOString()
  );
}

describe('fetchUnreadNotifications — concurrent-fetch race regression (#16)', () => {
  it('two concurrent fetches return each event_id at most once across the union', async () => {
    const { db, tools } = setup();

    const ids = ['evt-1', 'evt-2', 'evt-3', 'evt-4', 'evt-5'];
    for (const id of ids) seedNotification(db, id, 'alice');

    // Two concurrent fetches by the same principal. Bun's sqlite sync calls
    // serialize via the .immediate() RESERVED lock; the second tx re-SELECTs
    // and sees no undelivered rows.
    const [first, second] = await Promise.all([
      Promise.resolve().then(() =>
        tools.fetchUnreadNotifications({ space_id: SPACE, principal: 'alice' })
      ),
      Promise.resolve().then(() =>
        tools.fetchUnreadNotifications({ space_id: SPACE, principal: 'alice' })
      )
    ]);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    const firstIds = first.data.notifications.map((n) => n.event_id);
    const secondIds = second.data.notifications.map((n) => n.event_id);

    // Union has exactly 5 distinct ids — every seeded notification was
    // returned by exactly one of the two callers.
    const union = new Set([...firstIds, ...secondIds]);
    expect(union.size).toBe(5);
    for (const id of ids) expect(union.has(id)).toBe(true);

    // No id appears in both responses.
    const firstSet = new Set(firstIds);
    for (const id of secondIds) expect(firstSet.has(id)).toBe(false);

    // Total returned across both calls equals 5 — no duplicates.
    expect(firstIds.length + secondIds.length).toBe(5);

    // All rows are now marked delivered.
    const undelivered = db
      .prepare(
        `SELECT COUNT(*) AS c FROM unread_notifications
          WHERE space_id = ?1 AND principal = ?2 AND delivered_at IS NULL`
      )
      .get(SPACE, 'alice') as { c: number };
    expect(undelivered.c).toBe(0);
  });

  it('single fetch returns all 5, second fetch returns empty (post-fix idempotency)', () => {
    const { db, tools } = setup();
    const ids = ['e1', 'e2', 'e3', 'e4', 'e5'];
    for (const id of ids) seedNotification(db, id, 'bob');

    const first = tools.fetchUnreadNotifications({
      space_id: SPACE,
      principal: 'bob'
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.notifications.length).toBe(5);

    const second = tools.fetchUnreadNotifications({
      space_id: SPACE,
      principal: 'bob'
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.notifications.length).toBe(0);
  });

  it('fall-through still returns empty when unread_notifications table is missing', () => {
    const db = createSqliteClient(':memory:');
    runAllMigrations(db);
    db.prepare(
      `INSERT OR IGNORE INTO spaces (id, label, created_at) VALUES (?1, ?2, ?3)`
    ).run(SPACE, 'test-space', new Date().toISOString());
    const store = new SqliteEventStore(db);
    const tools = createTeamemTools({ db, store });

    // Drop the table to simulate the no-migration-yet path.
    db.exec('DROP TABLE unread_notifications');

    const result = tools.fetchUnreadNotifications({
      space_id: SPACE,
      principal: 'alice'
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.notifications).toEqual([]);
  });
});
