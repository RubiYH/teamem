import { describe, expect, it } from 'bun:test';
import { runAllMigrations } from '../../helpers/migrations.js';
import { createSqliteClient } from '../../../src/infra/db/sqlite-client.js';
import { SqliteEventStore } from '../../../src/infra/db/sqlite-event-store.js';
import { createTeamemTools } from '../../../src/server/tools/index.js';

function setup() {
  const db = createSqliteClient(':memory:');
  runAllMigrations(db);
  db.prepare(
    `INSERT INTO spaces (id, label, creator_member_id, created_at)
     VALUES (?1, ?2, ?3, ?4)`
  ).run('teamem-poc', 'teamem-poc', 'member-alice', '2026-05-10T00:00:00.000Z');
  const insertMember = db.prepare(
    `INSERT INTO members (id, space_id, name, is_creator, joined_at, left_at)
     VALUES (?1, ?2, ?3, ?4, ?5, NULL)`
  );
  insertMember.run(
    'member-alice',
    'teamem-poc',
    'alice',
    1,
    '2026-05-10T00:00:00.000Z'
  );
  insertMember.run(
    'member-bob',
    'teamem-poc',
    'bob',
    0,
    '2026-05-10T00:00:01.000Z'
  );
  insertMember.run(
    'member-carol',
    'teamem-poc',
    'carol',
    0,
    '2026-05-10T00:00:02.000Z'
  );
  const store = new SqliteEventStore(db);
  const tools = createTeamemTools({ db, store });
  return { db, tools };
}

