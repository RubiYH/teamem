/**
 * Codex F1 regression — hard-wipe must not leave stale idempotency keys.
 *
 * Original bug: `wipeSpace({hard:true})` deleted `events` first, then tried
 * to delete `idempotency_keys` whose `event_id IN (SELECT … FROM events …)`
 * — but the events were already gone, so the inner SELECT returned an
 * empty set and every key was preserved. A fresh claim with the same
 * deterministic key (space_id + principal + scope) collided invisibly.
 *
 * Fix: delete idempotency_keys BEFORE events.
 *
 * This test issues a deterministic claim, hard-wipes the space, then
 * issues an identical claim. Without the fix this fails on the second
 * claim with `Idempotency conflict` (or surfaces an `idempotency_collision`
 * error code via the F3 recovery path under `TEAMEM_IDEMPOTENCY_RECOVERY`).
 */
import { describe, expect, it } from 'bun:test';
import { runAllMigrations } from '../../helpers/migrations.js';
import { createSqliteClient } from '../../../src/infra/db/sqlite-client.js';
import { SqliteEventStore } from '../../../src/infra/db/sqlite-event-store.js';
import { createTeamemTools } from '../../../src/server/tools/index.js';
import {
  createSpace,
  wipeSpace,
  getMemberById
} from '../../../src/server/spaces.js';

const TEST_JWT_SECRET = 'test-secret-32bytes-padded-xxxxx';

describe('hard-wipe idempotency-key cleanup (Codex F1)', () => {
  it('a deterministic claim_scope succeeds against a hard-wiped space without collision', async () => {
    const db = createSqliteClient(':memory:');
    runAllMigrations(db);
    const store = new SqliteEventStore(db);
    const tools = createTeamemTools({ db, store });

    const space = await createSpace(
      db,
      { label: 'wipe-idempotency', member_name: 'alice' },
      TEST_JWT_SECRET
    );
    const aliceMember = getMemberById(db, space.member_id);
    expect(aliceMember).not.toBeNull();

    // First claim — populates idempotency_keys with a deterministic key
    // derived from (space_id, 'alice', sorted normalized paths).
    const firstClaim = tools.claimScope({
      space_id: space.space_id,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      scope: { paths: ['src/auth/login.ts'] },
      intent: 'first claim'
    });
    if (!firstClaim.ok) throw new Error('first claim should succeed');
    const firstClaimId = firstClaim.data.claim_id;

    // Confirm the idempotency_keys row exists for the event we just wrote.
    const keysBefore = db
      .prepare('SELECT COUNT(*) AS c FROM idempotency_keys')
      .get() as { c: number };
    expect(keysBefore.c).toBeGreaterThan(0);

    // Hard-wipe the space.
    const wipe = wipeSpace(db, {
      requester_member_id: space.member_id,
      hard: true
    });
    expect(wipe).toEqual({ ok: true, wiped_at: expect.any(String) });

    // Post-wipe: events for this space are gone, AND idempotency_keys tied
    // to those events are gone (Codex F1 fix).
    const eventsAfter = db
      .prepare('SELECT COUNT(*) AS c FROM events WHERE space_id = ?')
      .get(space.space_id) as { c: number };
    expect(eventsAfter.c).toBe(0);

    // The idempotency_keys row tied to the first claim's event must be
    // cleared. With the bug, it would survive and cause the next claim to
    // collide on the deterministic key.
    const keysAfter = db
      .prepare('SELECT COUNT(*) AS c FROM idempotency_keys')
      .get() as { c: number };
    expect(keysAfter.c).toBe(0);

    // Second claim with identical scope. Must succeed — same deterministic
    // key, but no stale row to collide with.
    const secondClaim = tools.claimScope({
      space_id: space.space_id,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      scope: { paths: ['src/auth/login.ts'] },
      intent: 'second claim'
    });
    expect(secondClaim.ok).toBe(true);
    if (secondClaim.ok) {
      // New claim_id (the prior claim row was hard-wiped), but no error code.
      expect(secondClaim.data.claim_id).not.toBe(firstClaimId);
      expect(secondClaim.data.claim_id).toMatch(/^[0-9A-Z]{26}$/);
    }
  });
});
