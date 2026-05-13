/**
 * Codex round-2 review fix (#14) — projection handlers for the new
 * claim-lifecycle event types.
 *
 * Live tools UPDATE the claims row inline inside the same transaction as the
 * event emission, but `rebuildProjections` replays the event log through
 * `applyProjectionUpdate` only. Without these handlers, a rebuilt projection
 * left already-released / paused / expired claims in their pre-event state.
 *
 * Each test seeds a `scope_claimed` event (active claim), applies one
 * lifecycle event, and asserts the projected claim row matches what the
 * inline tool UPDATEs would have produced.
 */
import { describe, expect, it } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { createSqliteClient } from '../../../src/infra/db/sqlite-client.js';
import { applyProjectionUpdate } from '../../../src/infra/projections/apply-event.js';
import type { TeamemEvent } from '../../../src/domain/events/types.js';
import { runAllMigrations } from '../../helpers/migrations.js';

const SPACE = 'space-claim-lifecycle';
const REPO = 'github.com/org/repo';
const BRANCH = 'feature/alice';
const PATH = 'src/Form.jsx';

function setup(): Database {
  const db = createSqliteClient(':memory:');
  runAllMigrations(db);
  db.prepare(
    `INSERT OR IGNORE INTO spaces (id, label, created_at) VALUES (?1, ?2, ?3)`
  ).run(SPACE, 'test-space', '2026-05-01T09:00:00.000Z');
  return db;
}

function seedActiveClaim(db: Database, claimId: string): void {
  const claimEvt: TeamemEvent = {
    schema_version: '1.0',
    event_id: `evt-claim-${claimId}`,
    idempotency_key: `idem-claim-${claimId}`,
    space_id: SPACE,
    timestamp: '2026-05-01T10:00:00.000Z',
    principal: 'alice',
    actor: 'alice',
    delegation: 'alice->alice',
    event_type: 'scope_claimed',
    scope: { paths: [PATH] },
    payload: {
      claim_id: claimId,
      intent: 'edit',
      repo_id: REPO,
      branch: BRANCH,
      auto_release_mode: 'manual_only',
      path: PATH
    }
  };
  applyProjectionUpdate(db, claimEvt);
}

function readClaim(db: Database, claimId: string) {
  return db
    .prepare(
      `SELECT status, released_at, paused_at, paused_reason
         FROM claims WHERE claim_id = ?1`
    )
    .get(claimId) as
    | {
        status: string;
        released_at: string | null;
        paused_at: string | null;
        paused_reason: string | null;
      }
    | undefined;
}

describe('claim lifecycle projections — claim_paused', () => {
  it('sets paused_at and paused_reason on the claim row', () => {
    const db = setup();
    seedActiveClaim(db, 'claim-pause-1');

    const evt: TeamemEvent = {
      schema_version: '1.0',
      event_id: 'evt-pause-1',
      idempotency_key: 'idem-pause-1',
      space_id: SPACE,
      timestamp: '2026-05-01T11:00:00.000Z',
      principal: 'alice',
      actor: 'post-checkout',
      delegation: 'alice->post-checkout',
      event_type: 'claim_paused',
      scope: { paths: [PATH] },
      payload: {
        claim_id: 'claim-pause-1',
        repo_id: REPO,
        branch: BRANCH,
        paused_at: '2026-05-01T11:00:00.000Z',
        paused_reason: 'branch_switch'
      }
    };
    applyProjectionUpdate(db, evt);

    const row = readClaim(db, 'claim-pause-1');
    expect(row?.status).toBe('active');
    expect(row?.paused_at).toBe('2026-05-01T11:00:00.000Z');
    expect(row?.paused_reason).toBe('branch_switch');
  });
});

