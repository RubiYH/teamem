import { runAllMigrations } from '../../helpers/migrations.js';
import { describe, expect, it } from 'bun:test';
import { createSqliteClient } from '../../../src/infra/db/sqlite-client.js';
import { SqliteEventStore } from '../../../src/infra/db/sqlite-event-store.js';
import { createToolRegistry } from '../../../src/server/tool-registry.js';
import { createTeamemTools } from '../../../src/server/tools/index.js';

function setup() {
  const db = createSqliteClient(':memory:');
  runAllMigrations(db);
  const store = new SqliteEventStore(db);
  const tools = createTeamemTools({ db, store });
  return { db, tools, registry: createToolRegistry(tools) };
}

describe('teamem tool registry', () => {
  it('registers v1 tool names without deprecated publish_event / detect_conflicts', () => {
    const { registry } = setup();
    const names = Object.keys(registry);
    expect(names).toContain('teamem.get_briefing');
    expect(names).toContain('teamem.claim_scope');
    expect(names).toContain('teamem.export_space_rules_snapshot');
    expect(names).toContain('teamem.session_sync');
    expect(names).toContain('teamem.publish_decision');
    expect(names).toContain('teamem.amend_decision');
    expect(names).toContain('teamem.supersede_decision');
    expect(names).toContain('teamem.update_space_rules');
    expect(names).toContain('teamem.get_finding');
    expect(names).toContain('teamem.acknowledge_finding');
    expect(names).not.toContain('teamem.publish_event');
    expect(names).not.toContain('teamem.detect_conflicts');
  });
});

