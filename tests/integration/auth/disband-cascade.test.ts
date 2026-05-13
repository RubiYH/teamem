/**
 * Soft-disband behavior — under ADR-0004, `POST /spaces/disband` no longer
 * runs the synchronous hard cascade. Instead it sets `disbanded_at = now`
 * and `disbanded_grace_until = now + 7 days`. Data is retained for the
 * grace window; the periodic GC sweep runs the hard cascade only after
 * grace elapses.
 *
 * JWT rejection is immediate — the auth middleware filter
 * `s.disbanded_at IS NULL` already gates `410 space_disbanded`. This test
 * asserts:
 *   - All projection tables retain rows post-disband (no cascade).
 *   - `spaces.disbanded_at` and `disbanded_grace_until` are both set.
 *   - The creator's JWT is rejected with 410 immediately.
 *   - Rows for an unrelated space are untouched.
 *
 * The hard-cascade behavior moved into `gcDisbandedSpaces` and is covered
 * by `tests/integration/space/disband-grace.test.ts`.
 */
import { describe, expect, it } from 'bun:test';
import { setupAuthApp } from './helpers.js';

async function post(
  app: ReturnType<typeof setupAuthApp>['app'],
  path: string,
  body: unknown,
  token?: string
) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json'
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return app.request(path, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
}

interface SeededSpace {
  space_id: string;
  jwt: string;
  label: string;
}

async function seedRowsForSpace(
  db: ReturnType<typeof setupAuthApp>['db'],
  space_id: string,
  prefix: string
): Promise<void> {
  const now = new Date().toISOString();

  // 5 events
  for (let i = 0; i < 5; i++) {
    db.prepare(
      `INSERT INTO events (
        event_id, idempotency_key, space_id, timestamp, principal, actor, delegation,
        event_type, scope_json, payload_json, refs_json, confidence, schema_version, raw_json
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`
    ).run(
      `${prefix}-evt-${i}`,
      `${prefix}-idem-${i}`,
      space_id,
      now,
      'alice',
      'alice/agent',
      'alice->agent',
      'task_started',
      '{}',
      '{}',
      null,
      null,
      '1.0',
      '{}'
    );
  }

  // 2 claims
  for (let i = 0; i < 2; i++) {
    db.prepare(
      `INSERT INTO claims (claim_id, space_id, principal, actor, scope_json, intent, status, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
    ).run(
      `${prefix}-claim-${i}`,
      space_id,
      'alice',
      'alice/agent',
      '{}',
      'test',
      'active',
      now
    );
  }

  // 1 decision
  db.prepare(
    `INSERT INTO decisions (decision_id, space_id, title, status, summary, updated_at, source_event_id, kind, decided_by)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
  ).run(
    `${prefix}-dec-1`,
    space_id,
    'test decision',
    'open',
    'summary',
    now,
    `${prefix}-evt-0`,
    'architectural',
    'alice'
  );

  // 1 blocker
  db.prepare(
    `INSERT INTO blockers (blocker_id, space_id, status, owner_principal, summary, updated_at, source_event_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
  ).run(
    `${prefix}-block-1`,
    space_id,
    'open',
    'alice',
    'test blocker',
    now,
    `${prefix}-evt-0`
  );

  // 1 contract
  db.prepare(
    `INSERT INTO contracts (contract_key, space_id, state_json, updated_at, updated_by_event_id)
     VALUES (?1, ?2, ?3, ?4, ?5)`
  ).run(`${prefix}-contract-1`, space_id, '{}', now, `${prefix}-evt-0`);

  // 1 cursor
  db.prepare(
    `INSERT INTO cursors (actor, space_id, cursor_value, updated_at)
     VALUES (?1, ?2, ?3, ?4)`
  ).run(`${prefix}/agent`, space_id, `${prefix}-evt-4`, now);

  // 1 task_state
  db.prepare(
    `INSERT INTO task_state (task_id, space_id, principal, status, what, updated_at, source_event_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
  ).run(
    `${prefix}-task-1`,
    space_id,
    'alice',
    'in_progress',
    'doing',
    now,
    `${prefix}-evt-0`
  );
}

interface CountRow {
  c: number;
}

function countAll(
  db: ReturnType<typeof setupAuthApp>['db'],
  space_id: string
): Record<string, number> {
  const tables = [
    'events',
    'claims',
    'decisions',
    'blockers',
    'contracts',
    'cursors',
    'task_state',
    'members',
    'room_codes'
  ];
  const out: Record<string, number> = {};
  for (const t of tables) {
    const row = db
      .prepare(`SELECT COUNT(*) AS c FROM ${t} WHERE space_id = ?`)
      .get(space_id) as CountRow | null;
    out[t] = row?.c ?? 0;
  }
  return out;
}

async function bootstrapSpace(
  app: ReturnType<typeof setupAuthApp>['app'],
  member_name: string,
  label: string
): Promise<SeededSpace> {
  const res = await post(app, '/spaces', { member_name, label });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { space_id: string; jwt: string };
  return { space_id: body.space_id, jwt: body.jwt, label };
}

describe('soft-disband — data retention + immediate JWT rejection (ADR-0004)', () => {
  it('retains every projection row, sets grace window, and rejects subsequent calls with 410', async () => {
    const { app, db } = setupAuthApp();

    const target = await bootstrapSpace(app, 'alice', 'target-space');
    const other = await bootstrapSpace(app, 'bob', 'other-space');

    await seedRowsForSpace(db, target.space_id, 'tgt');
    await seedRowsForSpace(db, other.space_id, 'oth');

    const before = countAll(db, target.space_id);
    expect(before.events).toBe(5);
    expect(before.claims).toBe(2);
    expect(before.members).toBe(1);

    const disbandRes = await post(
      app,
      '/spaces/disband',
      { label_confirmation: 'target-space' },
      target.jwt
    );
    expect(disbandRes.status).toBe(200);

    // Soft-disband retains every row — the projection tables look the same
    // as before disband, only `spaces` is tombstoned.
    const after = countAll(db, target.space_id);
    for (const t of Object.keys(after)) {
      expect(`${t}=${after[t]}`).toBe(`${t}=${before[t]}`);
    }

    const spaceRow = db
      .prepare(
        `SELECT disbanded_at, disbanded_grace_until FROM spaces WHERE id = ?`
      )
      .get(target.space_id) as {
      disbanded_at: string | null;
      disbanded_grace_until: string | null;
    } | null;
    expect(spaceRow).not.toBeNull();
    expect(spaceRow!.disbanded_at).not.toBeNull();
    expect(spaceRow!.disbanded_grace_until).not.toBeNull();
    // Grace ends ~7 days out (allow ±5min slack for slow CI).
    const graceMs = new Date(spaceRow!.disbanded_grace_until!).getTime();
    const now = Date.now();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    expect(Math.abs(graceMs - now - sevenDaysMs)).toBeLessThan(5 * 60 * 1000);

    // Other space untouched.
    const otherCounts = countAll(db, other.space_id);
    expect(otherCounts.events).toBe(5);
    expect(otherCounts.claims).toBe(2);
    expect(otherCounts.members).toBe(1);

    // The creator's JWT is rejected with 410 immediately on any /tools call.
    const claimRes = await post(
      app,
      '/tools/teamem.claim_scope',
      {
        actor: 'alice/agent',
        delegation: 'alice->agent',
        scope: { paths: ['src/after-disband.ts'] },
        intent: 'should-fail'
      },
      target.jwt
    );
    expect(claimRes.status).toBe(410);
    const claimBody = (await claimRes.json()) as { error: string };
    expect(claimBody.error).toBe('space_disbanded');
  });
});
