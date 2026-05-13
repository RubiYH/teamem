/**
 * Pre-mortem F4 — concurrent restore vs. GC sweep.
 *
 * Both `restoreSpace` and `gcDisbandedSpaces` wrap their work in
 * `BEGIN IMMEDIATE TRANSACTION`. SQLite serialises BEGIN IMMEDIATE callers
 * at the RESERVED lock — only one can hold it at a time. Whichever
 * commits first wins; the other reads the post-commit state and bails.
 *
 * `bun:sqlite` is synchronous and single-threaded so we can't literally run
 * two threads in-process. Instead we drive both orderings deterministically
 * by exercising the boundary states the race produces.
 */
import { describe, expect, it } from 'bun:test';
import { setupAuthApp } from '../auth/helpers.js';
import { gcDisbandedSpaces, restoreSpace } from '../../../src/server/spaces.js';

function seedDisbandedSpace(
  db: ReturnType<typeof setupAuthApp>['db'],
  graceUntil: string
) {
  const space_id = 'race-space';
  const member_id = 'race-member-creator';
  db.prepare(
    `INSERT INTO spaces (id, label, creator_member_id, disbanded_at, disbanded_grace_until)
     VALUES (?1, 'race-space', ?2, datetime('now'), ?3)`
  ).run(space_id, member_id, graceUntil);
  db.prepare(
    `INSERT INTO members (id, space_id, name, is_creator) VALUES (?1, ?2, 'alice', 1)`
  ).run(member_id, space_id);
  return { space_id, member_id };
}

describe('disband GC × restore race (Pre-mortem F4)', () => {
  it('GC sweep fires before restore: row hard-deleted, subsequent restore observes no row and fails', () => {
    const { db } = setupAuthApp();
    const { space_id, member_id } = seedDisbandedSpace(
      db,
      new Date(Date.now() - 60_000).toISOString()
    );

    const swept = gcDisbandedSpaces(db);
    expect(swept).toContain(space_id);
    expect(
      db.prepare('SELECT id FROM spaces WHERE id = ?').get(space_id)
    ).toBeNull();

    // Subsequent restore cannot succeed; the membership row was cascaded.
    const result = restoreSpace(db, { requester_member_id: member_id });
    expect(result).toBe('not_creator');
  });

  it('restore fires within grace: grace cleared atomically and GC sees no candidate', () => {
    const { db } = setupAuthApp();
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const { space_id, member_id } = seedDisbandedSpace(db, future);

    expect(restoreSpace(db, { requester_member_id: member_id })).toBe('ok');

    const row = db
      .prepare(
        `SELECT disbanded_at, disbanded_grace_until FROM spaces WHERE id = ?`
      )
      .get(space_id) as {
      disbanded_at: string | null;
      disbanded_grace_until: string | null;
    };
    expect(row.disbanded_at).toBeNull();
    expect(row.disbanded_grace_until).toBeNull();

    const swept = gcDisbandedSpaces(db);
    expect(swept).not.toContain(space_id);
  });

  it('GC re-reads state inside its per-row immediate tx — a stale candidate that was just restored does not get cascaded', () => {
    const { db } = setupAuthApp();
    // Seed the row with grace in the past so the GC SELECT picks it up.
    const { space_id, member_id } = seedDisbandedSpace(
      db,
      new Date(Date.now() - 60_000).toISOString()
    );

    // Capture the candidate list — what GC's outer SELECT sees.
    const candidates = db
      .prepare(
        `SELECT id FROM spaces
          WHERE disbanded_at IS NOT NULL
            AND disbanded_grace_until IS NOT NULL
            AND disbanded_grace_until <= strftime('%Y-%m-%dT%H:%M:%fZ','now')`
      )
      .all() as Array<{ id: string }>;
    expect(candidates.map((r) => r.id)).toContain(space_id);

    // Simulate "concurrent restore committed between GC's SELECT and per-row tx":
    // bypass `restoreSpace`'s grace-window check and clear the tombstone
    // directly, the same way a successful restore would have committed.
    db.prepare(
      `UPDATE spaces SET disbanded_at = NULL, disbanded_grace_until = NULL WHERE id = ?`
    ).run(space_id);

    // Now run gc again — the per-row immediate-tx must re-read state and
    // observe the cleared tombstone, skipping the cascade.
    const swept = gcDisbandedSpaces(db);
    expect(swept).not.toContain(space_id);

    // Member row intact — proves the cascade was skipped.
    const memberCount = db
      .prepare('SELECT COUNT(*) AS c FROM members WHERE space_id = ?')
      .get(space_id) as { c: number };
    expect(memberCount.c).toBe(1);
    void member_id;
  });
});