describe('claim lifecycle projections — claim_resumed', () => {
  it('clears paused_at and paused_reason on the claim row', () => {
    const db = setup();
    seedActiveClaim(db, 'claim-resume-1');
    // Pause first.
    applyProjectionUpdate(db, {
      schema_version: '1.0',
      event_id: 'evt-pause-2',
      idempotency_key: 'idem-pause-2',
      space_id: SPACE,
      timestamp: '2026-05-01T11:00:00.000Z',
      principal: 'alice',
      actor: 'post-checkout',
      delegation: 'alice->post-checkout',
      event_type: 'claim_paused',
      scope: { paths: [PATH] },
      payload: {
        claim_id: 'claim-resume-1',
        paused_reason: 'branch_switch'
      }
    });

    const evt: TeamemEvent = {
      schema_version: '1.0',
      event_id: 'evt-resume-1',
      idempotency_key: 'idem-resume-1',
      space_id: SPACE,
      timestamp: '2026-05-01T12:00:00.000Z',
      principal: 'alice',
      actor: 'post-checkout',
      delegation: 'alice->post-checkout',
      event_type: 'claim_resumed',
      scope: { paths: [PATH] },
      payload: { claim_id: 'claim-resume-1' }
    };
    applyProjectionUpdate(db, evt);

    const row = readClaim(db, 'claim-resume-1');
    expect(row?.status).toBe('active');
    expect(row?.paused_at).toBeNull();
    expect(row?.paused_reason).toBeNull();
  });
});

describe('claim lifecycle projections — claim_force_released', () => {
  it('marks the claim released and stamps released_at', () => {
    const db = setup();
    seedActiveClaim(db, 'claim-fr-1');

    const evt: TeamemEvent = {
      schema_version: '1.0',
      event_id: 'evt-fr-1',
      idempotency_key: 'idem-fr-1',
      space_id: SPACE,
      timestamp: '2026-05-01T13:00:00.000Z',
      principal: 'bob',
      actor: 'bob',
      delegation: 'bob->bob',
      event_type: 'claim_force_released',
      scope: { paths: [PATH] },
      payload: {
        claim_id: 'claim-fr-1',
        repo_id: REPO,
        branch: BRANCH,
        path: PATH,
        released_by: 'bob',
        original_holder: 'alice',
        released_at: '2026-05-01T13:00:00.000Z'
      }
    };
    applyProjectionUpdate(db, evt);

    const row = readClaim(db, 'claim-fr-1');
    expect(row?.status).toBe('released');
    expect(row?.released_at).toBe('2026-05-01T13:00:00.000Z');
  });
});

describe('claim lifecycle projections — scope_released_via_git', () => {
  it('marks the claim released and stamps released_at', () => {
    const db = setup();
    seedActiveClaim(db, 'claim-git-1');

    const evt: TeamemEvent = {
      schema_version: '1.0',
      event_id: 'evt-git-1',
      idempotency_key: 'idem-git-1',
      space_id: SPACE,
      timestamp: '2026-05-01T14:00:00.000Z',
      principal: 'alice',
      actor: 'post-commit',
      delegation: 'alice->post-commit',
      event_type: 'scope_released_via_git',
      scope: { paths: [PATH] },
      payload: {
        claim_id: 'claim-git-1',
        repo_id: REPO,
        branch: BRANCH,
        path: PATH,
        head_sha: 'abc1234'
      }
    };
    applyProjectionUpdate(db, evt);

    const row = readClaim(db, 'claim-git-1');
    expect(row?.status).toBe('released');
    expect(row?.released_at).toBe('2026-05-01T14:00:00.000Z');
  });
});

describe('claim lifecycle projections — claim_expired', () => {
  it('marks the claim released and stamps released_at (TTL expiry maps to released per the FSM)', () => {
    const db = setup();
    seedActiveClaim(db, 'claim-exp-1');

    const evt: TeamemEvent = {
      schema_version: '1.0',
      event_id: 'evt-exp-1',
      idempotency_key: 'idem-exp-1',
      space_id: SPACE,
      timestamp: '2026-05-01T15:00:00.000Z',
      principal: 'alice',
      actor: 'ttl-sweeper',
      delegation: 'alice->ttl-sweeper',
      event_type: 'claim_expired',
      scope: { paths: [PATH] },
      payload: {
        claim_id: 'claim-exp-1',
        expired_at: '2026-05-01T15:00:00.000Z'
      }
    };
    applyProjectionUpdate(db, evt);

    const row = readClaim(db, 'claim-exp-1');
    // Per src/domain/claim-lifecycle.ts transition: ttl_expired → nextStatus 'released'.
    expect(row?.status).toBe('released');
    expect(row?.released_at).toBe('2026-05-01T15:00:00.000Z');
  });
});
