/**
 * Codex F2 regression — wipe must cover every space-scoped projection.
 *
 * `TOMBSTONED_PROJECTION_TABLES` is the source of truth for both soft and
 * hard wipe. The original list missed `pending_edits`, `findings`, `focus`,
 * `disputes`, and `permission_requests`. Soft wipe left those rows visible;
 * hard wipe orphaned them.
 *
 * This test seeds one row per projection (12 tables), runs both wipe modes
 * in two parallel spaces, and asserts:
 *   - SOFT: every row has `tombstoned_at` set, in every table.
 *   - HARD: every table has `COUNT(*) = 0` for the wiped space.
 */
import { describe, expect, it } from 'bun:test';
import { runAllMigrations } from '../../helpers/migrations.js';
import { createSqliteClient } from '../../../src/infra/db/sqlite-client.js';
import { createSpace, wipeSpace } from '../../../src/server/spaces.js';

const TEST_JWT_SECRET = 'test-secret-32bytes-padded-xxxxx';

const PROJECTION_TABLES = [
  'claims',
  'decisions',
  'blockers',
  'discussions',
  'contracts',
  'task_state',
  'pending_edits',
  'findings',
  'artifacts',
  'permission_requests',
  'disputes',
  'focus'
];

const HARD_DELETE_ONLY_TABLES = [
  'space_rules_snapshots',
  'discussion_threads',
  'decision_history',
  'finding_acknowledgements',
  'unread_notifications'
];

function seedAllProjections(
  db: ReturnType<typeof createSqliteClient>,
  space_id: string,
  prefix: string
) {
  const now = new Date().toISOString();
  const future = new Date(Date.now() + 86_400_000).toISOString();

  // Source event, used as source_event_id for projections that need it.
  db.prepare(
    `INSERT INTO events (
      event_id, idempotency_key, space_id, timestamp, principal, actor, delegation,
      event_type, scope_json, payload_json, refs_json, confidence, schema_version, raw_json
    ) VALUES (?1, ?2, ?3, ?4, 'alice', 'alice', 'alice->alice', 'task_started',
              '{}', '{}', NULL, NULL, '1.0', '{}')`
  ).run(`${prefix}-evt`, `${prefix}-evt-idem`, space_id, now);

  db.prepare(
    `INSERT INTO claims (claim_id, space_id, principal, actor, scope_json, intent, status, created_at)
     VALUES (?1, ?2, 'alice', 'alice', '{}', 'test', 'active', ?3)`
  ).run(`${prefix}-claim`, space_id, now);
  db.prepare(
    `INSERT INTO decisions (decision_id, space_id, title, status, summary, updated_at, source_event_id, kind, decided_by)
     VALUES (?1, ?2, 'd', 'open', 's', ?3, ?4, 'architectural', 'alice')`
  ).run(`${prefix}-dec`, space_id, now, `${prefix}-evt`);
  db.prepare(
    `INSERT INTO decision_history (
      source_event_id, decision_id, space_id, version, lifecycle_event, title,
      summary, body, kind, status, decided_by, created_at,
      predecessor_decision_id, superseded_by_decision_id, tombstoned_at
    ) VALUES (?1, ?2, ?3, 1, 'decision_recorded', 'd', 's', NULL, 'architectural', 'open', 'alice', ?4, NULL, NULL, NULL)`
  ).run(`${prefix}-dec-hist`, `${prefix}-dec`, space_id, now);
  db.prepare(
    `INSERT INTO blockers (blocker_id, space_id, status, owner_principal, summary, updated_at, source_event_id)
     VALUES (?1, ?2, 'open', 'alice', 'b', ?3, ?4)`
  ).run(`${prefix}-block`, space_id, now, `${prefix}-evt`);
  db.prepare(
    `INSERT INTO discussions (message_id, space_id, thread_id, sender_principal, recipient_principal, body, in_reply_to, created_at, source_event_id)
     VALUES (?1, ?2, ?3, 'alice', NULL, 'hi', NULL, ?4, ?5)`
  ).run(`${prefix}-msg`, space_id, `${prefix}-thread`, now, `${prefix}-evt`);
  db.prepare(
    `INSERT INTO discussion_threads (
      thread_id, space_id, visibility_mode, participant_principals_json,
      source_message_id, source_event_id, created_at
    ) VALUES (?1, ?2, 'broadcast', '[]', ?3, ?4, ?5)`
  ).run(`${prefix}-thread`, space_id, `${prefix}-msg`, `${prefix}-evt`, now);
  db.prepare(
    `INSERT INTO contracts (contract_key, space_id, state_json, updated_at, updated_by_event_id)
     VALUES (?1, ?2, '{}', ?3, ?4)`
  ).run(`${prefix}-contract`, space_id, now, `${prefix}-evt`);
  db.prepare(
    `INSERT INTO task_state (task_id, space_id, principal, status, what, updated_at, source_event_id)
     VALUES (?1, ?2, 'alice', 'in_progress', 'doing', ?3, ?4)`
  ).run(`${prefix}-task`, space_id, now, `${prefix}-evt`);
  db.prepare(
    `INSERT INTO pending_edits (pending_id, space_id, blocked_principal, blocking_claim_id, paths_json, intent, expires_at, source_event_id)
     VALUES (?1, ?2, 'bob', 'incumbent-claim', '["x"]', 'i', ?3, ?4)`
  ).run(`${prefix}-pend`, space_id, future, `${prefix}-evt`);
  db.prepare(
    `INSERT INTO findings (finding_id, space_id, principal, summary, body, tags_json, severity, refs_json, created_at, expires_at, source_event_id)
     VALUES (?1, ?2, 'alice', 'f', NULL, '[]', 'info', NULL, ?3, ?4, ?5)`
  ).run(`${prefix}-finding`, space_id, now, future, `${prefix}-evt`);
  db.prepare(
    `INSERT INTO finding_acknowledgements (
      space_id, finding_id, version, principal, acknowledged_at, source_event_id, note
    ) VALUES (?1, ?2, 1, 'alice', ?3, ?4, 'seen')`
  ).run(space_id, `${prefix}-finding`, now, `${prefix}-evt`);
  db.prepare(
    `INSERT INTO artifacts (artifact_id, space_id, principal, kind, uri, title, summary, created_at, source_event_id)
     VALUES (?1, ?2, 'alice', 'spec', 'spec.md', 't', NULL, ?3, ?4)`
  ).run(`${prefix}-art`, space_id, now, `${prefix}-evt`);
  db.prepare(
    `INSERT INTO permission_requests (req_id, space_id, requester_principal, incumbent_principal, blocking_claim_id, paths_json, intent, status, created_at, source_event_id)
     VALUES (?1, ?2, 'bob', 'alice', 'inc', '["x"]', 'i', 'open', ?3, ?4)`
  ).run(`${prefix}-req`, space_id, now, `${prefix}-evt`);
  db.prepare(
    `INSERT INTO disputes (thread_id, space_id, opened_by, target_principal, blocking_claim_id, paths_json, intent, status, opened_at, source_event_id)
     VALUES (?1, ?2, 'bob', 'alice', 'inc', '["x"]', 'i', 'open', ?3, ?4)`
  ).run(`${prefix}-disp`, space_id, now, `${prefix}-evt`);
  db.prepare(
    `INSERT INTO focus (focus_id, space_id, principal, scope_paths_json, scope_hash, intent, source_event_id)
     VALUES (?1, ?2, 'alice', '["src/auth/x.ts"]', 'h1', 'editing auth', ?3)`
  ).run(`${prefix}-foc`, space_id, `${prefix}-evt`);
  db.prepare(
    `INSERT INTO space_rules_snapshots (space_id, rules_markdown, rules_version, source_event_id, updated_at, updated_by_member_id)
     VALUES (?1, 'Prefer focused diffs.', 1, ?2, ?3, NULL)`
  ).run(space_id, `${prefix}-evt`, now);
  db.prepare(
    `INSERT INTO unread_notifications (
      space_id, principal, event_id, event_type, payload_json, created_at, delivered_at
    ) VALUES (?1, 'alice', ?2, 'decision_recorded', '{}', ?3, NULL)`
  ).run(space_id, `${prefix}-evt`, now);
}

