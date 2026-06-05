/**
 * Codex round-2 review fix (#14) — integration test for `rebuildProjections`
 * over the new claim-lifecycle event types.
 *
 * Sequences a `scope_claimed` event followed by each of the five new
 * lifecycle event types into the event log, then runs `rebuildProjections`
 * against a fresh DB and asserts the rebuilt claims rows match what live
 * tool inline UPDATEs would have produced.
 */
import { describe, expect, it } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { createSqliteClient } from '../../../src/infra/db/sqlite-client.js';
import { SqliteEventStore } from '../../../src/infra/db/sqlite-event-store.js';
import { rebuildProjections } from '../../../src/infra/projections/rebuild.js';
import type { TeamemEvent } from '../../../src/domain/events/types.js';
import { runAllMigrations } from '../../helpers/migrations.js';

const SPACE = 'space-rebuild-lifecycle';
const REPO = 'github.com/org/repo';
const BRANCH = 'feature/alice';

function setup(): { db: Database; store: SqliteEventStore } {
  const db = createSqliteClient(':memory:');
  runAllMigrations(db);
  db.prepare(
    `INSERT OR IGNORE INTO spaces (id, label, created_at) VALUES (?1, ?2, ?3)`
  ).run(SPACE, 'test-space', '2026-05-01T09:00:00.000Z');
  return { db, store: new SqliteEventStore(db) };
}

function claimEvent(opts: {
  event_id: string;
  claim_id: string;
  path: string;
  ts: string;
}): TeamemEvent {
  return {
    schema_version: '1.0',
    event_id: opts.event_id,
    idempotency_key: `idem-${opts.event_id}`,
    space_id: SPACE,
    timestamp: opts.ts,
    principal: 'alice',
    actor: 'alice',
    delegation: 'alice->alice',
    event_type: 'scope_claimed',
    sprint_id: null,
    delivery_scope: 'space',
    scope: { paths: [opts.path] },
    payload: {
      claim_id: opts.claim_id,
      intent: 'edit',
      repo_id: REPO,
      branch: BRANCH,
      auto_release_mode: 'manual_only',
      path: opts.path
    }
  };
}

