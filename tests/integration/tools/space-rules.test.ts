import { describe, expect, it } from 'bun:test';
import { createSqliteClient } from '../../../src/infra/db/sqlite-client.js';
import { SqliteEventStore } from '../../../src/infra/db/sqlite-event-store.js';
import { rebuildProjections } from '../../../src/infra/projections/rebuild.js';
import { createTeamemTools } from '../../../src/server/tools/index.js';
import { stableRulesHash } from '../../../src/server/tools/space-rules.js';
import { runAllMigrations } from '../../helpers/migrations.js';

function setup() {
  const db = createSqliteClient(':memory:');
  runAllMigrations(db);
  const store = new SqliteEventStore(db);
  const tools = createTeamemTools({ db, store });

  db.exec(
    `INSERT INTO spaces (id, label, creator_member_id, created_at)
     VALUES ('space-rules-tools', 'Rules Space', 'm-alice', '2026-05-10T00:00:00.000Z')`
  );
  db.exec(
    `INSERT INTO members (id, space_id, name, joined_at, is_creator)
     VALUES
       ('m-alice', 'space-rules-tools', 'alice', '2026-05-10T00:00:00.000Z', 1),
       ('m-bob', 'space-rules-tools', 'bob', '2026-05-10T00:01:00.000Z', 0)`
  );

  return { db, tools };
}

function countRuleEvents(db: ReturnType<typeof createSqliteClient>): number {
  return (
    db
      .query(
        `SELECT COUNT(*) AS c
           FROM events
          WHERE event_type IN ('space_rule_added', 'space_rule_amended', 'space_rule_disabled')`
      )
      .get() as { c: number }
  ).c;
}

describe('space rules tool lifecycle', () => {
  it('rejects non-creator publishes without side effects', () => {
    const { db, tools } = setup();

    const result = tools.updateSpaceRules({
      space_id: 'space-rules-tools',
      principal: 'bob',
      actor: 'bob/agent',
      delegation: 'bob->agent',
      rules_markdown: 'Prefer focused diffs.',
      base_version: 0,
      base_hash: stableRulesHash('')
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('not_creator');
    expect(countRuleEvents(db)).toBe(0);
    const projectionCount = (
      db
        .query(
          'SELECT COUNT(*) AS c FROM space_rules_snapshots WHERE space_id = ?1'
        )
        .get('space-rules-tools') as { c: number }
    ).c;
    expect(projectionCount).toBe(0);
  });

  it('records add, amend, and disable lifecycle events and rebuilds the same snapshot', () => {
    const { db, tools } = setup();

    const added = tools.updateSpaceRules({
      space_id: 'space-rules-tools',
      principal: 'alice',
      actor: 'alice/agent',
      delegation: 'alice->agent',
      rules_markdown: 'Prefer focused diffs.',
      base_version: 0,
      base_hash: stableRulesHash('')
    });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(added.data.metadata.rules_version).toBe(1);
    expect(added.data.metadata.rules_hash).toBe(
      stableRulesHash('Prefer focused diffs.')
    );

    const amended = tools.updateSpaceRules({
      space_id: 'space-rules-tools',
      principal: 'alice',
      actor: 'alice/agent',
      delegation: 'alice->agent',
      rules_markdown: 'Prefer focused diffs.\nRead the briefing first.',
      base_version: added.data.metadata.rules_version,
      base_hash: added.data.metadata.rules_hash
    });
    expect(amended.ok).toBe(true);
    if (!amended.ok) return;
    expect(amended.data.metadata.rules_version).toBe(2);

    const disabled = tools.updateSpaceRules({
      space_id: 'space-rules-tools',
      principal: 'alice',
      actor: 'alice/agent',
      delegation: 'alice->agent',
      rules_markdown: '',
      base_version: amended.data.metadata.rules_version,
      base_hash: amended.data.metadata.rules_hash
    });
    expect(disabled.ok).toBe(true);
    if (!disabled.ok) return;
    expect(disabled.data.has_server_rules).toBe(false);
    expect(disabled.data.metadata.rules_version).toBe(3);
    expect(disabled.data.metadata.rules_hash).toBe(stableRulesHash(''));

    const eventTypes = (
      db
        .query(
          `SELECT event_type
             FROM events
            WHERE space_id = ?1
            ORDER BY timestamp ASC`
        )
        .all('space-rules-tools') as Array<{ event_type: string }>
    ).map((row) => row.event_type);
    expect(eventTypes).toEqual([
      'space_rule_added',
      'space_rule_amended',
      'space_rule_disabled'
    ]);

    const projection = db
      .query(
        `SELECT rules_markdown, rules_version, is_disabled
           FROM space_rules_snapshots
          WHERE space_id = ?1`
      )
      .get('space-rules-tools') as {
      rules_markdown: string;
      rules_version: number;
      is_disabled: number;
    } | null;
    expect(projection).not.toBeNull();
    expect(projection?.rules_markdown).toBe('');
    expect(projection?.rules_version).toBe(3);
    expect(projection?.is_disabled).toBe(1);

    const beforeRebuild = tools.exportSpaceRulesSnapshot({
      space_id: 'space-rules-tools',
      principal: 'alice'
    });
    expect(beforeRebuild.ok).toBe(true);
    rebuildProjections(db, 'space-rules-tools');
    const afterRebuild = tools.exportSpaceRulesSnapshot({
      space_id: 'space-rules-tools',
      principal: 'alice'
    });
    expect(afterRebuild.ok).toBe(true);
    if (!beforeRebuild.ok || !afterRebuild.ok) return;
    expect(afterRebuild.data.has_server_rules).toBe(
      beforeRebuild.data.has_server_rules
    );
    expect(afterRebuild.data.rendered_rules_body).toBe(
      beforeRebuild.data.rendered_rules_body
    );
    expect(afterRebuild.data.metadata.rules_version).toBe(
      beforeRebuild.data.metadata.rules_version
    );
    expect(afterRebuild.data.metadata.rules_hash).toBe(
      beforeRebuild.data.metadata.rules_hash
    );
    expect(afterRebuild.data.metadata.source_event_id).toBe(
      beforeRebuild.data.metadata.source_event_id
    );
    expect(afterRebuild.data.metadata.snapshot_updated_at).toBe(
      beforeRebuild.data.metadata.snapshot_updated_at
    );
    expect(afterRebuild.data.metadata.snapshot_updated_by).toBe(
      beforeRebuild.data.metadata.snapshot_updated_by
    );
  });

  it('returns a typed stale-publish conflict instead of overwriting newer rules', () => {
    const { db, tools } = setup();

    const published = tools.updateSpaceRules({
      space_id: 'space-rules-tools',
      principal: 'alice',
      actor: 'alice/agent',
      delegation: 'alice->agent',
      rules_markdown: 'Prefer focused diffs.',
      base_version: 0,
      base_hash: stableRulesHash('')
    });
    expect(published.ok).toBe(true);

    const stale = tools.updateSpaceRules({
      space_id: 'space-rules-tools',
      principal: 'alice',
      actor: 'alice/agent',
      delegation: 'alice->agent',
      rules_markdown: 'Overwriting stale draft.',
      base_version: 0,
      base_hash: stableRulesHash('')
    });

    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.error.code).toBe('space_rules_conflict');
    expect(stale.error.details).toEqual({
      current_version: 1,
      current_hash: stableRulesHash('Prefer focused diffs.'),
      current_source_event_id: expect.any(String),
      has_server_rules: true
    });
    expect(countRuleEvents(db)).toBe(1);
  });
});
