import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createSqliteClient } from '../../../src/infra/db/sqlite-client.js';
import { SqliteEventStore } from '../../../src/infra/db/sqlite-event-store.js';
import { rebuildProjections } from '../../../src/infra/projections/rebuild.js';
import { createTeamemTools } from '../../../src/server/tools/index.js';

function runDiscussionMigrations(db: ReturnType<typeof createSqliteClient>) {
  const migrationDir = join(process.cwd(), 'src/infra/db/migrations');
  for (const file of [
    '001_init.sql',
    '002_decisions_kind_and_indexes.sql',
    '003_room_codes_and_members.sql',
    '005_discussions.sql',
    '013_projection_tombstones.sql',
    '014_findings.sql',
    '022_space_rules_snapshots.sql',
    '024_discussion_thread_visibility.sql'
  ]) {
    db.exec(readFileSync(join(migrationDir, file), 'utf8'));
  }
}

function setup() {
  const db = createSqliteClient(':memory:');
  runDiscussionMigrations(db);
  db.prepare(
    'INSERT INTO spaces (id, label, creator_member_id) VALUES (?1, ?2, ?3)'
  ).run(SPACE, 'Teamem POC', 'member-alice');
  const memberStmt = db.prepare(
    'INSERT INTO members (id, space_id, name, is_creator) VALUES (?1, ?2, ?3, ?4)'
  );
  memberStmt.run('member-alice', SPACE, 'alice', 1);
  memberStmt.run('member-bob', SPACE, 'bob', 0);
  memberStmt.run('member-carol', SPACE, 'carol', 0);
  const store = new SqliteEventStore(db);
  const tools = createTeamemTools({ db, store });
  return { db, tools, store };
}

const SPACE = 'teamem-poc';

function loadThreadRow(
  db: ReturnType<typeof createSqliteClient>,
  threadId: string
) {
  return db
    .query(
      `SELECT visibility_mode, participant_principals_json
         FROM discussion_threads
        WHERE space_id = ?1 AND thread_id = ?2`
    )
    .get(SPACE, threadId) as {
    visibility_mode: string;
    participant_principals_json: string;
  } | null;
}

