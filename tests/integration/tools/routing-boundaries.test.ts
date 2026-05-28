import { describe, expect, it } from 'bun:test';
import { runAllMigrations } from '../../helpers/migrations.js';
import { createSqliteClient } from '../../../src/infra/db/sqlite-client.js';
import { SqliteEventStore } from '../../../src/infra/db/sqlite-event-store.js';
import { createTeamemTools } from '../../../src/server/tools/index.js';
import type { TeamemEvent } from '../../../src/domain/events/types.js';
import { EventValidationError } from '../../../src/domain/events/errors.js';
import { stableRulesHash } from '../../../src/server/tools/space-rules.js';

function setup() {
  const db = createSqliteClient(':memory:');
  runAllMigrations(db);
  db.exec(
    `INSERT INTO spaces (id, label, creator_member_id, created_at)
     VALUES ('space-1', 'Routing Space', 'm-alice', '2026-05-27T00:00:00.000Z')`
  );
  db.exec(
    `INSERT INTO members (id, space_id, name, joined_at, is_creator)
     VALUES
       ('m-alice', 'space-1', 'alice', '2026-05-27T00:00:00.000Z', 1),
       ('m-bob', 'space-1', 'bob', '2026-05-27T00:00:01.000Z', 0),
       ('m-carol', 'space-1', 'carol', '2026-05-27T00:00:02.000Z', 0),
       ('m-dana', 'space-1', 'dana', '2026-05-27T00:00:03.000Z', 0)`
  );
  const store = new SqliteEventStore(db);
  const tools = createTeamemTools({ db, store });
  return { db, store, tools };
}

function baseEvent(overrides: Partial<TeamemEvent> = {}): TeamemEvent {
  return {
    schema_version: '1.0',
    event_id: 'evt-routing-base',
    idempotency_key: 'idem-routing-base',
    space_id: 'space-1',
    timestamp: '2026-05-27T00:10:00.000Z',
    principal: 'alice',
    actor: 'alice',
    delegation: 'alice->teamem',
    event_type: 'task_started',
    sprint_id: null,
    delivery_scope: 'space',
    scope: {},
    payload: { task_id: 'task-1' },
    ...overrides
  };
}

function insertLegacyRawEvent(
  db: ReturnType<typeof createSqliteClient>,
  event: TeamemEvent
) {
  db.prepare(
    `INSERT INTO events (
      event_id, idempotency_key, space_id, timestamp, principal, actor,
      delegation, event_type, scope_json, payload_json, refs_json, confidence,
      schema_version, raw_json
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL, NULL, ?11, ?12)`
  ).run(
    event.event_id,
    event.idempotency_key,
    event.space_id,
    event.timestamp,
    event.principal,
    event.actor,
    event.delegation,
    event.event_type,
    JSON.stringify(event.scope),
    JSON.stringify(event.payload),
    event.schema_version,
    JSON.stringify(event)
  );
}

function eventTypesFor(
  tools: ReturnType<typeof createTeamemTools>,
  principal: string
): string[] {
  const updates = tools.getUpdates({ space_id: 'space-1', principal });
  expect(updates.ok).toBe(true);
  if (!updates.ok) return [];
  return updates.data.events.map((event) => event.event_id);
}

function readStoredEvent(
  db: ReturnType<typeof createSqliteClient>,
  eventId: string
): TeamemEvent {
  const row = db
    .prepare('SELECT raw_json FROM events WHERE event_id = ?1')
    .get(eventId) as { raw_json: string } | null;
  if (!row) throw new Error(`event not found: ${eventId}`);
  return JSON.parse(row.raw_json) as TeamemEvent;
}

function toolsWithFailingSprintLookup(
  db: ReturnType<typeof createSqliteClient>,
  store: SqliteEventStore
) {
  const faultyDb = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'prepare') {
        return (sql: string) => {
          if (sql.includes('sprint_memberships')) {
            throw new Error('simulated Sprint membership lookup failure');
          }
          return target.prepare(sql);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  }) as ReturnType<typeof createSqliteClient>;
  return createTeamemTools({ db: faultyDb, store });
}

