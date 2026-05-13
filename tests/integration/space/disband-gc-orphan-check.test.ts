/**
 * Codex F3 regression — disband GC must hard-cascade every space-scoped
 * projection, not just the v0 set.
 *
 * Original bug: `gcDisbandedSpaces` only deleted from
 * events/claims/decisions/blockers/contracts/cursors/task_state/members/
 * room_codes. Rows in `pending_edits`, `findings`, `artifacts`,
 * `permission_requests`, `disputes`, `focus`, plus tied
 * `idempotency_keys`, were left orphaned in the database with no parent
 * `spaces` row.
 *
 * Fix: shared `HARD_CASCADE_TABLES` constant covers every space-scoped
 * projection. `idempotency_keys` are deleted before `events` so the
 * `event_id IN (SELECT … FROM events …)` predicate resolves correctly
 * (Codex F1 ordering).
 *
 * Test seeds every projection, sets disband grace into the past, runs
 * `gcDisbandedSpaces`, and asserts every space-scoped table has zero rows
 * for the swept space — including `idempotency_keys` for events tied to
 * that space.
 */
import { describe, expect, it } from 'bun:test';
import { runAllMigrations } from '../../helpers/migrations.js';
import { createSqliteClient } from '../../../src/infra/db/sqlite-client.js';
import { createSpace, gcDisbandedSpaces } from '../../../src/server/spaces.js';

const TEST_JWT_SECRET = 'test-secret-32bytes-padded-xxxxx';

const ALL_SPACE_TABLES = [
  'events',
  'claims',
  'decisions',
  'decision_history',
  'blockers',
  'discussions',
  'discussion_threads',
  'contracts',
  'cursors',
  'task_state',
  'pending_edits',
  'findings',
  'finding_acknowledgements',
  'artifacts',
  'permission_requests',
  'disputes',
  'focus',
  'space_rules_snapshots',
  'unread_notifications',
  'members',
  'room_codes'
];