describe('teamem tools', () => {
  it('publishes (server-internal) and reads updates', () => {
    const { tools } = setup();
    const publish = tools.publishEvent({
      schema_version: '1.0',
      event_id: 'evt-tool-1',
      idempotency_key: 'idem-tool-1',
      space_id: 'teamem-poc',
      timestamp: '2026-04-30T00:00:00.000Z',
      principal: 'alice',
      actor: 'claude/session-1',
      delegation: 'alice->claude',
      event_type: 'task_started',
      scope: { paths: ['src/index.ts'] },
      payload: { task_id: 'TASK-1' }
    });

    expect(publish.ok).toBe(true);

    const updates = tools.getUpdates({ space_id: 'teamem-poc' });
    expect(updates.ok).toBe(true);
    if (updates.ok) {
      expect(updates.data.events).toHaveLength(1);
    }
  });

  it('creates claim that surfaces in active_claims briefing', () => {
    const { tools } = setup();

    const claim = tools.claimScope({
      space_id: 'teamem-poc',
      principal: 'alice',
      actor: 'claude/session-1',
      delegation: 'alice->claude',
      scope: { paths: ['src/index.ts'] }
    });

    expect(claim.ok).toBe(true);
  });

  it('returns a deterministic Space Rules snapshot hash that excludes generated_at', () => {
    const { db, tools } = setup();

    db.exec(
      `INSERT INTO spaces (id, label, creator_member_id, created_at)
       VALUES ('space-rules-tools', 'Rules Space', 'm-alice', '2026-05-10T00:00:00.000Z')`
    );
    db.exec(
      `INSERT INTO members (id, space_id, name, joined_at, is_creator)
       VALUES ('m-alice', 'space-rules-tools', 'alice', '2026-05-10T00:00:00.000Z', 1)`
    );
    db.exec(
      `INSERT INTO space_rules_snapshots (space_id, rules_markdown, rules_version, source_event_id, updated_at, updated_by_member_id)
       VALUES (
         'space-rules-tools',
         'Always read the briefing before editing.\nClaim your scope before writing code.',
         7,
         'evt-rules-tools',
         '2026-05-10T01:02:03.000Z',
         'm-alice'
       )`
    );

    const first = tools.exportSpaceRulesSnapshot({
      space_id: 'space-rules-tools',
      principal: 'alice'
    });
    const second = tools.exportSpaceRulesSnapshot({
      space_id: 'space-rules-tools',
      principal: 'alice'
    });
    db.exec(
      `UPDATE space_rules_snapshots
          SET rules_version = 8,
              source_event_id = 'evt-rules-tools-2',
              updated_at = '2026-05-10T04:05:06.000Z'
        WHERE space_id = 'space-rules-tools'`
    );
    const third = tools.exportSpaceRulesSnapshot({
      space_id: 'space-rules-tools',
      principal: 'alice'
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(third.ok).toBe(true);
    if (!first.ok || !second.ok || !third.ok) return;

    expect(first.data.has_server_rules).toBe(true);
    expect(first.data.rendered_rules_body).toContain(
      'Always read the briefing'
    );
    expect(first.data.metadata.managed_begin).toBe(
      '<!-- BEGIN TEAMEM SPACE RULES -->'
    );
    expect(first.data.metadata.managed_end).toBe(
      '<!-- END TEAMEM SPACE RULES -->'
    );
    expect(first.data.metadata.rules_version).toBe(7);
    expect(first.data.metadata.source_event_id).toBe('evt-rules-tools');
    expect(first.data.metadata.snapshot_updated_by).toBe('alice');
    expect(first.data.metadata.rules_hash).toBe(
      second.data.metadata.rules_hash
    );
    expect(first.data.metadata.rules_hash).toBe(third.data.metadata.rules_hash);
    expect(third.data.metadata.rules_version).toBe(8);
    expect(third.data.metadata.source_event_id).toBe('evt-rules-tools-2');
    expect(first.data.metadata.generated_at).toBeTruthy();
    expect(second.data.metadata.generated_at).toBeTruthy();
  });

  it('returns session_sync with the dedicated Space Rules snapshot payload', () => {
    const { db, tools } = setup();

    db.exec(
      `INSERT INTO spaces (id, label, creator_member_id, created_at)
       VALUES ('space-rules-sync', 'Rules Sync', 'm-alice', '2026-05-10T00:00:00.000Z')`
    );
    db.exec(
      `INSERT INTO members (id, space_id, name, joined_at, is_creator)
       VALUES ('m-alice', 'space-rules-sync', 'alice', '2026-05-10T00:00:00.000Z', 1)`
    );
    db.exec(
      `INSERT INTO space_rules_snapshots (space_id, rules_markdown, rules_version, source_event_id, updated_at, updated_by_member_id)
       VALUES (
         'space-rules-sync',
         'Always read the current plan.',
         2,
         'evt-sync-2',
         '2026-05-10T02:00:00.000Z',
         'm-alice'
       )`
    );

    const sync = tools.sessionSync({
      space_id: 'space-rules-sync',
      principal: 'alice'
    });

    expect(sync.ok).toBe(true);
    if (!sync.ok) return;
    expect(sync.data.space_rules_snapshot.has_server_rules).toBe(true);
    expect(sync.data.space_rules_snapshot.rendered_rules_body).toBe(
      'Always read the current plan.'
    );
    expect(sync.data.space_rules_snapshot.metadata.rules_version).toBe(2);
    expect(sync.data.decision_replays).toEqual([]);
    expect(sync.data.gotcha_notices).toEqual([]);
  });

  it('returns rules, decision replay, and gotcha notices together through session_sync', () => {
    const { db, tools } = setup();

    db.exec(
      `INSERT INTO spaces (id, label, creator_member_id, created_at)
       VALUES ('space-memory-sync', 'Space Memory Sync', 'm-alice', '2026-05-10T00:00:00.000Z')`
    );
    db.exec(
      `INSERT INTO members (id, space_id, name, joined_at, is_creator)
       VALUES ('m-alice', 'space-memory-sync', 'alice', '2026-05-10T00:00:00.000Z', 1),
              ('m-bob', 'space-memory-sync', 'bob', '2026-05-10T00:00:00.000Z', 0)`
    );
    db.exec(
      `INSERT INTO space_rules_snapshots (space_id, rules_markdown, rules_version, source_event_id, updated_at, updated_by_member_id)
       VALUES (
         'space-memory-sync',
         'Refresh TEAMEM.md only from the dedicated server snapshot.',
         5,
         'evt-rules-space-memory',
         '2026-05-10T02:00:00.000Z',
         'm-alice'
       )`
    );

    const claim = tools.claimScope({
      space_id: 'space-memory-sync',
      principal: 'bob',
      actor: 'bob/agent',
      delegation: 'bob->agent',
      scope: { paths: ['plugin/scripts/session-start.sh'] }
    });
    expect(claim.ok).toBe(true);

    const decision = tools.publishDecision({
      space_id: 'space-memory-sync',
      principal: 'alice',
      actor: 'alice/agent',
      delegation: 'alice->agent',
      decision_id: 'dec-space-memory-sync',
      title: 'Use session_sync as the catch-up path',
      summary: 'SessionStart should consume a single integrated payload.',
      body: 'Decision replay bodies must remain available during offline catch-up.',
      kind: 'process'
    });
    expect(decision.ok).toBe(true);

    const gotcha = tools.shareFinding({
      space_id: 'space-memory-sync',
      principal: 'alice',
      actor: 'alice/agent',
      delegation: 'alice->agent',
      kind: 'gotcha',
      summary: 'Refresh TEAMEM.md only from the server snapshot.',
      body: 'Do not trust the local file as the authority.',
      paths: ['plugin/scripts/session-start.sh'],
      tags: ['space-memory'],
      severity: 'warning'
    });
    expect(gotcha.ok).toBe(true);
    if (!gotcha.ok) return;

    const sync = tools.sessionSync({
      space_id: 'space-memory-sync',
      principal: 'bob'
    });

    expect(sync.ok).toBe(true);
    if (!sync.ok) return;
    expect(sync.data.space_rules_snapshot.has_server_rules).toBe(true);
    expect(sync.data.space_rules_snapshot.metadata.rules_version).toBe(5);
    expect(sync.data.decision_replays).toHaveLength(1);
    expect(sync.data.decisions).toHaveLength(1);
    expect(sync.data.decision_replays[0]).toMatchObject({
      event_type: 'decision_published',
      payload: {
        decision_id: 'dec-space-memory-sync',
        body: 'Decision replay bodies must remain available during offline catch-up.',
        version: 1
      }
    });
    expect(sync.data.gotcha_notices).toHaveLength(1);
    expect(sync.data.gotcha_notices[0]).toMatchObject({
      event_type: 'gotcha_notice',
      payload: {
        finding_id: gotcha.data.finding_id,
        summary: 'Refresh TEAMEM.md only from the server snapshot.',
        severity: 'warning',
        paths: ['plugin/scripts/session-start.sh'],
        relevance: 'path_overlap'
      }
    });
    expect('body' in sync.data.gotcha_notices[0].payload).toBe(false);
  });
});
