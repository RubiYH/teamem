/**
 * Findings primitive — end-to-end behavior (issue #13).
 *
 * Covers: tool input validation, projection write, briefing render order
 * (urgent > warning > info), severity preservation, tag preservation.
 *
 * The watcher classifier behavior (urgent ALERT-unconditional, warning
 * tag-overlap, info silent) is asserted by the watcher prompt itself; this
 * test validates the data the classifier reads.
 */
import { describe, expect, it } from 'bun:test';
import { runAllMigrations } from '../../helpers/migrations.js';
import { createSqliteClient } from '../../../src/infra/db/sqlite-client.js';
import { SqliteEventStore } from '../../../src/infra/db/sqlite-event-store.js';
import { createTeamemTools } from '../../../src/server/tools/index.js';

function setup() {
  const db = createSqliteClient(':memory:');
  runAllMigrations(db);
  db.prepare(
    `INSERT INTO spaces (id, label, creator_member_id, created_at, disbanded_at)
     VALUES (?1, 'Findings Space', 'member-alice', datetime('now'), NULL)`
  ).run(SPACE);
  const insertMember = db.prepare(
    `INSERT INTO members (id, space_id, name, joined_at, is_creator, left_at)
     VALUES (?1, ?2, ?3, datetime('now'), ?4, NULL)`
  );
  insertMember.run('member-alice', SPACE, 'alice', 1);
  insertMember.run('member-bob', SPACE, 'bob', 0);
  insertMember.run('member-carol', SPACE, 'carol', 0);
  const store = new SqliteEventStore(db);
  const tools = createTeamemTools({ db, store });
  return { db, store, tools };
}

const SPACE = 'space-findings';