describe('decision lifecycle tools', () => {
  it('publishes a new decision and records explicit current-state fields', () => {
    const { db, tools } = setup();

    const result = tools.publishDecision({
      space_id: 'teamem-poc',
      principal: 'alice',
      actor: 'alice/agent',
      delegation: 'alice->agent',
      decision_id: 'dec-1',
      title: 'Use ULID for all IDs',
      summary: 'Replace Date.now() with ulidx to avoid collisions.',
      body: 'This becomes the durable decision text.',
      kind: 'architectural'
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.lifecycle_event).toBe('decision_published');
    expect(result.data.version).toBe(1);

    const row = db
      .query(
        `SELECT decision_id, title, status, version, latest_event_type, body
           FROM decisions
          WHERE decision_id = ?1`
      )
      .get('dec-1') as
      | {
          decision_id: string;
          title: string;
          status: string;
          version: number;
          latest_event_type: string;
          body: string | null;
        }
      | undefined;

    expect(row?.decision_id).toBe('dec-1');
    expect(row?.status).toBe('open');
    expect(row?.version).toBe(1);
    expect(row?.latest_event_type).toBe('decision_published');
    expect(row?.body).toBe('This becomes the durable decision text.');
  });

  it('record_decision reuses an id by appending an explicit amendment instead of overwriting silently', () => {
    const { db, tools } = setup();

    const first = tools.recordDecision({
      space_id: 'teamem-poc',
      principal: 'alice',
      actor: 'alice/agent',
      delegation: 'alice->agent',
      decision_id: 'dec-reused',
      title: 'Initial direction',
      summary: 'Use the bridge.',
      kind: 'architectural'
    });
    const second = tools.recordDecision({
      space_id: 'teamem-poc',
      principal: 'bob',
      actor: 'bob/agent',
      delegation: 'bob->agent',
      decision_id: 'dec-reused',
      title: 'Initial direction',
      summary: 'Use the bridge and persist lifecycle state.',
      body: 'This second write should become an amendment.',
      kind: 'architectural'
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.lifecycle_event).toBe('decision_amended');
    expect(second.data.version).toBe(2);

    const current = db
      .query(
        `SELECT summary, body, version, latest_event_type
           FROM decisions
          WHERE decision_id = ?1`
      )
      .get('dec-reused') as
      | {
          summary: string | null;
          body: string | null;
          version: number;
          latest_event_type: string;
        }
      | undefined;
    expect(current?.summary).toBe(
      'Use the bridge and persist lifecycle state.'
    );
    expect(current?.body).toBe('This second write should become an amendment.');
    expect(current?.version).toBe(2);
    expect(current?.latest_event_type).toBe('decision_amended');

    const history = db
      .query(
        `SELECT lifecycle_event, version, summary
           FROM decision_history
          WHERE decision_id = ?1
          ORDER BY version ASC`
      )
      .all('dec-reused') as Array<{
      lifecycle_event: string;
      version: number;
      summary: string | null;
    }>;
    expect(history).toHaveLength(2);
    expect(history[0]).toEqual({
      lifecycle_event: 'decision_published',
      version: 1,
      summary: 'Use the bridge.'
    });
    expect(history[1]).toEqual({
      lifecycle_event: 'decision_amended',
      version: 2,
      summary: 'Use the bridge and persist lifecycle state.'
    });
  });

  it('supersedes an existing decision explicitly and preserves its history', () => {
    const { db, tools } = setup();

    const published = tools.publishDecision({
      space_id: 'teamem-poc',
      principal: 'alice',
      actor: 'alice/agent',
      delegation: 'alice->agent',
      decision_id: 'dec-old-plan',
      title: 'Old plan',
      summary: 'Ship phase 1 first.',
      kind: 'plan'
    });
    expect(published.ok).toBe(true);

    const successor = tools.publishDecision({
      space_id: 'teamem-poc',
      principal: 'bob',
      actor: 'bob/agent',
      delegation: 'bob->agent',
      decision_id: 'dec-new-plan',
      title: 'New plan',
      summary: 'Ship phase 2 first.',
      kind: 'plan',
      supersedes_decision_id: 'dec-old-plan'
    });

    expect(successor.ok).toBe(true);
    if (!successor.ok) return;
    expect(successor.data.affected_decision_ids).toContain('dec-old-plan');

    const oldRow = db
      .query(
        `SELECT status, version, latest_event_type, superseded_by_decision_id
           FROM decisions
          WHERE decision_id = ?1`
      )
      .get('dec-old-plan') as
      | {
          status: string;
          version: number;
          latest_event_type: string;
          superseded_by_decision_id: string | null;
        }
      | undefined;

    expect(oldRow?.status).toBe('superseded');
    expect(oldRow?.version).toBe(2);
    expect(oldRow?.latest_event_type).toBe('decision_superseded');
    expect(oldRow?.superseded_by_decision_id).toBe('dec-new-plan');
  });

  it('event_id returned by recordDecision is a valid ULID', () => {
    const { tools } = setup();

    const result = tools.recordDecision({
      space_id: 'teamem-poc',
      principal: 'alice',
      actor: 'alice/agent',
      delegation: 'alice->agent',
      decision_id: 'dec-ulid-check',
      title: 'ULID format check'
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.event_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    }
  });

  it('session_sync replays a published decision with full text exactly once per principal', () => {
    const { tools } = setup();

    const published = tools.publishDecision({
      space_id: 'teamem-poc',
      principal: 'alice',
      actor: 'alice/agent',
      delegation: 'alice->agent',
      decision_id: 'dec-session-sync',
      title: 'Keep full text in replay',
      summary: 'Decisions should replay with durable body text.',
      body: 'Full body for SessionStart replay.',
      kind: 'process'
    });
    expect(published.ok).toBe(true);

    const bobFirst = tools.sessionSync({
      space_id: 'teamem-poc',
      principal: 'bob'
    });
    expect(bobFirst.ok).toBe(true);
    if (!bobFirst.ok) return;
    expect(bobFirst.data.decisions).toHaveLength(1);
    expect(bobFirst.data.decisions[0]).toMatchObject({
      event_type: 'decision_published',
      principal: 'bob',
      payload: {
        decision_id: 'dec-session-sync',
        title: 'Keep full text in replay',
        summary: 'Decisions should replay with durable body text.',
        body: 'Full body for SessionStart replay.',
        kind: 'process',
        version: 1
      }
    });

    const bobSecond = tools.sessionSync({
      space_id: 'teamem-poc',
      principal: 'bob'
    });
    expect(bobSecond.ok).toBe(true);
    if (!bobSecond.ok) return;
    expect(bobSecond.data.decisions).toEqual([]);

    const aliceSync = tools.sessionSync({
      space_id: 'teamem-poc',
      principal: 'alice'
    });
    expect(aliceSync.ok).toBe(true);
    if (!aliceSync.ok) return;
    expect(aliceSync.data.decisions).toEqual([]);

    const carolSync = tools.sessionSync({
      space_id: 'teamem-poc',
      principal: 'carol'
    });
    expect(carolSync.ok).toBe(true);
    if (!carolSync.ok) return;
    expect(carolSync.data.decisions).toHaveLength(1);
    expect(carolSync.data.decisions[0]?.payload.decision_id).toBe(
      'dec-session-sync'
    );
  });

  it('dedupes online get_updates delivery from later session_sync replay', () => {
    const { tools } = setup();

    const published = tools.publishDecision({
      space_id: 'teamem-poc',
      principal: 'alice',
      actor: 'alice/agent',
      delegation: 'alice->agent',
      decision_id: 'dec-online-dedupe',
      title: 'Online viewers should not replay later',
      body: 'This body should arrive through the online channel path.',
      kind: 'architectural'
    });
    expect(published.ok).toBe(true);

    const updates = tools.getUpdates({
      space_id: 'teamem-poc',
      principal: 'bob',
      actor: 'bob',
      limit: 50
    });
    expect(updates.ok).toBe(true);
    if (!updates.ok) return;
    expect(
      updates.data.events.some(
        (event) =>
          event.event_type === 'decision_published' &&
          event.payload?.decision_id === 'dec-online-dedupe' &&
          event.payload?.body ===
            'This body should arrive through the online channel path.'
      )
    ).toBe(true);

    const bobSync = tools.sessionSync({
      space_id: 'teamem-poc',
      principal: 'bob'
    });
    expect(bobSync.ok).toBe(true);
    if (!bobSync.ok) return;
    expect(bobSync.data.decisions).toEqual([]);

    const carolSync = tools.sessionSync({
      space_id: 'teamem-poc',
      principal: 'carol'
    });
    expect(carolSync.ok).toBe(true);
    if (!carolSync.ok) return;
    expect(carolSync.data.decisions).toHaveLength(1);
    expect(carolSync.data.decisions[0]?.payload.decision_id).toBe(
      'dec-online-dedupe'
    );
  });

  it('treats amend and supersede as newly unseen decision lifecycle events', () => {
    const { tools } = setup();

    const published = tools.publishDecision({
      space_id: 'teamem-poc',
      principal: 'alice',
      actor: 'alice/agent',
      delegation: 'alice->agent',
      decision_id: 'dec-lifecycle-replay',
      title: 'Lifecycle replay seed',
      summary: 'v1',
      body: 'body-v1',
      kind: 'product'
    });
    expect(published.ok).toBe(true);

    const firstReplay = tools.sessionSync({
      space_id: 'teamem-poc',
      principal: 'bob'
    });
    expect(firstReplay.ok).toBe(true);
    if (!firstReplay.ok) return;
    expect(firstReplay.data.decisions).toHaveLength(1);
    expect(firstReplay.data.decisions[0]?.event_type).toBe(
      'decision_published'
    );

    const amended = tools.amendDecision({
      space_id: 'teamem-poc',
      principal: 'alice',
      actor: 'alice/agent',
      delegation: 'alice->agent',
      decision_id: 'dec-lifecycle-replay',
      summary: 'v2',
      body: 'body-v2'
    });
    expect(amended.ok).toBe(true);

    const amendReplay = tools.sessionSync({
      space_id: 'teamem-poc',
      principal: 'bob'
    });
    expect(amendReplay.ok).toBe(true);
    if (!amendReplay.ok) return;
    expect(amendReplay.data.decisions).toHaveLength(1);
    expect(amendReplay.data.decisions[0]).toMatchObject({
      event_type: 'decision_amended',
      payload: {
        decision_id: 'dec-lifecycle-replay',
        summary: 'v2',
        body: 'body-v2',
        version: 2
      }
    });

    const superseded = tools.supersedeDecision({
      space_id: 'teamem-poc',
      principal: 'alice',
      actor: 'alice/agent',
      delegation: 'alice->agent',
      decision_id: 'dec-lifecycle-replay',
      superseded_by_decision_id: 'dec-successor'
    });
    expect(superseded.ok).toBe(true);

    const supersedeReplay = tools.sessionSync({
      space_id: 'teamem-poc',
      principal: 'bob'
    });
    expect(supersedeReplay.ok).toBe(true);
    if (!supersedeReplay.ok) return;
    expect(supersedeReplay.data.decisions).toHaveLength(1);
    expect(supersedeReplay.data.decisions[0]).toMatchObject({
      event_type: 'decision_superseded',
      payload: {
        decision_id: 'dec-lifecycle-replay',
        body: 'body-v2',
        version: 3,
        superseded_by_decision_id: 'dec-successor'
      }
    });
  });
});
