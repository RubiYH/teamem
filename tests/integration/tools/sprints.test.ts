import { describe, expect, it } from 'bun:test';
import { runAllMigrations } from '../../helpers/migrations.js';
import { createSqliteClient } from '../../../src/infra/db/sqlite-client.js';
import { SqliteEventStore } from '../../../src/infra/db/sqlite-event-store.js';
import { createToolRegistry } from '../../../src/server/tool-registry.js';
import { createTeamemTools } from '../../../src/server/tools/index.js';

function setup() {
  const db = createSqliteClient(':memory:');
  runAllMigrations(db);
  db.exec(
    `INSERT INTO spaces (id, label, creator_member_id, created_at)
     VALUES ('space-1', 'Sprint Space', 'm-alice', '2026-05-27T00:00:00.000Z')`
  );
  db.exec(
    `INSERT INTO members (id, space_id, name, joined_at, is_creator)
     VALUES
       ('m-alice', 'space-1', 'alice', '2026-05-27T00:00:00.000Z', 1),
       ('m-bob', 'space-1', 'bob', '2026-05-27T00:00:01.000Z', 0),
       ('m-carol', 'space-1', 'carol', '2026-05-27T00:00:02.000Z', 0)`
  );
  const store = new SqliteEventStore(db);
  const tools = createTeamemTools({ db, store });
  return { db, tools, registry: createToolRegistry(tools) };
}

function eventCount(db: ReturnType<typeof createSqliteClient>, type: string) {
  return (
    db
      .query('SELECT COUNT(*) AS c FROM events WHERE event_type = ?1')
      .get(type) as { c: number }
  ).c;
}

function rawLifecycleEvents(db: ReturnType<typeof createSqliteClient>) {
  const rows = db
    .query(
      `SELECT raw_json FROM events
       WHERE event_type IN ('sprint_created', 'sprint_joined', 'sprint_left', 'sprint_archived', 'sprint_reopened')
       ORDER BY rowid ASC`
    )
    .all() as Array<{ raw_json: string }>;
  return rows.map((row) => JSON.parse(row.raw_json));
}

function claim(
  tools: ReturnType<typeof createTeamemTools>,
  principal: string,
  path: string
) {
  return tools.claimScope({
    space_id: 'space-1',
    principal,
    actor: principal,
    delegation: `${principal}->teamem`,
    scope: { paths: [path] },
    repo_id: 'github.com/org/repo',
    branch: 'feature/sprint'
  });
}

function withDuplicateSprintBeforeNextTransaction(
  db: ReturnType<typeof createSqliteClient>
) {
  let inserted = false;
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop !== 'transaction') {
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return (callback: () => unknown) => {
        const tx = target.transaction(callback);
        const runImmediate = () => {
          if (!inserted) {
            inserted = true;
            target
              .prepare(
                `INSERT INTO sprints
                 (sprint_id, space_id, slug, display_name, goal, status,
                  created_at, created_by, archived_at, archived_by, source_event_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, 'active', ?6, ?7, NULL, NULL, ?8)`
              )
              .run(
                'sprint-race',
                'space-1',
                'race-sprint',
                'Race Sprint',
                'Already inserted by concurrent creator.',
                '2026-05-27T00:02:00.000Z',
                'bob',
                'evt-race'
              );
          }
          return tx.immediate();
        };
        return Object.assign(() => tx(), {
          immediate: runImmediate,
          deferred: () => tx.deferred(),
          exclusive: () => tx.exclusive()
        });
      };
    }
  });
}