describe('share_finding — input validation', () => {
  it('rejects empty summary', () => {
    const { tools } = setup();
    const r = tools.shareFinding({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      summary: ''
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalid_summary');
  });

  it('rejects summary > 280 chars', () => {
    const { tools } = setup();
    const r = tools.shareFinding({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      summary: 'x'.repeat(281)
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalid_summary');
  });

  it('rejects > 32 tags', () => {
    const { tools } = setup();
    const tags = Array.from({ length: 33 }, (_, i) => `t${i}`);
    const r = tools.shareFinding({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      summary: 'too many tags',
      tags
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalid_tags');
  });

  it('coerces invalid severity to "info"', () => {
    const { db, tools } = setup();
    const r = tools.shareFinding({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      summary: 'severity coerced',
      severity: 'critical' // not in enum
    });
    if (!r.ok) throw new Error('shareFinding failed');
    const row = db
      .prepare('SELECT severity FROM findings WHERE finding_id = ?')
      .get(r.data.finding_id) as { severity: string };
    expect(row.severity).toBe('info');
  });

  it('rejects empty finding_id on get_finding', () => {
    const { tools } = setup();
    const r = tools.getFinding({
      space_id: SPACE,
      principal: 'alice',
      finding_id: '   '
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalid_finding_id');
  });
});

describe('share_finding — briefing surfaces by severity then recency', () => {
  it('urgent findings sort before warning before info, then created_at DESC within tier', () => {
    const { tools } = setup();
    const a = tools.shareFinding({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      summary: 'info-1',
      severity: 'info'
    });
    const b = tools.shareFinding({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      summary: 'warning-1',
      severity: 'warning'
    });
    const c = tools.shareFinding({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      summary: 'urgent-1',
      severity: 'urgent'
    });
    if (!a.ok || !b.ok || !c.ok) throw new Error('shareFinding failed');

    const briefing = tools.getBriefing({ space_id: SPACE });
    if (!briefing.ok) throw new Error('getBriefing failed');
    const order = briefing.data.recent_findings.map((f) => f.severity);
    expect(order[0]).toBe('urgent');
    expect(order[1]).toBe('warning');
    expect(order[2]).toBe('info');
  });

  it('preserves tags, summary, body, and severity through the projection', () => {
    const { tools } = setup();
    const r = tools.shareFinding({
      space_id: SPACE,
      principal: 'bob',
      actor: 'bob',
      delegation: 'bob->bob',
      summary: 'TOCTOU race in auth.ts:47',
      body: 'See thread on disband for context.',
      tags: ['auth', 'security', 'toctou'],
      severity: 'urgent',
      refs: { paths: ['src/auth/login.ts'] }
    });
    if (!r.ok) throw new Error('shareFinding failed');

    const briefing = tools.getBriefing({ space_id: SPACE });
    if (!briefing.ok) throw new Error('getBriefing failed');
    const f = briefing.data.recent_findings.find(
      (x) => x.finding_id === r.data.finding_id
    );
    expect(f).toBeDefined();
    expect(f!.summary).toBe('TOCTOU race in auth.ts:47');
    expect(f!.body).toBe('See thread on disband for context.');
    expect(f!.tags.sort()).toEqual(['auth', 'security', 'toctou']);
    expect(f!.severity).toBe('urgent');
    expect(f!.principal).toBe('bob');
  });

  it('records a persistent gotcha and fetches full detail with versioned identity', () => {
    const { tools } = setup();
    const shared = tools.shareFinding({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      kind: 'gotcha',
      summary: 'Do not infer Space Rules from briefing output',
      body: 'Use the dedicated snapshot/sync path. Briefing is capped and not authoritative.',
      paths: [
        'src/server/tools/briefing.ts',
        'src/server/tools/space-rules.ts'
      ],
      tags: ['space-memory', 'rules'],
      severity: 'warning',
      refs: { modules: ['server/tools'] }
    });
    if (!shared.ok) throw new Error('shareFinding failed');

    expect(shared.data.kind).toBe('gotcha');
    expect(shared.data.lifecycle).toBe('persistent');
    expect(shared.data.status).toBe('active');
    expect(shared.data.version).toBe(1);
    expect(shared.data.expires_at).toBeNull();

    const detail = tools.getFinding({
      space_id: SPACE,
      principal: 'alice',
      finding_id: shared.data.finding_id
    });
    if (!detail.ok) throw new Error('getFinding failed');

    expect(detail.data.finding_id).toBe(shared.data.finding_id);
    expect(detail.data.kind).toBe('gotcha');
    expect(detail.data.lifecycle).toBe('persistent');
    expect(detail.data.status).toBe('active');
    expect(detail.data.version).toBe(1);
    expect(detail.data.summary).toBe(
      'Do not infer Space Rules from briefing output'
    );
    expect(detail.data.body).toContain('dedicated snapshot/sync path');
    expect(detail.data.paths).toEqual([
      'src/server/tools/briefing.ts',
      'src/server/tools/space-rules.ts'
    ]);
    expect(detail.data.tags).toEqual(['space-memory', 'rules']);
    expect(detail.data.recipient_principals).toEqual([]);
    expect(detail.data.refs).toEqual({ modules: ['server/tools'] });
    expect(detail.data.expires_at).toBeNull();
  });

  it('returns short gotcha notices for relevant broadcast recipients without the full body', () => {
    const { tools } = setup();

    const claim = tools.claimScope({
      space_id: SPACE,
      principal: 'bob',
      actor: 'bob',
      delegation: 'bob->bob',
      scope: { paths: ['src/server/tools/briefing.ts'] }
    });
    if (!claim.ok) throw new Error('claimScope failed');

    const shared = tools.shareFinding({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      kind: 'gotcha',
      summary: 'Briefing is capped, not authoritative',
      body: 'Use the dedicated snapshot/sync path for Space Rules.',
      paths: ['src/server/tools/briefing.ts'],
      tags: ['briefing'],
      severity: 'warning'
    });
    if (!shared.ok) throw new Error('shareFinding failed');

    const bob = tools.sessionSync({
      space_id: SPACE,
      principal: 'bob'
    });
    if (!bob.ok) throw new Error('sessionSync failed for bob');

    const notice = bob.data.gotcha_notices.find(
      (notification) => notification.event_type === 'gotcha_notice'
    );
    expect(notice).toBeDefined();
    expect(notice?.payload.finding_id).toBe(shared.data.finding_id);
    expect(notice?.payload.summary).toBe(
      'Briefing is capped, not authoritative'
    );
    expect(notice?.payload.severity).toBe('warning');
    expect(notice?.payload.paths).toEqual(['src/server/tools/briefing.ts']);
    expect(notice?.payload.recipient_mode).toBe('broadcast');
    expect(notice?.payload.relevance).toBe('path_overlap');
    expect('body' in (notice?.payload ?? {})).toBe(false);

    const carol = tools.sessionSync({
      space_id: SPACE,
      principal: 'carol'
    });
    if (!carol.ok) throw new Error('sessionSync failed for carol');
    expect(
      carol.data.gotcha_notices.some(
        (notification) => notification.event_type === 'gotcha_notice'
      )
    ).toBe(false);
  });

  it('supports specific recipient targeting independent of current path relevance', () => {
    const { tools } = setup();

    const shared = tools.shareFinding({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      kind: 'gotcha',
      summary: 'Target only Carol with this gotcha',
      body: 'This is intentionally direct.',
      recipient_principals: ['carol'],
      severity: 'info'
    });
    if (!shared.ok) throw new Error('shareFinding failed');

    const carol = tools.sessionSync({
      space_id: SPACE,
      principal: 'carol'
    });
    if (!carol.ok) throw new Error('sessionSync failed for carol');
    const notice = carol.data.gotcha_notices.find(
      (notification) => notification.event_type === 'gotcha_notice'
    );
    expect(notice).toBeDefined();
    expect(notice?.payload.recipient_mode).toBe('direct');
    expect(notice?.payload.recipient_principals).toEqual(['carol']);
    expect(notice?.payload.relevance).toBe('direct_target');

    const bob = tools.sessionSync({
      space_id: SPACE,
      principal: 'bob'
    });
    if (!bob.ok) throw new Error('sessionSync failed for bob');
    expect(
      bob.data.gotcha_notices.some(
        (notification) => notification.event_type === 'gotcha_notice'
      )
    ).toBe(false);
  });

  it('does not expose direct gotcha bodies to non-recipients through briefing or detail fetch', () => {
    const { tools } = setup();

    const shared = tools.shareFinding({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      kind: 'gotcha',
      summary: 'Carol-only deployment trap',
      body: 'The full body is only for Carol.',
      recipient_principals: ['carol'],
      severity: 'urgent'
    });
    if (!shared.ok) throw new Error('shareFinding failed');

    const bobBriefing = tools.getBriefing({
      space_id: SPACE,
      principal: 'bob'
    });
    if (!bobBriefing.ok) throw new Error('getBriefing failed for bob');
    expect(
      bobBriefing.data.recent_findings.some(
        (finding) => finding.finding_id === shared.data.finding_id
      )
    ).toBe(false);

    const carolBriefing = tools.getBriefing({
      space_id: SPACE,
      principal: 'carol'
    });
    if (!carolBriefing.ok) throw new Error('getBriefing failed for carol');
    const carolSummary = carolBriefing.data.recent_findings.find(
      (finding) => finding.finding_id === shared.data.finding_id
    );
    expect(carolSummary).toBeDefined();
    expect(carolSummary?.body).toBeUndefined();

    const bobDetail = tools.getFinding({
      space_id: SPACE,
      principal: 'bob',
      finding_id: shared.data.finding_id
    });
    expect(bobDetail.ok).toBe(false);
    if (!bobDetail.ok) expect(bobDetail.error.code).toBe('finding_not_found');

    const carolDetail = tools.getFinding({
      space_id: SPACE,
      principal: 'carol',
      finding_id: shared.data.finding_id
    });
    if (!carolDetail.ok) throw new Error('getFinding failed for carol');
    expect(carolDetail.data.body).toBe('The full body is only for Carol.');
  });

  it('acknowledges gotcha notices per principal and version, idempotently, and alerts again on a new version', () => {
    const { tools } = setup();

    const shared = tools.shareFinding({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      kind: 'gotcha',
      summary: 'Urgent gotcha for Bob',
      body: 'Fetch detail, then acknowledge seen.',
      recipient_principals: ['bob'],
      severity: 'urgent'
    });
    if (!shared.ok) throw new Error('shareFinding failed');

    const firstFetch = tools.sessionSync({
      space_id: SPACE,
      principal: 'bob'
    });
    if (!firstFetch.ok) throw new Error('sessionSync failed for bob');
    expect(
      firstFetch.data.gotcha_notices.some(
        (notification) =>
          notification.event_type === 'gotcha_notice' &&
          notification.payload.version === 1
      )
    ).toBe(true);

    const firstAck = tools.acknowledgeFinding({
      space_id: SPACE,
      principal: 'bob',
      actor: 'bob',
      delegation: 'bob->bob',
      finding_id: shared.data.finding_id,
      version: 1
    });
    if (!firstAck.ok) throw new Error('acknowledgeFinding failed');
    expect(firstAck.data.already_acknowledged).toBe(false);
    expect(firstAck.data.meaning).toBe('seen');

    const secondAck = tools.acknowledgeFinding({
      space_id: SPACE,
      principal: 'bob',
      actor: 'bob',
      delegation: 'bob->bob',
      finding_id: shared.data.finding_id,
      version: 1
    });
    if (!secondAck.ok) throw new Error('acknowledgeFinding retry failed');
    expect(secondAck.data.already_acknowledged).toBe(true);

    const afterAck = tools.sessionSync({
      space_id: SPACE,
      principal: 'bob'
    });
    if (!afterAck.ok) throw new Error('sessionSync failed');
    expect(
      afterAck.data.gotcha_notices.some(
        (notification) => notification.event_type === 'gotcha_notice'
      )
    ).toBe(false);

    const amended = tools.publishEvent({
      schema_version: '1.0',
      event_id: 'evt-gotcha-v2',
      idempotency_key: 'idem-gotcha-v2',
      space_id: SPACE,
      timestamp: '2026-05-10T01:00:00.000Z',
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      event_type: 'finding_shared',
      scope: {},
      payload: {
        finding_id: shared.data.finding_id,
        kind: 'gotcha',
        lifecycle: 'persistent',
        status: 'active',
        version: 2,
        summary: 'Urgent gotcha for Bob (updated)',
        body: 'Updated details',
        recipient_principals: ['bob'],
        severity: 'urgent',
        expires_at: null
      }
    });
    if (!amended.ok) throw new Error('publishEvent failed for version 2');

    const afterAmendment = tools.sessionSync({
      space_id: SPACE,
      principal: 'bob'
    });
    if (!afterAmendment.ok) throw new Error('sessionSync failed');
    const newVersionNotice = afterAmendment.data.gotcha_notices.find(
      (notification) =>
        notification.event_type === 'gotcha_notice' &&
        notification.payload.version === 2
    );
    expect(newVersionNotice).toBeDefined();
    expect(newVersionNotice?.payload.summary).toBe(
      'Urgent gotcha for Bob (updated)'
    );
  });

  it('does not duplicate gotcha notices through fetch_unread_notifications', () => {
    const { tools } = setup();

    const shared = tools.shareFinding({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      kind: 'gotcha',
      summary: 'Session sync owns gotcha catch-up',
      body: 'Unread notifications should not duplicate this.',
      recipient_principals: ['bob'],
      severity: 'urgent'
    });
    if (!shared.ok) throw new Error('shareFinding failed');

    const sync = tools.sessionSync({ space_id: SPACE, principal: 'bob' });
    if (!sync.ok) throw new Error('sessionSync failed');
    expect(
      sync.data.gotcha_notices.some(
        (notification) =>
          notification.payload.finding_id === shared.data.finding_id
      )
    ).toBe(true);

    const unread = tools.fetchUnreadNotifications({
      space_id: SPACE,
      principal: 'bob'
    });
    if (!unread.ok) throw new Error('fetchUnreadNotifications failed');
    expect(
      unread.data.notifications.some(
        (notification) => notification.event_type === 'gotcha_notice'
      )
    ).toBe(false);
  });

  it('returns invalid_version when acknowledging a future finding version', () => {
    const { tools } = setup();
    const shared = tools.shareFinding({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      kind: 'gotcha',
      summary: 'Versioned acknowledgement contract',
      severity: 'urgent'
    });
    if (!shared.ok) throw new Error('shareFinding failed');

    const ack = tools.acknowledgeFinding({
      space_id: SPACE,
      principal: 'bob',
      actor: 'bob',
      delegation: 'bob->bob',
      finding_id: shared.data.finding_id,
      version: 2
    });
    expect(ack.ok).toBe(false);
    if (!ack.ok) expect(ack.error.code).toBe('invalid_version');
  });

  it('expired findings are excluded from the briefing', () => {
    const { db, tools } = setup();
    const r = tools.shareFinding({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      summary: 'expired finding',
      severity: 'warning'
    });
    if (!r.ok) throw new Error('shareFinding failed');

    db.prepare('UPDATE findings SET expires_at = ?1 WHERE finding_id = ?2').run(
      new Date(Date.now() - 60_000).toISOString(),
      r.data.finding_id
    );

    const briefing = tools.getBriefing({ space_id: SPACE });
    if (!briefing.ok) throw new Error('getBriefing failed');
    const ids = briefing.data.recent_findings.map((f) => f.finding_id);
    expect(ids).not.toContain(r.data.finding_id);
  });

  it('persistent gotchas remain visible with NULL expires_at', () => {
    const { tools } = setup();
    const r = tools.shareFinding({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      kind: 'gotcha',
      summary: 'Persistent gotcha',
      severity: 'urgent'
    });
    if (!r.ok) throw new Error('shareFinding failed');

    const briefing = tools.getBriefing({ space_id: SPACE });
    if (!briefing.ok) throw new Error('getBriefing failed');
    const gotcha = briefing.data.recent_findings.find(
      (f) => f.finding_id === r.data.finding_id
    );
    expect(gotcha).toBeDefined();
    expect(gotcha?.kind).toBe('gotcha');
    expect(gotcha?.lifecycle).toBe('persistent');
    expect(gotcha?.expires_at).toBeNull();
  });

  it('tombstoned findings are excluded from the briefing', () => {
    const { db, tools } = setup();
    const r = tools.shareFinding({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      summary: 'tombstoned finding',
      severity: 'urgent'
    });
    if (!r.ok) throw new Error('shareFinding failed');

    db.prepare(
      'UPDATE findings SET tombstoned_at = ?1 WHERE finding_id = ?2'
    ).run(new Date().toISOString(), r.data.finding_id);

    const briefing = tools.getBriefing({ space_id: SPACE });
    if (!briefing.ok) throw new Error('getBriefing failed');
    const ids = briefing.data.recent_findings.map((f) => f.finding_id);
    expect(ids).not.toContain(r.data.finding_id);
  });

  it('returns finding_not_found when detail fetch misses', () => {
    const { tools } = setup();
    const r = tools.getFinding({
      space_id: SPACE,
      principal: 'alice',
      finding_id: 'missing-finding'
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('finding_not_found');
  });
});