function seed(
  db: ReturnType<typeof createSqliteClient>,
  space_id: string,
  prefix: string
) {
  const now = new Date().toISOString();
  const future = new Date(Date.now() + 86_400_000).toISOString();

  const e1 = `${prefix}-e-1`;
  const e2 = `${prefix}-e-2`;
  // Two events so we can verify the linked idempotency_keys are also cleaned.
  db.prepare(
    `INSERT INTO events (
      event_id, idempotency_key, space_id, timestamp, principal, actor, delegation,
      event_type, scope_json, payload_json, refs_json, confidence, schema_version, raw_json
    ) VALUES (?, ?, ?, ?, 'alice', 'alice', 'alice->alice', 'task_started',
              '{}', '{}', NULL, NULL, '1.0', '{}')`
  ).run(e1, `${prefix}-idem-1`, space_id, now);
  db.prepare(
    `INSERT INTO events (
      event_id, idempotency_key, space_id, timestamp, principal, actor, delegation,
      event_type, scope_json, payload_json, refs_json, confidence, schema_version, raw_json
    ) VALUES (?, ?, ?, ?, 'alice', 'alice', 'alice->alice', 'task_started',
              '{}', '{}', NULL, NULL, '1.0', '{}')`
  ).run(e2, `${prefix}-idem-2`, space_id, now);
  db.prepare(
    `INSERT INTO idempotency_keys (idempotency_key, event_id, created_at) VALUES (?, ?, ?)`
  ).run(`${prefix}-idem-1`, e1, now);
  db.prepare(
    `INSERT INTO idempotency_keys (idempotency_key, event_id, created_at) VALUES (?, ?, ?)`
  ).run(`${prefix}-idem-2`, e2, now);

  db.prepare(
    `INSERT INTO claims (claim_id, space_id, principal, actor, scope_json, intent, status, created_at)
     VALUES (?, ?, 'alice', 'alice', '{}', 'test', 'active', ?)`
  ).run(`${prefix}-c-1`, space_id, now);
  db.prepare(
    `INSERT INTO decisions (decision_id, space_id, title, status, summary, updated_at, source_event_id, kind, decided_by)
     VALUES (?, ?, 'd', 'open', 's', ?, ?, 'architectural', 'alice')`
  ).run(`${prefix}-d-1`, space_id, now, e1);
  db.prepare(
    `INSERT INTO decision_history (
      source_event_id, decision_id, space_id, version, lifecycle_event, title,
      summary, body, kind, status, decided_by, created_at,
      predecessor_decision_id, superseded_by_decision_id, tombstoned_at
    ) VALUES (?, ?, ?, 1, 'decision_recorded', 'd', 's', NULL, 'architectural', 'open', 'alice', ?, NULL, NULL, NULL)`
  ).run(`${prefix}-dh-1`, `${prefix}-d-1`, space_id, now);
  db.prepare(
    `INSERT INTO blockers (blocker_id, space_id, status, owner_principal, summary, updated_at, source_event_id)
     VALUES (?, ?, 'open', 'alice', 'b', ?, ?)`
  ).run(`${prefix}-b-1`, space_id, now, e1);
  db.prepare(
    `INSERT INTO discussions (message_id, space_id, thread_id, sender_principal, recipient_principal, body, in_reply_to, created_at, source_event_id)
     VALUES (?, ?, ?, 'alice', NULL, 'hi', NULL, ?, ?)`
  ).run(`${prefix}-m-1`, space_id, `${prefix}-t-1`, now, e1);
  db.prepare(
    `INSERT INTO discussion_threads (
      thread_id, space_id, visibility_mode, participant_principals_json,
      source_message_id, source_event_id, created_at
    ) VALUES (?, ?, 'broadcast', '[]', ?, ?, ?)`
  ).run(`${prefix}-t-1`, space_id, `${prefix}-m-1`, e1, now);
  db.prepare(
    `INSERT INTO contracts (contract_key, space_id, state_json, updated_at, updated_by_event_id)
     VALUES (?, ?, '{}', ?, ?)`
  ).run(`${prefix}-k-1`, space_id, now, e1);
  db.prepare(
    `INSERT INTO cursors (actor, space_id, cursor_value, updated_at) VALUES (?, ?, ?, ?)`
  ).run(`${prefix}-alice`, space_id, e2, now);
  db.prepare(
    `INSERT INTO task_state (task_id, space_id, principal, status, what, updated_at, source_event_id)
     VALUES (?, ?, 'alice', 'in_progress', 'd', ?, ?)`
  ).run(`${prefix}-tk-1`, space_id, now, e1);
  db.prepare(
    `INSERT INTO pending_edits (pending_id, space_id, blocked_principal, blocking_claim_id, paths_json, intent, expires_at, source_event_id)
     VALUES (?, ?, 'bob', 'inc', '["x"]', 'i', ?, ?)`
  ).run(`${prefix}-pe-1`, space_id, future, e1);
  db.prepare(
    `INSERT INTO findings (finding_id, space_id, principal, summary, body, tags_json, severity, refs_json, created_at, expires_at, source_event_id)
     VALUES (?, ?, 'alice', 'f', NULL, '[]', 'info', NULL, ?, ?, ?)`
  ).run(`${prefix}-f-1`, space_id, now, future, e1);
  db.prepare(
    `INSERT INTO finding_acknowledgements (
      space_id, finding_id, version, principal, acknowledged_at, source_event_id, note
    ) VALUES (?, ?, 1, 'alice', ?, ?, 'seen')`
  ).run(space_id, `${prefix}-f-1`, now, e1);
  db.prepare(
    `INSERT INTO artifacts (artifact_id, space_id, principal, kind, uri, title, summary, created_at, source_event_id)
     VALUES (?, ?, 'alice', 'spec', 'u', 't', NULL, ?, ?)`
  ).run(`${prefix}-a-1`, space_id, now, e1);
  db.prepare(
    `INSERT INTO permission_requests (req_id, space_id, requester_principal, incumbent_principal, blocking_claim_id, paths_json, intent, status, created_at, source_event_id)
     VALUES (?, ?, 'bob', 'alice', 'inc', '["x"]', 'i', 'open', ?, ?)`
  ).run(`${prefix}-pr-1`, space_id, now, e1);
  db.prepare(
    `INSERT INTO disputes (thread_id, space_id, opened_by, target_principal, blocking_claim_id, paths_json, intent, status, opened_at, source_event_id)
     VALUES (?, ?, 'bob', 'alice', 'inc', '["x"]', 'i', 'open', ?, ?)`
  ).run(`${prefix}-th-1`, space_id, now, e1);
  db.prepare(
    `INSERT INTO focus (focus_id, space_id, principal, scope_paths_json, scope_hash, intent, source_event_id)
     VALUES (?, ?, 'alice', '["src/x.ts"]', 'h', 'editing', ?)`
  ).run(`${prefix}-fo-1`, space_id, e1);
  db.prepare(
    `INSERT INTO space_rules_snapshots (space_id, rules_markdown, rules_version, source_event_id, updated_at, updated_by_member_id)
     VALUES (?, 'Prefer focused diffs.', 1, ?, ?, NULL)`
  ).run(space_id, e1, now);
  db.prepare(
    `INSERT INTO unread_notifications (
      space_id, principal, event_id, event_type, payload_json, created_at, delivered_at
    ) VALUES (?, 'alice', ?, 'decision_recorded', '{}', ?, NULL)`
  ).run(space_id, e1, now);
}

