/**
 * Findings projection — 7-day TTL behavior (issue #13, AC: 6d visible / 8d
 * gone). The briefing renderer filters on `expires_at > now` so a finding
 * that's just past its 7-day window stops surfacing without any
 * background job.
 */
import { describe, expect, it } from 'bun:test';
import { runAllMigrations } from '../../helpers/migrations.js';
import { createSqliteClient } from '../../../src/infra/db/sqlite-client.js';
import { SqliteEventStore } from '../../../src/infra/db/sqlite-event-store.js';
import { createTeamemTools } from '../../../src/server/tools/index.js';

function setup() {
  const db = createSqliteClient(':memory:');
  runAllMigrations(db);
  const store = new SqliteEventStore(db);
  const tools = createTeamemTools({ db, store });
  return { db, tools };
}

const SPACE = 'space-findings-ttl';

function postFinding(tools: ReturnType<typeof setup>['tools']) {
  const r = tools.shareFinding({
    space_id: SPACE,
    principal: 'alice',
    actor: 'alice',
    delegation: 'alice->alice',
    summary: 'TOCTOU race in src/auth/login.ts',
    tags: ['auth', 'security'],
    severity: 'urgent'
  });
  if (!r.ok) throw new Error('shareFinding failed');
  return r.data;
}

function rewriteExpiresAt(
  db: ReturnType<typeof setup>['db'],
  findingId: string,
  newExpiresAt: string
) {
  db.prepare('UPDATE findings SET expires_at = ?1 WHERE finding_id = ?2').run(
    newExpiresAt,
    findingId
  );
}

describe('findings TTL — 6d visible / 8d gone', () => {
  it('a finding ~6 days old still surfaces in the briefing', () => {
    const { db, tools } = setup();
    const { finding_id } = postFinding(tools);
    // Simulate 6 days elapsed by rewriting expires_at to 1 day from now.
    rewriteExpiresAt(
      db,
      finding_id,
      new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    );

    const briefing = tools.getBriefing({ space_id: SPACE });
    if (!briefing.ok) throw new Error('getBriefing failed');
    const ids = briefing.data.recent_findings.map((f) => f.finding_id);
    expect(ids).toContain(finding_id);
  });

  it('a finding ~8 days old (expires_at in the past) is hidden from the briefing', () => {
    const { db, tools } = setup();
    const { finding_id } = postFinding(tools);
    // Simulate 8 days elapsed: expires_at one day ago.
    rewriteExpiresAt(
      db,
      finding_id,
      new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    );

    const briefing = tools.getBriefing({ space_id: SPACE });
    if (!briefing.ok) throw new Error('getBriefing failed');
    const ids = briefing.data.recent_findings.map((f) => f.finding_id);
    expect(ids).not.toContain(finding_id);
  });

  it('default expires_at is exactly 7 days after created_at', () => {
    const { db, tools } = setup();
    const { finding_id } = postFinding(tools);
    const row = db
      .prepare(
        'SELECT created_at, expires_at FROM findings WHERE finding_id = ?'
      )
      .get(finding_id) as { created_at: string; expires_at: string };
    const createdMs = new Date(row.created_at).getTime();
    const expiresMs = new Date(row.expires_at).getTime();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    // ±5 minutes slack for clock granularity.
    expect(Math.abs(expiresMs - createdMs - sevenDaysMs)).toBeLessThan(
      5 * 60 * 1000
    );
  });

  it('persistent gotchas store nullable expires_at and stay visible', () => {
    const { db, tools } = setup();
    const r = tools.shareFinding({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      kind: 'gotcha',
      summary: 'Persistent gotcha',
      severity: 'warning'
    });
    if (!r.ok) throw new Error('shareFinding failed');

    const row = db
      .prepare(
        'SELECT kind, lifecycle, version, expires_at FROM findings WHERE finding_id = ?'
      )
      .get(r.data.finding_id) as {
      kind: string;
      lifecycle: string;
      version: number;
      expires_at: string | null;
    };
    expect(row.kind).toBe('gotcha');
    expect(row.lifecycle).toBe('persistent');
    expect(row.version).toBe(1);
    expect(row.expires_at).toBeNull();

    const briefing = tools.getBriefing({ space_id: SPACE });
    if (!briefing.ok) throw new Error('getBriefing failed');
    const ids = briefing.data.recent_findings.map((f) => f.finding_id);
    expect(ids).toContain(r.data.finding_id);
  });
});