describe('rebuildProjections — claim lifecycle replay', () => {
  it('replays all 5 new lifecycle event types into the projected claims rows', () => {
    const { db, store } = setup();

    // Five distinct claims, one per lifecycle outcome, plus one paused-only.
    const claims = [
      { id: 'claim-paused-only', path: 'src/A.ts' },
      { id: 'claim-resumed-after-pause', path: 'src/B.ts' },
      { id: 'claim-force-released', path: 'src/C.ts' },
      { id: 'claim-released-via-git', path: 'src/D.ts' },
      { id: 'claim-expired-by-ttl', path: 'src/E.ts' }
    ];

    let ts = new Date('2026-05-01T10:00:00.000Z').getTime();
    const nextTs = (): string => {
      ts += 60_000;
      return new Date(ts).toISOString();
    };

    for (const c of claims) {
      store.append(
        claimEvent({
          event_id: `evt-claim-${c.id}`,
          claim_id: c.id,
          path: c.path,
          ts: nextTs()
        })
      );
    }

    // claim_paused on paused-only and (will-be-)resumed claims
    const pausedTs1 = nextTs();
    store.append({
      schema_version: '1.0',
      event_id: 'evt-pause-1',
      idempotency_key: 'idem-pause-1',
      space_id: SPACE,
      timestamp: pausedTs1,
      principal: 'alice',
      actor: 'post-checkout',
      delegation: 'alice->post-checkout',
      event_type: 'claim_paused',
      sprint_id: null,
      delivery_scope: 'space',
      scope: { paths: ['src/A.ts'] },
      payload: {
        claim_id: 'claim-paused-only',
        repo_id: REPO,
        branch: BRANCH,
        paused_reason: 'branch_switch'
      }
    });

    const pausedTs2 = nextTs();
    store.append({
      schema_version: '1.0',
      event_id: 'evt-pause-2',
      idempotency_key: 'idem-pause-2',
      space_id: SPACE,
      timestamp: pausedTs2,
      principal: 'alice',
      actor: 'post-checkout',
      delegation: 'alice->post-checkout',
      event_type: 'claim_paused',
      sprint_id: null,
      delivery_scope: 'space',
      scope: { paths: ['src/B.ts'] },
      payload: {
        claim_id: 'claim-resumed-after-pause',
        repo_id: REPO,
        branch: BRANCH,
        paused_reason: 'branch_switch'
      }
    });

    // claim_resumed on the second one only
    const resumeTs = nextTs();
    store.append({
      schema_version: '1.0',
      event_id: 'evt-resume-1',
      idempotency_key: 'idem-resume-1',
      space_id: SPACE,
      timestamp: resumeTs,
      principal: 'alice',
      actor: 'post-checkout',
      delegation: 'alice->post-checkout',
      event_type: 'claim_resumed',
      sprint_id: null,
      delivery_scope: 'space',
      scope: { paths: ['src/B.ts'] },
      payload: {
        claim_id: 'claim-resumed-after-pause',
        repo_id: REPO,
        branch: BRANCH
      }
    });

    // claim_force_released
    const frTs = nextTs();
    store.append({
      schema_version: '1.0',
      event_id: 'evt-fr-1',
      idempotency_key: 'idem-fr-1',
      space_id: SPACE,
      timestamp: frTs,
      principal: 'bob',
      actor: 'bob',
      delegation: 'bob->bob',
      event_type: 'claim_force_released',
      sprint_id: null,
      delivery_scope: 'space',
      scope: { paths: ['src/C.ts'] },
      payload: {
        claim_id: 'claim-force-released',
        repo_id: REPO,
        branch: BRANCH,
        path: 'src/C.ts',
        released_by: 'bob',
        original_holder: 'alice',
        released_at: frTs
      }
    });

    // scope_released_via_git
    const gitTs = nextTs();
    store.append({
      schema_version: '1.0',
      event_id: 'evt-git-1',
      idempotency_key: 'idem-git-1',
      space_id: SPACE,
      timestamp: gitTs,
      principal: 'alice',
      actor: 'post-commit',
      delegation: 'alice->post-commit',
      event_type: 'scope_released_via_git',
      sprint_id: null,
      delivery_scope: 'space',
      scope: { paths: ['src/D.ts'] },
      payload: {
        claim_id: 'claim-released-via-git',
        repo_id: REPO,
        branch: BRANCH,
        path: 'src/D.ts',
        head_sha: 'abc1234'
      }
    });

    // claim_expired
    const expTs = nextTs();
    store.append({
      schema_version: '1.0',
      event_id: 'evt-exp-1',
      idempotency_key: 'idem-exp-1',
      space_id: SPACE,
      timestamp: expTs,
      principal: 'alice',
      actor: 'ttl-sweeper',
      delegation: 'alice->ttl-sweeper',
      event_type: 'claim_expired',
      sprint_id: null,
      delivery_scope: 'space',
      scope: { paths: ['src/E.ts'] },
      payload: {
        claim_id: 'claim-expired-by-ttl',
        expired_at: expTs
      }
    });

    // Drop the projected claims and rebuild from the event log.
    db.prepare('DELETE FROM claims WHERE space_id = ?1').run(SPACE);
    const result = rebuildProjections(db, SPACE);
    // 5 scope_claimed + 2 paused + 1 resumed + 1 force-released + 1 git-released + 1 expired = 11
    expect(result.replayed).toBe(11);

    const rows = db
      .prepare(
        `SELECT claim_id, status, released_at, paused_at, paused_reason
           FROM claims WHERE space_id = ?1 ORDER BY claim_id`
      )
      .all(SPACE) as Array<{
      claim_id: string;
      status: string;
      released_at: string | null;
      paused_at: string | null;
      paused_reason: string | null;
    }>;

    const byId = new Map(rows.map((r) => [r.claim_id, r]));

    // Paused-only: still active, paused_at set, paused_reason set.
    const pausedOnly = byId.get('claim-paused-only');
    expect(pausedOnly?.status).toBe('active');
    expect(pausedOnly?.paused_at).toBe(pausedTs1);
    expect(pausedOnly?.paused_reason).toBe('branch_switch');
    expect(pausedOnly?.released_at).toBeNull();

    // Resumed after pause: paused_at and paused_reason cleared.
    const resumed = byId.get('claim-resumed-after-pause');
    expect(resumed?.status).toBe('active');
    expect(resumed?.paused_at).toBeNull();
    expect(resumed?.paused_reason).toBeNull();
    expect(resumed?.released_at).toBeNull();

    // Force released: status=released, released_at=event ts.
    const fr = byId.get('claim-force-released');
    expect(fr?.status).toBe('released');
    expect(fr?.released_at).toBe(frTs);

    // Released via git: same shape.
    const git = byId.get('claim-released-via-git');
    expect(git?.status).toBe('released');
    expect(git?.released_at).toBe(gitTs);

    // TTL expired: per src/domain/claim-lifecycle.ts, ttl_expired → 'released'.
    const exp = byId.get('claim-expired-by-ttl');
    expect(exp?.status).toBe('released');
    expect(exp?.released_at).toBe(expTs);
  });
});