describe('discussions — post_message + read_thread', () => {
  it('post_message writes a discussion_posted event and is readable by recipient', () => {
    const { tools } = setup();

    const post = tools.postMessage({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      recipient_principal: 'bob',
      body: 'Could you release src/auth/* when you can?'
    });

    if (!post.ok) throw new Error('post_message failed');
    expect(post.data.message_id).toMatch(/^[0-9A-Z]{26}$/);
    expect(post.data.thread_id).toBe(post.data.message_id);

    const bobInbox = tools.readThread({
      space_id: SPACE,
      principal: 'bob'
    });
    if (!bobInbox.ok) throw new Error('read_thread failed');
    expect(bobInbox.data.messages).toHaveLength(1);
    const m = bobInbox.data.messages[0]!;
    expect(m.sender_principal).toBe('alice');
    expect(m.recipient_principal).toBe('bob');
    expect(m.body).toContain('release src/auth');
  });

  it('thread_id continuation groups replies into the same thread', () => {
    const { db, tools } = setup();

    const first = tools.postMessage({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      recipient_principal: 'bob',
      body: 'opening message'
    });
    if (!first.ok) throw new Error('first post failed');

    const reply = tools.postMessage({
      space_id: SPACE,
      principal: 'bob',
      actor: 'bob',
      delegation: 'bob->bob',
      recipient_principal: 'alice',
      thread_id: first.data.thread_id,
      in_reply_to: first.data.message_id,
      body: 'reply'
    });
    if (!reply.ok) throw new Error('reply post failed');
    expect(reply.data.thread_id).toBe(first.data.thread_id);
    const threadRow = loadThreadRow(db, first.data.thread_id);
    expect(threadRow?.visibility_mode).toBe('direct');
    expect(JSON.parse(threadRow?.participant_principals_json ?? '[]')).toEqual([
      'alice',
      'bob'
    ]);

    const thread = tools.readThread({
      space_id: SPACE,
      principal: 'alice',
      thread_id: first.data.thread_id
    });
    if (!thread.ok) throw new Error('read_thread failed');
    expect(thread.data.messages).toHaveLength(2);
    expect(thread.data.messages[0]!.body).toBe('opening message');
    expect(thread.data.messages[1]!.body).toBe('reply');
    expect(thread.data.messages[1]!.in_reply_to).toBe(first.data.message_id);
    expect(thread.data.messages[1]!.recipient_principal).toBe('alice');
  });

  it('audits policy-bound helper replies without widening thread visibility', () => {
    const { db, tools } = setup();

    const first = tools.postMessage({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      recipient_principal: 'bob',
      body: 'Should I stash the half-done auth work while MVP scope changes?'
    });
    if (!first.ok) throw new Error('first post failed');

    const reply = tools.postMessage({
      space_id: SPACE,
      principal: 'bob',
      actor: 'bob/teamem-negotiator',
      delegation: 'bob->teamem-negotiator',
      recipient_principal: 'alice',
      thread_id: first.data.thread_id,
      in_reply_to: first.data.message_id,
      body: 'Yes, stash it and leave the working tree focused on MVP work.',
      policy_decision: 'human_approved',
      policy_reason:
        'Scope-changing reply was sent only after explicit human approval.'
    });
    if (!reply.ok) throw new Error('reply post failed');

    const row = db
      .query('SELECT raw_json FROM events WHERE event_id = ?1')
      .get(reply.data.event_id) as { raw_json: string } | null;
    expect(row).not.toBeNull();
    const event = JSON.parse(row!.raw_json) as {
      payload: {
        helper_policy?: { decision: string; reason: string };
        visibility_mode?: string;
        participant_principals?: string[];
      };
    };
    expect(event.payload.helper_policy).toEqual({
      decision: 'human_approved',
      reason:
        'Scope-changing reply was sent only after explicit human approval.'
    });
    expect(event.payload.visibility_mode).toBe('direct');
    expect(event.payload.participant_principals).toEqual(['alice', 'bob']);
  });

  it('broadcast (recipient null) is visible to any principal in the space', () => {
    const { db, tools } = setup();
    const post = tools.postMessage({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      recipient_principal: null,
      body: 'team-wide announcement'
    });
    if (!post.ok) throw new Error('post failed');
    const threadRow = loadThreadRow(db, post.data.thread_id);
    expect(threadRow?.visibility_mode).toBe('broadcast');
    expect(JSON.parse(threadRow?.participant_principals_json ?? '[]')).toEqual(
      []
    );

    for (const who of ['bob', 'carol', 'alice']) {
      const inbox = tools.readThread({ space_id: SPACE, principal: who });
      if (!inbox.ok) throw new Error('read_thread failed');
      expect(inbox.data.messages).toHaveLength(1);
      expect(inbox.data.messages[0]!.recipient_principal).toBeNull();
    }
  });

  it('direct thread reads reject unrelated active members who guess the thread id', () => {
    const { tools } = setup();
    const post = tools.postMessage({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      recipient_principal: 'bob',
      body: 'private thread'
    });
    if (!post.ok) throw new Error('post failed');

    const carolRead = tools.readThread({
      space_id: SPACE,
      principal: 'carol',
      thread_id: post.data.thread_id
    });
    expect(carolRead.ok).toBe(false);
    if (carolRead.ok) throw new Error('expected denial');
    expect(carolRead.error.code).toBe('discussion_forbidden');
  });

  it('broadcast threads are not readable to inactive or unrelated principals', () => {
    const { db, tools } = setup();
    db.prepare(
      'UPDATE members SET left_at = ?1 WHERE space_id = ?2 AND name = ?3'
    ).run(new Date().toISOString(), SPACE, 'carol');

    const post = tools.postMessage({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      recipient_principal: null,
      body: 'broadcast'
    });
    if (!post.ok) throw new Error('post failed');

    const carolThread = tools.readThread({
      space_id: SPACE,
      principal: 'carol',
      thread_id: post.data.thread_id
    });
    expect(carolThread.ok).toBe(false);
    if (carolThread.ok) throw new Error('expected denial');
    expect(carolThread.error.code).toBe('discussion_forbidden');

    const outsiderInbox = tools.readThread({
      space_id: SPACE,
      principal: 'mallory'
    });
    expect(outsiderInbox.ok).toBe(true);
    if (!outsiderInbox.ok) throw new Error('unexpected denial');
    expect(outsiderInbox.data.messages).toHaveLength(0);
  });

  it('replies preserve direct thread participants and reject recipient mutation attempts', () => {
    const { tools } = setup();
    const post = tools.postMessage({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      recipient_principal: 'bob',
      body: 'private thread'
    });
    if (!post.ok) throw new Error('post failed');

    const mutatedReply = tools.postMessage({
      space_id: SPACE,
      principal: 'bob',
      actor: 'bob',
      delegation: 'bob->bob',
      recipient_principal: 'carol',
      thread_id: post.data.thread_id,
      in_reply_to: post.data.message_id,
      body: 'try to add carol'
    });
    expect(mutatedReply.ok).toBe(false);
    if (mutatedReply.ok) throw new Error('expected denial');
    expect(mutatedReply.error.code).toBe('invalid_reply_visibility');
  });

  it('replies preserve broadcast visibility and reject recipient mutation attempts', () => {
    const { tools } = setup();
    const post = tools.postMessage({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      recipient_principal: null,
      body: 'team thread'
    });
    if (!post.ok) throw new Error('post failed');

    const mutatedReply = tools.postMessage({
      space_id: SPACE,
      principal: 'bob',
      actor: 'bob',
      delegation: 'bob->bob',
      recipient_principal: 'alice',
      thread_id: post.data.thread_id,
      in_reply_to: post.data.message_id,
      body: 'try to privatize'
    });
    expect(mutatedReply.ok).toBe(false);
    if (mutatedReply.ok) throw new Error('expected denial');
    expect(mutatedReply.error.code).toBe('invalid_reply_visibility');
  });

  it('legacy rows backfill explicit visibility metadata and enforce it on reads', () => {
    const { db, tools } = setup();
    db.prepare('DELETE FROM discussion_threads WHERE space_id = ?1').run(SPACE);

    db.prepare(
      `INSERT INTO discussions
       (message_id, space_id, thread_id, sender_principal, recipient_principal, body, in_reply_to, created_at, source_event_id)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
    ).run(
      'legacy-1',
      SPACE,
      'thread-legacy-direct',
      'alice',
      'bob',
      'legacy direct',
      null,
      '2026-05-10T00:00:00.000Z',
      'evt-legacy-1'
    );
    db.prepare(
      `INSERT INTO discussions
       (message_id, space_id, thread_id, sender_principal, recipient_principal, body, in_reply_to, created_at, source_event_id)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
    ).run(
      'legacy-2',
      SPACE,
      'thread-legacy-broadcast',
      'alice',
      null,
      'legacy broadcast',
      null,
      '2026-05-10T00:01:00.000Z',
      'evt-legacy-2'
    );

    db.exec(
      readFileSync(
        join(
          process.cwd(),
          'src/infra/db/migrations/024_discussion_thread_visibility.sql'
        ),
        'utf8'
      )
    );

    const directThreadRow = loadThreadRow(db, 'thread-legacy-direct');
    expect(directThreadRow?.visibility_mode).toBe('direct');
    expect(
      JSON.parse(directThreadRow?.participant_principals_json ?? '[]')
    ).toEqual(['alice', 'bob']);

    const broadcastThreadRow = loadThreadRow(db, 'thread-legacy-broadcast');
    expect(broadcastThreadRow?.visibility_mode).toBe('broadcast');

    const carolDirectRead = tools.readThread({
      space_id: SPACE,
      principal: 'carol',
      thread_id: 'thread-legacy-direct'
    });
    expect(carolDirectRead.ok).toBe(false);
    if (carolDirectRead.ok) throw new Error('expected denial');

    const bobBroadcastRead = tools.readThread({
      space_id: SPACE,
      principal: 'bob',
      thread_id: 'thread-legacy-broadcast'
    });
    expect(bobBroadcastRead.ok).toBe(true);
    if (!bobBroadcastRead.ok) throw new Error('expected success');
    expect(bobBroadcastRead.data.messages).toHaveLength(1);
  });

  it('discussion visibility metadata survives projection rebuild', () => {
    const { db, tools } = setup();
    const direct = tools.postMessage({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      recipient_principal: 'bob',
      body: 'direct message'
    });
    if (!direct.ok) throw new Error('direct post failed');

    const broadcast = tools.postMessage({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      recipient_principal: null,
      body: 'broadcast message'
    });
    if (!broadcast.ok) throw new Error('broadcast post failed');

    const before = db
      .query(
        `SELECT thread_id, visibility_mode, participant_principals_json
           FROM discussion_threads
          WHERE space_id = ?1
          ORDER BY thread_id ASC`
      )
      .all(SPACE);

    const result = rebuildProjections(db, SPACE);
    expect(result.replayed).toBe(2);

    const after = db
      .query(
        `SELECT thread_id, visibility_mode, participant_principals_json
           FROM discussion_threads
          WHERE space_id = ?1
          ORDER BY thread_id ASC`
      )
      .all(SPACE);
    expect(after).toEqual(before);

    const carolDirectRead = tools.readThread({
      space_id: SPACE,
      principal: 'carol',
      thread_id: direct.data.thread_id
    });
    expect(carolDirectRead.ok).toBe(false);

    const carolBroadcastRead = tools.readThread({
      space_id: SPACE,
      principal: 'carol',
      thread_id: broadcast.data.thread_id
    });
    expect(carolBroadcastRead.ok).toBe(true);
    if (!carolBroadcastRead.ok) throw new Error('expected success');
    expect(carolBroadcastRead.data.messages).toHaveLength(1);
  });

  it('idempotency: same args twice returns same message_id and writes only one event', () => {
    const { tools, store } = setup();

    const args = {
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      recipient_principal: 'bob' as string | null,
      body: 'idempotent message',
      request_id: 'req-abc-123'
    };

    const first = tools.postMessage(args);
    if (!first.ok) throw new Error('first call failed');

    const second = tools.postMessage(args);
    if (!second.ok) throw new Error('second call failed');

    expect(second.data.message_id).toBe(first.data.message_id);
    expect(second.data.thread_id).toBe(first.data.thread_id);

    const events = store.getUpdates(SPACE);
    const msgEvents = events.filter(
      (e) => e.event_type === 'discussion_posted'
    );
    expect(msgEvents).toHaveLength(1);
  });

  it('rejects empty body with invalid_body', () => {
    const { tools } = setup();
    const result = tools.postMessage({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      body: ''
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error();
    expect(result.error.code).toBe('invalid_body');
  });

  it('rejects body > 65536 bytes with invalid_body', () => {
    const { tools } = setup();
    const result = tools.postMessage({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      body: 'x'.repeat(65537)
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error();
    expect(result.error.code).toBe('invalid_body');
  });

  it('rejects non-string recipient_principal with invalid_recipient', () => {
    const { tools } = setup();
    const result = tools.postMessage({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      body: 'hello',
      recipient_principal: 42 as unknown as string
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error();
    expect(result.error.code).toBe('invalid_recipient');
  });

  it('rejects thread_id longer than 64 chars with invalid_thread_id', () => {
    const { tools } = setup();
    const result = tools.postMessage({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      body: 'hello',
      thread_id: 'a'.repeat(65)
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error();
    expect(result.error.code).toBe('invalid_thread_id');
  });

  it("alice's outbox surfaces messages where alice is sender", () => {
    const { tools } = setup();
    tools.postMessage({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      recipient_principal: 'bob',
      body: 'hello bob'
    });
    const outbox = tools.readThread({ space_id: SPACE, principal: 'alice' });
    if (!outbox.ok) throw new Error('read failed');
    expect(
      outbox.data.messages.some((m) => m.sender_principal === 'alice')
    ).toBe(true);
  });

  it('directed message to bob does NOT appear in carol inbox', () => {
    const { tools } = setup();
    tools.postMessage({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      recipient_principal: 'bob',
      body: 'private to bob'
    });
    const carolInbox = tools.readThread({
      space_id: SPACE,
      principal: 'carol'
    });
    if (!carolInbox.ok) throw new Error('read failed');
    expect(carolInbox.data.messages).toHaveLength(0);
  });

  it('read_thread with nonexistent thread_id returns empty messages', () => {
    const { tools } = setup();
    const result = tools.readThread({
      space_id: SPACE,
      principal: 'alice',
      thread_id: 'nonexistent'
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error();
    expect(result.data.messages).toHaveLength(0);
  });

  it('since cursor returns only newer messages', () => {
    const { tools } = setup();

    const first = tools.postMessage({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      recipient_principal: 'bob',
      body: 'one'
    });
    if (!first.ok) throw new Error('post failed');

    // Sleep 5ms to ensure created_at strictly differs.
    const start = Date.now();
    while (Date.now() - start < 5) {
      /* spin */
    }
    const cursor = new Date().toISOString();
    while (Date.now() - start < 10) {
      /* spin */
    }

    tools.postMessage({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      recipient_principal: 'bob',
      body: 'two'
    });

    const incremental = tools.readThread({
      space_id: SPACE,
      principal: 'bob',
      since: cursor
    });
    if (!incremental.ok) throw new Error('read failed');
    expect(incremental.data.messages.map((m) => m.body)).toEqual(['two']);
  });
});