function rowCount(
  db: ReturnType<typeof createSqliteClient>,
  table: string,
  space_id: string
) {
  const r = db
    .prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE space_id = ?`)
    .get(space_id) as { c: number };
  return r.c;
}

function tombstonedCount(
  db: ReturnType<typeof createSqliteClient>,
  table: string,
  space_id: string
) {
  const r = db
    .prepare(
      `SELECT COUNT(*) AS c FROM ${table} WHERE space_id = ? AND tombstoned_at IS NOT NULL`
    )
    .get(space_id) as { c: number };
  return r.c;
}

describe('wipe covers every space-scoped projection (Codex F2)', () => {
  it('soft-wipe sets tombstoned_at on every projection table', async () => {
    const db = createSqliteClient(':memory:');
    runAllMigrations(db);

    const space = await createSpace(
      db,
      { label: 'soft-wipe', member_name: 'alice' },
      TEST_JWT_SECRET
    );
    seedAllProjections(db, space.space_id, 'sw');

    // Sanity: each table has exactly 1 row.
    for (const t of PROJECTION_TABLES) {
      expect(rowCount(db, t, space.space_id)).toBe(1);
    }

    const r = wipeSpace(db, { requester_member_id: space.member_id });
    expect(r).toEqual({ ok: true, wiped_at: expect.any(String) });

    // Each row survives but is tombstoned.
    for (const t of PROJECTION_TABLES) {
      expect(`${t}/rowCount`).toBe(`${t}/rowCount`); // pre-line label for failure clarity
      expect(rowCount(db, t, space.space_id)).toBe(1);
      expect(tombstonedCount(db, t, space.space_id)).toBe(1);
    }
    for (const t of HARD_DELETE_ONLY_TABLES) {
      expect(rowCount(db, t, space.space_id)).toBe(1);
    }
  });

  it('hard-wipe deletes every space-scoped row across all 12 projections', async () => {
    const db = createSqliteClient(':memory:');
    runAllMigrations(db);

    const space = await createSpace(
      db,
      { label: 'hard-wipe', member_name: 'alice' },
      TEST_JWT_SECRET
    );
    seedAllProjections(db, space.space_id, 'hw');

    // Sanity.
    for (const t of PROJECTION_TABLES) {
      expect(rowCount(db, t, space.space_id)).toBe(1);
    }

    const r = wipeSpace(db, {
      requester_member_id: space.member_id,
      hard: true
    });
    expect(r).toEqual({ ok: true, wiped_at: expect.any(String) });

    // Every row gone.
    for (const t of PROJECTION_TABLES) {
      expect(rowCount(db, t, space.space_id)).toBe(0);
    }
    for (const t of HARD_DELETE_ONLY_TABLES) {
      expect(rowCount(db, t, space.space_id)).toBe(0);
    }
    // Events also gone.
    expect(rowCount(db, 'events', space.space_id)).toBe(0);
  });
});