describe('routing metadata and live delivery boundaries', () => {
  it('validates new write routing invariants at publishEvent', () => {
    const { tools } = setup();

    expect(
      tools.publishEvent({
        ...baseEvent(),
        event_id: 'evt-missing-routing',
        idempotency_key: 'idem-missing-routing',
        sprint_id: undefined,
        delivery_scope: undefined
      }).ok
    ).toBe(false);

    const directWithoutRecipients = tools.publishEvent({
      ...baseEvent({
        event_id: 'evt-direct-missing',
        idempotency_key: 'idem-direct-missing',
        delivery_scope: 'direct'
      })
    });
    expect(directWithoutRecipients.ok).toBe(false);

    const sprintWithoutSprint = tools.publishEvent({
      ...baseEvent({
        event_id: 'evt-sprint-missing',
        idempotency_key: 'idem-sprint-missing',
        delivery_scope: 'sprint',
        sprint_id: null
      })
    });
    expect(sprintWithoutSprint.ok).toBe(false);

    const spaceWithSprint = tools.publishEvent({
      ...baseEvent({
        event_id: 'evt-space-sprint',
        idempotency_key: 'idem-space-sprint',
        delivery_scope: 'space',
        sprint_id: 'sprint-1'
      })
    });
    expect(spaceWithSprint.ok).toBe(false);

    const broadWithRecipients = tools.publishEvent({
      ...baseEvent({
        event_id: 'evt-space-recipients',
        idempotency_key: 'idem-space-recipients',
        delivery_scope: 'space',
        recipient_principals: []
      })
    });
    expect(broadWithRecipients.ok).toBe(false);

    const valid = tools.publishEvent({
      ...baseEvent({
        event_id: 'evt-direct-valid',
        idempotency_key: 'idem-direct-valid',
        delivery_scope: 'direct',
        sprint_id: 'sprint-context',
        recipient_principals: ['bob']
      })
    });
    expect(valid.ok).toBe(true);
  });

  it('normalizes legacy routing metadata only when reading events', () => {
    const { db, store } = setup();
    insertLegacyRawEvent(
      db,
      baseEvent({
        event_id: 'evt-legacy-direct',
        idempotency_key: 'idem-legacy-direct',
        sprint_id: undefined,
        delivery_scope: undefined,
        payload: {
          task_id: 'task-1',
          recipient_principal: 'bob'
        }
      })
    );
    insertLegacyRawEvent(
      db,
      baseEvent({
        event_id: 'evt-legacy-sprint',
        idempotency_key: 'idem-legacy-sprint',
        sprint_id: 'sprint-legacy',
        delivery_scope: undefined
      })
    );

    const events = store.getUpdates('space-1');
    expect(events[0]).toMatchObject({
      event_id: 'evt-legacy-direct',
      sprint_id: null,
      delivery_scope: 'direct'
    });
    expect(events[1]).toMatchObject({
      event_id: 'evt-legacy-sprint',
      sprint_id: 'sprint-legacy',
      delivery_scope: 'sprint'
    });
  });

  it('rejects internal writes without explicit routing metadata', () => {
    const { store } = setup();
    const missingRouting = baseEvent({
      event_id: 'evt-internal-missing-routing',
      idempotency_key: 'idem-internal-missing-routing'
    });
    delete missingRouting.sprint_id;
    delete missingRouting.delivery_scope;

    try {
      store.appendInTx(missingRouting);
      throw new Error('appendInTx accepted missing routing metadata');
    } catch (error) {
      expect(error).toBeInstanceOf(EventValidationError);
      expect((error as EventValidationError).issues).toContainEqual(
        expect.objectContaining({ path: '$.sprint_id' })
      );
    }
  });

  it('does not deliver ordinary Space events to Sprint-mode members', () => {
    const { tools } = setup();
    const sprint = tools.createSprint({
      space_id: 'space-1',
      principal: 'alice',
      display_name: 'Focused Sprint',
      goal: 'Keep Sprint feeds scoped'
    });
    expect(sprint.ok).toBe(true);
    tools.joinSprint({
      space_id: 'space-1',
      principal: 'bob',
      sprint: 'focused-sprint'
    });

    const ordinarySpaceEvent = tools.publishEvent({
      ...baseEvent({
        event_id: 'evt-ordinary-space',
        idempotency_key: 'idem-ordinary-space',
        principal: 'carol',
        actor: 'carol',
        delegation: 'carol->teamem',
        delivery_scope: 'space',
        sprint_id: null
      })
    });
    expect(ordinarySpaceEvent.ok).toBe(true);

    expect(eventTypesFor(tools, 'bob')).not.toContain('evt-ordinary-space');
    expect(eventTypesFor(tools, 'dana')).toContain('evt-ordinary-space');
  });

  it('does not turn Space-mode updates into an all-Sprints lifecycle feed', () => {
    const { tools } = setup();
    const sprint = tools.createSprint({
      space_id: 'space-1',
      principal: 'carol',
      display_name: 'Hidden Lifecycle',
      goal: 'Lifecycle should stay scoped'
    });
    expect(sprint.ok).toBe(true);
    if (!sprint.ok) return;

    const updates = tools.getUpdates({
      space_id: 'space-1',
      principal: 'alice'
    });
    expect(updates.ok).toBe(true);
    if (!updates.ok) return;
    expect(updates.data.events.map((event) => event.event_type)).not.toEqual(
      expect.arrayContaining(['sprint_created', 'sprint_joined'])
    );
    expect(updates.data.events.map((event) => event.event_id)).not.toEqual(
      expect.arrayContaining(sprint.data.event_ids)
    );
  });

  it('fails closed when getUpdates cannot read Sprint membership context', () => {
    const { db, store, tools } = setup();
    const sprint = tools.createSprint({
      space_id: 'space-1',
      principal: 'alice',
      display_name: 'Unavailable Lookup',
      goal: 'Do not widen reads'
    });
    expect(sprint.ok).toBe(true);
    tools.joinSprint({
      space_id: 'space-1',
      principal: 'bob',
      sprint: 'unavailable-lookup'
    });
    const ordinarySpaceEvent = tools.publishEvent({
      ...baseEvent({
        event_id: 'evt-unavailable-space',
        idempotency_key: 'idem-unavailable-space',
        principal: 'carol',
        actor: 'carol',
        delegation: 'carol->teamem',
        delivery_scope: 'space',
        sprint_id: null
      })
    });
    expect(ordinarySpaceEvent.ok).toBe(true);

    const failingTools = toolsWithFailingSprintLookup(db, store);
    const updates = failingTools.getUpdates({
      space_id: 'space-1',
      principal: 'bob'
    });
    expect(updates.ok).toBe(false);
    if (updates.ok) return;
    expect(updates.error.code).toBe('sprint_context_unavailable');
  });

  it('fails closed when discussion routing cannot read Sprint membership context', () => {
    const { db, store, tools } = setup();
    const sprint = tools.createSprint({
      space_id: 'space-1',
      principal: 'alice',
      display_name: 'Discussion Lookup',
      goal: 'Do not widen posts'
    });
    expect(sprint.ok).toBe(true);

    const failingTools = toolsWithFailingSprintLookup(db, store);
    const posted = failingTools.postMessage({
      space_id: 'space-1',
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->teamem',
      recipient_principal: null,
      body: 'should not widen to space'
    });
    expect(posted.ok).toBe(false);
    if (posted.ok) return;
    expect(posted.error.code).toBe('sprint_context_unavailable');
  });

  it('does not silently stamp producer events as Space when Sprint membership lookup fails', () => {
    const { db, store, tools } = setup();
    const sprint = tools.createSprint({
      space_id: 'space-1',
      principal: 'alice',
      display_name: 'Producer Lookup',
      goal: 'Do not widen stamps'
    });
    expect(sprint.ok).toBe(true);

    const failingTools = toolsWithFailingSprintLookup(db, store);
    expect(() =>
      failingTools.shareArtifact({
        space_id: 'space-1',
        principal: 'alice',
        actor: 'alice',
        delegation: 'alice->teamem',
        kind: 'doc',
        uri: 'docs/fail-closed.md',
        title: 'Fail closed'
      })
    ).toThrow('failed to read current Sprint membership');
  });

  it('routes direct, Sprint broadcast, Space broadcast, and non-current Sprint updates', () => {
    const { db, tools } = setup();

    const sprintOne = tools.createSprint({
      space_id: 'space-1',
      principal: 'alice',
      display_name: 'Sprint One',
      goal: 'First sprint'
    });
    expect(sprintOne.ok).toBe(true);
    if (!sprintOne.ok) return;
    const sprintOneId = sprintOne.data.sprint?.sprint_id ?? null;
    tools.joinSprint({
      space_id: 'space-1',
      principal: 'bob',
      sprint: 'sprint-one'
    });

    const sprintTwo = tools.createSprint({
      space_id: 'space-1',
      principal: 'carol',
      display_name: 'Sprint Two',
      goal: 'Second sprint'
    });
    expect(sprintTwo.ok).toBe(true);

    const direct = tools.postMessage({
      space_id: 'space-1',
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->teamem',
      recipient_principal: 'carol',
      body: 'direct across sprints'
    });
    expect(direct.ok).toBe(true);
    if (!direct.ok) return;
    expect(direct.data.delivery_scope).toBe('direct');
    expect(direct.data.sprint_id).toBe(sprintOneId);
    expect(direct.data.recipient_principals).toEqual(['carol']);

    const sprintBroadcast = tools.postMessage({
      space_id: 'space-1',
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->teamem',
      recipient_principal: null,
      body: 'sprint only'
    });
    expect(sprintBroadcast.ok).toBe(true);
    if (!sprintBroadcast.ok) return;
    expect(sprintBroadcast.data.delivery_scope).toBe('sprint');
    expect(sprintBroadcast.data.broadcast_hint).toContain('**');

    const otherSprintBroadcast = tools.postMessage({
      space_id: 'space-1',
      principal: 'carol',
      actor: 'carol',
      delegation: 'carol->teamem',
      recipient_principal: null,
      body: 'other sprint only'
    });
    expect(otherSprintBroadcast.ok).toBe(true);

    const spaceEscalation = tools.postMessage({
      space_id: 'space-1',
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->teamem',
      recipient_principal: '**',
      body: 'space escalation'
    });
    expect(spaceEscalation.ok).toBe(true);
    if (!spaceEscalation.ok) return;
    expect(spaceEscalation.data.delivery_scope).toBe('space');
    expect(spaceEscalation.data.sprint_id).toBeNull();

    const storedDirect = db
      .prepare('SELECT raw_json FROM events WHERE event_id = ?1')
      .get(direct.data.event_id) as { raw_json: string };
    expect(JSON.parse(storedDirect.raw_json)).toMatchObject({
      delivery_scope: 'direct',
      recipient_principals: ['carol']
    });

    expect(eventTypesFor(tools, 'bob')).toContain(
      sprintBroadcast.data.event_id
    );
    expect(eventTypesFor(tools, 'bob')).toContain(
      spaceEscalation.data.event_id
    );
    expect(eventTypesFor(tools, 'bob')).not.toContain(
      otherSprintBroadcast.ok ? otherSprintBroadcast.data.event_id : ''
    );
    expect(eventTypesFor(tools, 'carol')).toContain(direct.data.event_id);
    expect(eventTypesFor(tools, 'carol')).toContain(
      spaceEscalation.data.event_id
    );
    expect(eventTypesFor(tools, 'dana')).toContain(
      spaceEscalation.data.event_id
    );
    expect(eventTypesFor(tools, 'dana')).not.toContain(
      sprintBroadcast.data.event_id
    );
  });

  it('uses membership-derived Sprint fanout instead of frozen recipients', () => {
    const { tools } = setup();
    const sprint = tools.createSprint({
      space_id: 'space-1',
      principal: 'alice',
      display_name: 'Membership Fanout',
      goal: 'Read-time membership'
    });
    expect(sprint.ok).toBe(true);

    const broadcast = tools.postMessage({
      space_id: 'space-1',
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->teamem',
      recipient_principal: null,
      body: 'read time fanout'
    });
    expect(broadcast.ok).toBe(true);
    if (!broadcast.ok) return;
    expect(broadcast.data.recipient_principals).toEqual([]);

    tools.joinSprint({
      space_id: 'space-1',
      principal: 'bob',
      sprint: 'membership-fanout'
    });

    expect(eventTypesFor(tools, 'bob')).toContain(broadcast.data.event_id);
  });

  it('advances cursors over filtered non-current Sprint events', () => {
    const { tools } = setup();
    const sprintOne = tools.createSprint({
      space_id: 'space-1',
      principal: 'alice',
      display_name: 'Cursor One',
      goal: 'Visible sprint'
    });
    expect(sprintOne.ok).toBe(true);
    tools.joinSprint({
      space_id: 'space-1',
      principal: 'bob',
      sprint: 'cursor-one'
    });
    const sprintTwo = tools.createSprint({
      space_id: 'space-1',
      principal: 'carol',
      display_name: 'Cursor Two',
      goal: 'Hidden sprint'
    });
    expect(sprintTwo.ok).toBe(true);
    if (!sprintTwo.ok) return;
    const hiddenEventId = 'zz-hidden-cursor-event';

    const before = tools.getUpdates({ space_id: 'space-1', principal: 'bob' });
    expect(before.ok).toBe(true);
    if (!before.ok) return;

    const hidden = tools.publishEvent({
      ...baseEvent({
        event_id: hiddenEventId,
        idempotency_key: 'idem-hidden-cursor-event',
        principal: 'carol',
        actor: 'carol',
        delegation: 'carol->teamem',
        delivery_scope: 'sprint',
        sprint_id: sprintTwo.data.sprint?.sprint_id ?? null
      }),
      payload: { task_id: 'hidden-task' }
    });
    expect(hidden.ok).toBe(true);
    if (!hidden.ok) return;

    const updates = tools.getUpdates({
      space_id: 'space-1',
      principal: 'bob',
      since: before.data.next_cursor ?? undefined
    });
    expect(updates.ok).toBe(true);
    if (!updates.ok) return;
    expect(updates.data.events.map((event) => event.event_id)).not.toContain(
      hiddenEventId
    );
    expect(updates.data.next_cursor).toBe(hiddenEventId);
  });

  it('applies get_updates limit after current-mode routing', () => {
    const { tools } = setup();
    const sprintOne = tools.createSprint({
      space_id: 'space-1',
      principal: 'alice',
      display_name: 'Status One',
      goal: 'Visible sprint'
    });
    expect(sprintOne.ok).toBe(true);
    tools.joinSprint({
      space_id: 'space-1',
      principal: 'bob',
      sprint: 'status-one'
    });
    const sprintTwo = tools.createSprint({
      space_id: 'space-1',
      principal: 'carol',
      display_name: 'Status Two',
      goal: 'Hidden sprint'
    });
    expect(sprintTwo.ok).toBe(true);

    const direct = tools.publishEvent({
      ...baseEvent({
        event_id: 'zz1-visible-status-direct',
        idempotency_key: 'idem-visible-status-direct',
        principal: 'carol',
        actor: 'carol',
        delegation: 'carol->teamem',
        delivery_scope: 'direct',
        sprint_id: sprintTwo.ok
          ? (sprintTwo.data.sprint?.sprint_id ?? null)
          : null,
        recipient_principals: ['bob']
      }),
      payload: { summary: 'direct visible status update' }
    });
    expect(direct.ok).toBe(true);

    for (let i = 0; i < 5; i++) {
      const hidden = tools.publishEvent({
        ...baseEvent({
          event_id: `zz2-hidden-status-noise-${i}`,
          idempotency_key: `idem-hidden-status-noise-${i}`,
          principal: 'carol',
          actor: 'carol',
          delegation: 'carol->teamem',
          delivery_scope: 'sprint',
          sprint_id: sprintTwo.ok
            ? (sprintTwo.data.sprint?.sprint_id ?? null)
            : null
        }),
        payload: { summary: `hidden status noise ${i}` }
      });
      expect(hidden.ok).toBe(true);
    }
    const secondDirect = tools.publishEvent({
      ...baseEvent({
        event_id: 'zz3-visible-status-direct',
        idempotency_key: 'idem-visible-status-direct-2',
        principal: 'carol',
        actor: 'carol',
        delegation: 'carol->teamem',
        delivery_scope: 'direct',
        sprint_id: sprintTwo.ok
          ? (sprintTwo.data.sprint?.sprint_id ?? null)
          : null,
        recipient_principals: ['bob']
      }),
      payload: { summary: 'second visible status update' }
    });
    expect(secondDirect.ok).toBe(true);

    const updates = tools.getUpdates({
      space_id: 'space-1',
      principal: 'bob',
      since: 'zz0-status-cursor',
      limit: 1
    });
    expect(updates.ok).toBe(true);
    if (!updates.ok) return;
    expect(updates.data.events.map((event) => event.event_id)).toEqual([
      'zz1-visible-status-direct'
    ]);
    const next = tools.getUpdates({
      space_id: 'space-1',
      principal: 'bob',
      since: updates.data.next_cursor ?? undefined,
      limit: 1
    });
    expect(next.ok).toBe(true);
    if (!next.ok) return;
    expect(next.data.events.map((event) => event.event_id)).toEqual([
      'zz3-visible-status-direct'
    ]);
  });

  it('bounds get_updates raw scans and advances the cursor over hidden traffic', () => {
    const { db, store, tools } = setup();
    const sprintOne = tools.createSprint({
      space_id: 'space-1',
      principal: 'alice',
      display_name: 'Bounded One',
      goal: 'Visible sprint'
    });
    expect(sprintOne.ok).toBe(true);
    tools.joinSprint({
      space_id: 'space-1',
      principal: 'bob',
      sprint: 'bounded-one'
    });
    const sprintTwo = tools.createSprint({
      space_id: 'space-1',
      principal: 'carol',
      display_name: 'Bounded Two',
      goal: 'Hidden sprint'
    });
    expect(sprintTwo.ok).toBe(true);
    if (!sprintTwo.ok) return;
    const hiddenSprintId = sprintTwo.data.sprint?.sprint_id ?? null;

    for (let i = 0; i < 1200; i++) {
      const hidden = tools.publishEvent({
        ...baseEvent({
          event_id: `zz1-hidden-bounded-${String(i).padStart(4, '0')}`,
          idempotency_key: `idem-hidden-bounded-${i}`,
          principal: 'carol',
          actor: 'carol',
          delegation: 'carol->teamem',
          delivery_scope: 'sprint',
          sprint_id: hiddenSprintId
        }),
        payload: { summary: `hidden bounded noise ${i}` }
      });
      expect(hidden.ok).toBe(true);
    }

    const visible = tools.publishEvent({
      ...baseEvent({
        event_id: 'zz2-visible-after-bounded-window',
        idempotency_key: 'idem-visible-after-bounded-window',
        principal: 'carol',
        actor: 'carol',
        delegation: 'carol->teamem',
        delivery_scope: 'direct',
        sprint_id: hiddenSprintId,
        recipient_principals: ['bob']
      }),
      payload: { summary: 'visible after bounded window' }
    });
    expect(visible.ok).toBe(true);

    let rawPageCalls = 0;
    const countingStore = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop !== 'getUpdates') return Reflect.get(target, prop, receiver);
        return (...args: Parameters<SqliteEventStore['getUpdates']>) => {
          rawPageCalls += 1;
          return target.getUpdates(...args);
        };
      }
    }) as SqliteEventStore;
    const countingTools = createTeamemTools({ db, store: countingStore });

    const first = countingTools.getUpdates({
      space_id: 'space-1',
      principal: 'bob',
      since: 'zz0-bounded-cursor',
      limit: 1
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.events).toEqual([]);
    expect(first.data.next_cursor).toBe('zz1-hidden-bounded-0999');
    expect(rawPageCalls).toBe(2);

    const second = countingTools.getUpdates({
      space_id: 'space-1',
      principal: 'bob',
      since: first.data.next_cursor ?? undefined,
      limit: 1
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.events.map((event) => event.event_id)).toEqual([
      'zz2-visible-after-bounded-window'
    ]);
  });

  it('stamps internally produced producer-family events with routing metadata', () => {
    const { db, tools } = setup();
    const sprint = tools.createSprint({
      space_id: 'space-1',
      principal: 'alice',
      display_name: 'Producer Routing',
      goal: 'Route internal writes'
    });
    expect(sprint.ok).toBe(true);
    if (!sprint.ok) return;
    const sprintId = sprint.data.sprint?.sprint_id ?? null;
    expect(sprintId).toBeTruthy();
    tools.joinSprint({
      space_id: 'space-1',
      principal: 'bob',
      sprint: 'producer-routing'
    });

    const claim = tools.claimScope({
      space_id: 'space-1',
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->teamem',
      scope: { paths: ['src/index.ts'] }
    });
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;

    const artifact = tools.shareArtifact({
      space_id: 'space-1',
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->teamem',
      kind: 'doc',
      uri: 'docs/routing.md',
      title: 'Routing'
    });
    expect(artifact.ok).toBe(true);
    if (!artifact.ok) return;

    const focus = tools.agentFocusChanged({
      space_id: 'space-1',
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->teamem',
      scope: { paths: ['src/index.ts'] },
      intent: 'route focus'
    });
    expect(focus.ok).toBe(true);
    if (!focus.ok) return;

    const queued = tools.queuePendingEdit({
      space_id: 'space-1',
      principal: 'bob',
      actor: 'bob',
      delegation: 'bob->teamem',
      blocking_claim_id: claim.data.claim_id,
      paths: ['src/index.ts'],
      intent: 'route queue'
    });
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;

    const rules = tools.updateSpaceRules({
      space_id: 'space-1',
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->teamem',
      rules_markdown: 'Prefer explicit routing.',
      base_version: 0,
      base_hash: stableRulesHash('')
    });
    expect(rules.ok).toBe(true);
    if (!rules.ok) return;

    const producerEvents = [
      artifact.data.event_id,
      focus.data.event_id,
      queued.data.event_id
    ].map((eventId) => readStoredEvent(db, eventId));
    for (const event of producerEvents) {
      expect(event).toMatchObject({
        sprint_id: sprintId,
        delivery_scope: 'sprint'
      });
    }

    const ruleEventId = rules.data.metadata.source_event_id;
    expect(ruleEventId).toBeTruthy();
    if (!ruleEventId) return;
    expect(readStoredEvent(db, ruleEventId)).toMatchObject({
      sprint_id: null,
      delivery_scope: 'space'
    });
  });
});