describe('disband GC orphan check (Codex F3)', () => {
  it('hard-cascade after grace expiry removes every space-scoped row, including new projections and idempotency_keys', async () => {
    const db = createSqliteClient(':memory:');
    runAllMigrations(db);

    const target = await createSpace(
      db,
      { label: 'cascade-target', member_name: 'alice' },
      TEST_JWT_SECRET
    );
    const other = await createSpace(
      db,
      { label: 'cascade-other', member_name: 'bob' },
      TEST_JWT_SECRET
    );
    seed(db, target.space_id, 'tgt');
    seed(db, other.space_id, 'oth');

    // Mark target disbanded with grace already elapsed.
    db.prepare(
      `UPDATE spaces SET disbanded_at = ?, disbanded_grace_until = ? WHERE id = ?`
    ).run(
      new Date(Date.now() - 86_400_000).toISOString(),
      new Date(Date.now() - 3600_000).toISOString(),
      target.space_id
    );

    const swept = gcDisbandedSpaces(db);
    expect(swept).toContain(target.space_id);

    // Every space-scoped table has zero rows for the swept space.
    for (const t of ALL_SPACE_TABLES) {
      const count = db
        .prepare(`SELECT COUNT(*) AS c FROM ${t} WHERE space_id = ?`)
        .get(target.space_id) as { c: number };
      expect(`${t}=${count.c}`).toBe(`${t}=0`);
    }
    // The spaces row itself is also gone.
    const spaceRow = db
      .prepare('SELECT id FROM spaces WHERE id = ?')
      .get(target.space_id);
    expect(spaceRow).toBeNull();

    // Idempotency keys tied to the swept events are gone too.
    const keys = db
      .prepare(
        `SELECT COUNT(*) AS c FROM idempotency_keys WHERE event_id IN ('tgt-e-1', 'tgt-e-2')`
      )
      .get() as { c: number };
    expect(keys.c).toBe(0);

    // Other space untouched. `events` carries 2 rows (the seed inserts two
    // so we can verify idempotency_keys cleanup); every other table has 1.
    const otherExpected: Record<string, number> = {
      events: 2,
      claims: 1,
      decisions: 1,
      decision_history: 1,
      blockers: 1,
      discussions: 1,
      discussion_threads: 1,
      contracts: 1,
      cursors: 1,
      task_state: 1,
      pending_edits: 1,
      findings: 1,
      finding_acknowledgements: 1,
      artifacts: 1,
      permission_requests: 1,
      disputes: 1,
      focus: 1,
      space_rules_snapshots: 1,
      unread_notifications: 1,
      members: 1,
      room_codes: 1
    };
    for (const t of ALL_SPACE_TABLES) {
      const count = db
        .prepare(`SELECT COUNT(*) AS c FROM ${t} WHERE space_id = ?`)
        .get(other.space_id) as { c: number };
      expect(`${t}-other=${count.c}`).toBe(`${t}-other=${otherExpected[t]}`);
    }
  });
});
