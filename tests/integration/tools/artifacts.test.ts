/**
 * Artifacts primitive — end-to-end behavior (issue #14).
 *
 * Covers: tool input validation (kind/uri/title), projection write,
 * briefing's `recent_artifacts` ordering (created_at DESC) and cap (10),
 * tombstone respected on soft-wipe.
 *
 * Watcher classifier behavior (always IGNORE) is asserted by the watcher
 * prompt itself; this test validates the data layer.
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

const SPACE = 'space-artifacts';

describe('share_artifact — input validation', () => {
  it('rejects missing kind', () => {
    const { tools } = setup();
    const r = tools.shareArtifact({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      kind: 'unknown',
      uri: 'docs/foo.md',
      title: 'Foo'
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalid_kind');
  });

  it('rejects empty uri', () => {
    const { tools } = setup();
    const r = tools.shareArtifact({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      kind: 'spec',
      uri: '',
      title: 'Spec without uri'
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalid_uri');
  });

  it('rejects uri > 1024 chars', () => {
    const { tools } = setup();
    const r = tools.shareArtifact({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      kind: 'doc',
      uri: 'x'.repeat(1025),
      title: 'Long uri'
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalid_uri');
  });

  it('rejects empty title', () => {
    const { tools } = setup();
    const r = tools.shareArtifact({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      kind: 'fixture',
      uri: 'tests/fixtures/foo.json',
      title: ''
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalid_title');
  });

  it('rejects title > 200 chars', () => {
    const { tools } = setup();
    const r = tools.shareArtifact({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      kind: 'snippet',
      uri: 'snippets/foo.ts',
      title: 'x'.repeat(201)
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalid_title');
  });
});

describe('share_artifact — briefing surfaces in recent_artifacts', () => {
  it('post → readable in briefing.recent_artifacts', () => {
    const { tools } = setup();
    const r = tools.shareArtifact({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      kind: 'spec',
      uri: 'docs/auth-redesign.md',
      title: 'Auth redesign v3',
      summary: 'RS256 migration plan'
    });
    if (!r.ok) throw new Error('shareArtifact failed');

    const briefing = tools.getBriefing({ space_id: SPACE });
    if (!briefing.ok) throw new Error('getBriefing failed');
    const a = briefing.data.recent_artifacts.find(
      (x) => x.artifact_id === r.data.artifact_id
    );
    expect(a).toBeDefined();
    expect(a!.kind).toBe('spec');
    expect(a!.uri).toBe('docs/auth-redesign.md');
    expect(a!.title).toBe('Auth redesign v3');
    expect(a!.summary).toBe('RS256 migration plan');
    expect(a!.principal).toBe('alice');
  });

  it('orders by created_at DESC and caps at 10', () => {
    const { db, tools } = setup();
    for (let i = 0; i < 12; i++) {
      const r = tools.shareArtifact({
        space_id: SPACE,
        principal: 'alice',
        actor: 'alice',
        delegation: 'alice->alice',
        kind: 'doc',
        uri: `docs/item-${i}.md`,
        title: `Item ${i}`
      });
      if (!r.ok) throw new Error('shareArtifact failed');
      // Force created_at order to match insertion order despite same-ms timestamps.
      db.prepare(
        'UPDATE artifacts SET created_at = ?1 WHERE artifact_id = ?2'
      ).run(
        `2026-05-03T15:${String(i).padStart(2, '0')}:00.000Z`,
        r.data.artifact_id
      );
    }

    const briefing = tools.getBriefing({ space_id: SPACE });
    if (!briefing.ok) throw new Error('getBriefing failed');
    expect(briefing.data.recent_artifacts).toHaveLength(10);
    // Newest first — the last inserted should be at index 0.
    expect(briefing.data.recent_artifacts[0]?.title).toBe('Item 11');
    expect(briefing.data.recent_artifacts[9]?.title).toBe('Item 2');
  });

  it('tombstoned artifacts are excluded from the briefing', () => {
    const { db, tools } = setup();
    const r = tools.shareArtifact({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      kind: 'doc',
      uri: 'docs/tombstoned.md',
      title: 'Tombstoned doc'
    });
    if (!r.ok) throw new Error('shareArtifact failed');

    db.prepare(
      'UPDATE artifacts SET tombstoned_at = ?1 WHERE artifact_id = ?2'
    ).run(new Date().toISOString(), r.data.artifact_id);

    const briefing = tools.getBriefing({ space_id: SPACE });
    if (!briefing.ok) throw new Error('getBriefing failed');
    const ids = briefing.data.recent_artifacts.map((a) => a.artifact_id);
    expect(ids).not.toContain(r.data.artifact_id);
  });
});