describe('sprint lifecycle tools', () => {
  it('registers the Issue 01 Sprint MCP tools', () => {
    const { registry } = setup();
    expect(Object.keys(registry)).toEqual(
      expect.arrayContaining([
        'teamem.create_sprint',
        'teamem.join_sprint',
        'teamem.leave_sprint',
        'teamem.get_current_sprint'
      ])
    );
  });

  it('creates, joins, leaves, and reports Space mode explicitly', () => {
    const { db, tools } = setup();

    const create = tools.createSprint({
      space_id: 'space-1',
      principal: 'alice',
      display_name: '  Sprint: MVP Lifecycle!! ',
      goal: '  Build lifecycle path. '
    });
    expect(create.ok).toBe(true);
    if (!create.ok) return;
    expect(create.data.sprint?.slug).toBe('sprint-mvp-lifecycle');
    expect(create.data.old_context.mode).toBe('space');
    expect(create.data.new_context.mode).toBe('sprint');
    expect(create.data.event_ids).toHaveLength(2);

    const current = tools.getCurrentSprint({
      space_id: 'space-1',
      principal: 'alice'
    });
    expect(current.ok).toBe(true);
    if (!current.ok) return;
    expect(current.data.context.mode).toBe('sprint');
    expect(current.data.sprint?.slug).toBe('sprint-mvp-lifecycle');
    expect(current.data.current_members).toEqual(['alice']);

    const join = tools.joinSprint({
      space_id: 'space-1',
      principal: 'bob',
      sprint: 'sprint-mvp-lifecycle'
    });
    expect(join.ok).toBe(true);
    if (!join.ok) return;
    const currentAfterJoin = tools.getCurrentSprint({
      space_id: 'space-1',
      principal: 'alice'
    });
    expect(currentAfterJoin.ok).toBe(true);
    if (!currentAfterJoin.ok) return;
    expect(currentAfterJoin.data.current_members).toEqual(['alice', 'bob']);
    expect(join.data.old_context.mode).toBe('space');
    expect(join.data.new_context.mode).toBe('sprint');
    expect(join.data.event_ids).toHaveLength(1);

    const leave = tools.leaveSprint({
      space_id: 'space-1',
      principal: 'alice'
    });
    expect(leave.ok).toBe(true);
    if (!leave.ok) return;
    expect(leave.data.old_context.mode).toBe('sprint');
    expect(leave.data.new_context).toEqual({ mode: 'space', sprint: null });
    expect(leave.data.message).toContain('Space mode');

    expect(eventCount(db, 'sprint_created')).toBe(1);
    expect(eventCount(db, 'sprint_joined')).toBe(2);
    expect(eventCount(db, 'sprint_left')).toBe(1);
  });

  it('persists lifecycle events with affected Sprint context and direct routing', () => {
    const { db, tools } = setup();

    const created = tools.createSprint({
      space_id: 'space-1',
      principal: 'alice',
      display_name: 'Lifecycle Context',
      goal: 'Keep lifecycle routing scoped.'
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const sprintId = created.data.sprint?.sprint_id;
    expect(sprintId).toBeTruthy();

    const joined = tools.joinSprint({
      space_id: 'space-1',
      principal: 'bob',
      sprint: 'lifecycle-context'
    });
    expect(joined.ok).toBe(true);
    const left = tools.leaveSprint({
      space_id: 'space-1',
      principal: 'alice'
    });
    expect(left.ok).toBe(true);
    const bobLeft = tools.leaveSprint({
      space_id: 'space-1',
      principal: 'bob'
    });
    expect(bobLeft.ok).toBe(true);
    const archived = tools.archiveSprint({
      space_id: 'space-1',
      principal: 'carol',
      sprint: 'lifecycle-context'
    });
    expect(archived.ok).toBe(true);
    const reopened = tools.reopenSprint({
      space_id: 'space-1',
      principal: 'carol',
      sprint: 'lifecycle-context'
    });
    expect(reopened.ok).toBe(true);

    for (const event of rawLifecycleEvents(db)) {
      expect(event.sprint_id).toBe(sprintId);
      expect(event.sprint_id).toBe(event.payload.sprint_id);
      expect(event.delivery_scope).toBe('direct');
      expect(event.recipient_principals).toEqual([event.principal]);
    }
  });

  it('switches context with old and new contexts and emits one leave plus one join', () => {
    const { db, tools } = setup();
    const first = tools.createSprint({
      space_id: 'space-1',
      principal: 'alice',
      display_name: 'First Sprint',
      goal: 'First goal'
    });
    const second = tools.createSprint({
      space_id: 'space-1',
      principal: 'bob',
      display_name: 'Second Sprint',
      goal: 'Second goal'
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);

    const joined = tools.joinSprint({
      space_id: 'space-1',
      principal: 'alice',
      sprint: 'second-sprint'
    });
    expect(joined.ok).toBe(true);
    if (!joined.ok) return;
    expect(joined.data.old_context.sprint?.slug).toBe('first-sprint');
    expect(joined.data.new_context.sprint?.slug).toBe('second-sprint');
    expect(joined.data.event_ids).toHaveLength(2);

    expect(eventCount(db, 'sprint_created')).toBe(2);
    expect(eventCount(db, 'sprint_joined')).toBe(3);
    expect(eventCount(db, 'sprint_left')).toBe(1);
  });

  it('rejects duplicate create with join or reopen hints', () => {
    const { db, tools } = setup();
    const first = tools.createSprint({
      space_id: 'space-1',
      principal: 'alice',
      display_name: 'Duplicate Sprint',
      goal: 'First goal'
    });
    expect(first.ok).toBe(true);

    const activeDuplicate = tools.createSprint({
      space_id: 'space-1',
      principal: 'bob',
      display_name: 'Duplicate Sprint',
      goal: 'Second goal'
    });
    expect(activeDuplicate.ok).toBe(false);
    if (!activeDuplicate.ok) {
      expect(activeDuplicate.error.code).toBe('sprint_already_exists');
      expect(activeDuplicate.error.details).toMatchObject({ hint: 'join' });
    }

    db.prepare(
      `UPDATE sprints SET status = 'archived', archived_at = ?1, archived_by = ?2
       WHERE space_id = ?3 AND slug = ?4`
    ).run('2026-05-27T01:00:00.000Z', 'alice', 'space-1', 'duplicate-sprint');

    const archivedDuplicate = tools.createSprint({
      space_id: 'space-1',
      principal: 'bob',
      display_name: 'Duplicate Sprint',
      goal: 'Third goal'
    });
    expect(archivedDuplicate.ok).toBe(false);
    if (!archivedDuplicate.ok) {
      expect(archivedDuplicate.error.details).toMatchObject({
        hint: 'reopen'
      });
    }
  });

  it('returns typed duplicate when a concurrent create wins after preflight', () => {
    const { db } = setup();
    const racedDb = withDuplicateSprintBeforeNextTransaction(db);
    const store = new SqliteEventStore(db);
    const tools = createTeamemTools({ db: racedDb, store });

    const result = tools.createSprint({
      space_id: 'space-1',
      principal: 'alice',
      display_name: 'Race Sprint',
      goal: 'Create after another writer wins.'
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('sprint_already_exists');
      expect(result.error.details).toMatchObject({
        hint: 'join',
        sprint: { slug: 'race-sprint' }
      });
    }
  });

  it('keeps join and leave idempotent without duplicate lifecycle events', () => {
    const { db, tools } = setup();
    const created = tools.createSprint({
      space_id: 'space-1',
      principal: 'alice',
      display_name: 'Idempotent Sprint',
      goal: 'Stay stable'
    });
    expect(created.ok).toBe(true);

    const joinAgain = tools.joinSprint({
      space_id: 'space-1',
      principal: 'alice',
      sprint: 'idempotent-sprint'
    });
    expect(joinAgain.ok).toBe(true);
    if (!joinAgain.ok) return;
    expect(joinAgain.data.idempotent).toBe(true);
    expect(joinAgain.data.event_ids).toHaveLength(0);
    expect(eventCount(db, 'sprint_joined')).toBe(1);

    const firstLeave = tools.leaveSprint({
      space_id: 'space-1',
      principal: 'alice'
    });
    const secondLeave = tools.leaveSprint({
      space_id: 'space-1',
      principal: 'alice'
    });
    expect(firstLeave.ok).toBe(true);
    expect(secondLeave.ok).toBe(true);
    if (!secondLeave.ok) return;
    expect(secondLeave.data.idempotent).toBe(true);
    expect(secondLeave.data.event_ids).toHaveLength(0);
    expect(eventCount(db, 'sprint_left')).toBe(1);
  });

  it('rejects invalid names, goals, targets, and non-members', () => {
    const { tools } = setup();

    const emptyName = tools.createSprint({
      space_id: 'space-1',
      principal: 'alice',
      display_name: ' ',
      goal: 'valid'
    });
    expect(emptyName.ok).toBe(false);
    if (!emptyName.ok) expect(emptyName.error.code).toBe('invalid_sprint_name');

    const emptySlug = tools.createSprint({
      space_id: 'space-1',
      principal: 'alice',
      display_name: '!!!',
      goal: 'valid'
    });
    expect(emptySlug.ok).toBe(false);
    if (!emptySlug.ok) expect(emptySlug.error.code).toBe('invalid_sprint_slug');

    const missingTarget = tools.joinSprint({
      space_id: 'space-1',
      principal: 'alice',
      sprint: 'missing'
    });
    expect(missingTarget.ok).toBe(false);
    if (!missingTarget.ok)
      expect(missingTarget.error.code).toBe('sprint_not_found');

    const nonMember = tools.getCurrentSprint({
      space_id: 'space-1',
      principal: 'dana'
    });
    expect(nonMember.ok).toBe(false);
    if (!nonMember.ok) expect(nonMember.error.code).toBe('member_not_found');
  });

  it('lists active and archived Sprints as compact inventory', () => {
    const { tools } = setup();
    const active = tools.createSprint({
      space_id: 'space-1',
      principal: 'alice',
      display_name: 'Active Sprint',
      goal: 'Keep working'
    });
    const archived = tools.createSprint({
      space_id: 'space-1',
      principal: 'bob',
      display_name: 'Archived Sprint',
      goal: 'Retain history'
    });
    expect(active.ok).toBe(true);
    expect(archived.ok).toBe(true);

    tools.leaveSprint({ space_id: 'space-1', principal: 'bob' });
    const archive = tools.archiveSprint({
      space_id: 'space-1',
      principal: 'alice',
      sprint: 'archived-sprint'
    });
    expect(archive.ok).toBe(true);

    const list = tools.listSprints({ space_id: 'space-1', principal: 'alice' });
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.data.sprints.map((s) => s.slug)).toEqual(
      expect.arrayContaining(['active-sprint', 'archived-sprint'])
    );
    expect(
      list.data.sprints.find((s) => s.slug === 'active-sprint')
    ).toMatchObject({
      display_name: 'Active Sprint',
      status: 'active',
      goal: 'Keep working',
      current_members: ['alice']
    });
    expect(
      list.data.sprints.find((s) => s.slug === 'archived-sprint')
    ).toMatchObject({
      display_name: 'Archived Sprint',
      status: 'archived',
      goal: 'Retain history',
      current_members: []
    });
  });

  it('requires members to leave before archive and keeps archive idempotent', () => {
    const { db, tools } = setup();
    const sprint = tools.createSprint({
      space_id: 'space-1',
      principal: 'alice',
      display_name: 'Archive Preconditions',
      goal: 'Require empty membership'
    });
    expect(sprint.ok).toBe(true);

    const blocked = tools.archiveSprint({
      space_id: 'space-1',
      principal: 'bob',
      sprint: 'archive-preconditions'
    });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error.code).toBe('sprint_has_members');

    tools.leaveSprint({ space_id: 'space-1', principal: 'alice' });
    const archived = tools.archiveSprint({
      space_id: 'space-1',
      principal: 'bob',
      sprint: 'archive-preconditions'
    });
    expect(archived.ok).toBe(true);
    if (!archived.ok) return;
    expect(archived.data.sprint.status).toBe('archived');
    expect(archived.data.event_ids).toHaveLength(1);

    const again = tools.archiveSprint({
      space_id: 'space-1',
      principal: 'carol',
      sprint: 'archive-preconditions'
    });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.data.idempotent).toBe(true);
    expect(again.data.event_ids).toHaveLength(0);
    expect(eventCount(db, 'sprint_archived')).toBe(1);
  });

  it('archive force-releases Sprint claims with direct owner notices and no broad fanout', () => {
    const { db, tools } = setup();
    const sprint = tools.createSprint({
      space_id: 'space-1',
      principal: 'alice',
      display_name: 'Cleanup Sprint',
      goal: 'Release leftovers'
    });
    expect(sprint.ok).toBe(true);
    if (!sprint.ok) return;
    const sprintId = sprint.data.sprint?.sprint_id;
    expect(sprintId).toBeTruthy();

    const claimed = claim(tools, 'alice', 'src/cleanup.ts');
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    tools.leaveSprint({ space_id: 'space-1', principal: 'alice' });

    const archived = tools.archiveSprint({
      space_id: 'space-1',
      principal: 'bob',
      sprint: 'cleanup-sprint'
    });
    expect(archived.ok).toBe(true);
    if (!archived.ok) return;
    expect(archived.data.released_claims).toEqual([
      expect.objectContaining({
        claim_id: claimed.data.claim_id,
        original_holder: 'alice'
      })
    ]);

    expect(
      db
        .prepare('SELECT status FROM claims WHERE claim_id = ?1')
        .get(claimed.data.claim_id)
    ).toEqual({ status: 'released' });
    const event = db
      .prepare(
        `SELECT raw_json FROM events
         WHERE event_type = 'claim_force_released'
         LIMIT 1`
      )
      .get() as { raw_json: string } | null;
    expect(event).not.toBeNull();
    const parsed = JSON.parse(event!.raw_json);
    expect(parsed).toMatchObject({
      delivery_scope: 'direct',
      recipient_principals: ['alice'],
      sprint_id: sprintId,
      payload: {
        archive_cleanup: true,
        claim_id: claimed.data.claim_id,
        sprint_id: sprintId
      }
    });

    const aliceNotifications = tools.fetchUnreadNotifications({
      space_id: 'space-1',
      principal: 'alice'
    });
    expect(aliceNotifications.ok).toBe(true);
    if (!aliceNotifications.ok) return;
    expect(
      aliceNotifications.data.notifications.map((n) => n.event_type)
    ).toContain('claim_force_released');

    const carolUpdates = tools.getUpdates({
      space_id: 'space-1',
      principal: 'carol'
    });
    expect(carolUpdates.ok).toBe(true);
    if (!carolUpdates.ok) return;
    expect(carolUpdates.data.events.map((e) => e.event_type)).not.toContain(
      'claim_force_released'
    );
  });

  it('reopens archived Sprint explicitly and does not restore old members or claims', () => {
    const { db, tools } = setup();
    tools.createSprint({
      space_id: 'space-1',
      principal: 'alice',
      display_name: 'Old Sprint',
      goal: 'Archive me'
    });
    const oldClaim = claim(tools, 'alice', 'src/old.ts');
    expect(oldClaim.ok).toBe(true);
    tools.leaveSprint({ space_id: 'space-1', principal: 'alice' });
    tools.archiveSprint({
      space_id: 'space-1',
      principal: 'bob',
      sprint: 'old-sprint'
    });

    tools.createSprint({
      space_id: 'space-1',
      principal: 'carol',
      display_name: 'Current Sprint',
      goal: 'Carol context'
    });
    const reopened = tools.reopenSprint({
      space_id: 'space-1',
      principal: 'carol',
      sprint: 'old-sprint'
    });
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) return;
    const reopenedSprintId = reopened.data.sprint?.sprint_id;
    expect(reopenedSprintId).toBeTruthy();
    expect(reopened.data.old_context.sprint?.slug).toBe('current-sprint');
    expect(reopened.data.new_context.sprint?.slug).toBe('old-sprint');
    expect(reopened.data.event_ids).toHaveLength(3);

    const members = db
      .prepare(
        `SELECT principal FROM sprint_memberships
         WHERE space_id = 'space-1' AND sprint_id = ?1
         ORDER BY principal`
      )
      .all(reopenedSprintId as string) as Array<{ principal: string }>;
    expect(members.map((m) => m.principal)).toEqual(['carol']);
    expect(
      db
        .prepare('SELECT status FROM claims WHERE claim_id = ?1')
        .get(oldClaim.ok ? oldClaim.data.claim_id : '')
    ).toEqual({ status: 'released' });

    const joinArchived = tools.joinSprint({
      space_id: 'space-1',
      principal: 'alice',
      sprint: 'current-sprint'
    });
    expect(joinArchived.ok).toBe(true);
    tools.leaveSprint({ space_id: 'space-1', principal: 'alice' });
    tools.archiveSprint({
      space_id: 'space-1',
      principal: 'bob',
      sprint: 'current-sprint'
    });
    const rejectedJoin = tools.joinSprint({
      space_id: 'space-1',
      principal: 'alice',
      sprint: 'current-sprint'
    });
    expect(rejectedJoin.ok).toBe(false);
    if (!rejectedJoin.ok)
      expect(rejectedJoin.error.code).toBe('sprint_archived');
  });

  it('reopen on active Sprint is idempotent only for current member and otherwise points to join', () => {
    const { tools } = setup();
    tools.createSprint({
      space_id: 'space-1',
      principal: 'alice',
      display_name: 'Active Reopen',
      goal: 'Use join'
    });

    const current = tools.reopenSprint({
      space_id: 'space-1',
      principal: 'alice',
      sprint: 'active-reopen'
    });
    expect(current.ok).toBe(true);
    if (!current.ok) return;
    expect(current.data.idempotent).toBe(true);
    expect(current.data.event_ids).toHaveLength(0);

    const other = tools.reopenSprint({
      space_id: 'space-1',
      principal: 'bob',
      sprint: 'active-reopen'
    });
    expect(other.ok).toBe(false);
    if (!other.ok) {
      expect(other.error.code).toBe('sprint_active_use_join');
      expect(other.error.details).toMatchObject({ hint: 'join' });
    }
  });

  it('returns bounded lifecycle-focused history and keeps archived events out of ordinary updates', () => {
    const { tools } = setup();
    const sprint = tools.createSprint({
      space_id: 'space-1',
      principal: 'alice',
      display_name: 'History Sprint',
      goal: 'Bound lifecycle'
    });
    expect(sprint.ok).toBe(true);
    const sprintClaim = claim(tools, 'alice', 'src/history.ts');
    expect(sprintClaim.ok).toBe(true);
    tools.leaveSprint({ space_id: 'space-1', principal: 'alice' });
    tools.archiveSprint({
      space_id: 'space-1',
      principal: 'bob',
      sprint: 'history-sprint'
    });

    const history = tools.getSprintHistory({
      space_id: 'space-1',
      principal: 'carol',
      sprint: 'history-sprint',
      limit: 3
    });
    expect(history.ok).toBe(true);
    if (!history.ok) return;
    expect(history.data.events).toHaveLength(3);
    expect(history.data.truncated).toBe(true);
    expect(history.data.events.map((e) => e.event_type)).toEqual([
      'sprint_left',
      'sprint_archived',
      'claim_force_released'
    ]);

    const updates = tools.getUpdates({
      space_id: 'space-1',
      principal: 'carol'
    });
    expect(updates.ok).toBe(true);
    if (!updates.ok) return;
    expect(updates.data.events.map((e) => e.event_type)).not.toContain(
      'sprint_archived'
    );
    expect(updates.data.events.map((e) => e.event_type)).not.toContain(
      'claim_force_released'
    );
  });
});
