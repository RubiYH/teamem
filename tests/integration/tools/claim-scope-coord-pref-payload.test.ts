import { describe, expect, it } from 'bun:test';
import { runAllMigrations } from '../../helpers/migrations.js';
import { createSqliteClient } from '../../../src/infra/db/sqlite-client.js';
import { SqliteEventStore } from '../../../src/infra/db/sqlite-event-store.js';
import { createTeamemTools } from '../../../src/server/tools/index.js';

const SPACE = 'space-claim-pref-payload';

function setup() {
  const db = createSqliteClient(':memory:');
  runAllMigrations(db);
  db.exec(
    `INSERT INTO spaces (id, label, creator_member_id, created_at) VALUES
       ('${SPACE}', 'Test', 'm-alice', '2026-05-01T00:00:00.000Z')`
  );
  db.exec(
    `INSERT INTO members (id, space_id, name, joined_at, is_creator, coord_pref) VALUES
       ('m-alice', '${SPACE}', 'alice', '2026-05-01T00:00:00.000Z', 1, 'ask-claimant'),
       ('m-bob',   '${SPACE}', 'bob',   '2026-05-01T00:01:00.000Z', 0, 'auto-skip')`
  );
  const store = new SqliteEventStore(db);
  const tools = createTeamemTools({ db, store });
  return { tools };
}

describe('claim_scope conflict coord-pref payload', () => {
  it('includes normalized requester and incumbent prefs so hooks do not depend on briefing summaries', () => {
    const { tools } = setup();
    const alice = tools.claimScope({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      scope: { paths: ['src/components/FilterButton.jsx'] },
      intent: 'incumbent claim'
    });
    expect(alice.ok).toBe(true);

    const bob = tools.claimScope({
      space_id: SPACE,
      principal: 'bob',
      actor: 'bob',
      delegation: 'bob->bob',
      scope: { paths: ['src/components/FilterButton.jsx'] },
      intent: 'requester edit'
    });

    expect(bob.ok).toBe(false);
    if (!bob.ok) {
      const err = bob.error as typeof bob.error & {
        conflicting_principal: string;
        requester_coord_pref: string;
        incumbent_coord_pref: string;
      };
      expect(err.code).toBe('scope_conflict');
      expect(err.conflicting_principal).toBe('alice');
      expect(err.requester_coord_pref).toBe('auto-skip');
      expect(err.incumbent_coord_pref).toBe('auto-skip');
    }
  });
});
