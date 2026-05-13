/**
 * Slice #33 — pause_claims_for_branch / resume_claims_for_branch integration tests.
 *
 * AC coverage:
 *  - pauseClaimsForBranch: sets paused_at/paused_reason, emits claim_paused event,
 *    all in db.transaction().
 *  - resumeClaimsForBranch: clears paused_at/paused_reason, emits claim_resumed event,
 *    all in db.transaction().
 *  - Double-pause is a no-op (already-paused claims are skipped).
 *  - Resume of non-paused claims is a no-op.
 *  - claimScope returns claim_paused_by_peer (not scope_conflict) when overlap is paused.
 *  - claim_paused_by_peer payload is shape-identical to scope_conflict + paused_at/paused_reason.
 *  - After resume, same overlap returns scope_conflict (active, not paused).
 *  - Coord_pref router: claim_paused_by_peer flows same as scope_conflict (no new branch needed).
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import { createSqliteClient } from '../../../src/infra/db/sqlite-client.js';
import { SqliteEventStore } from '../../../src/infra/db/sqlite-event-store.js';
import { createTeamemTools } from '../../../src/server/tools/index.js';
import type { ScopeConflictPayload } from '../../../src/server/errors.js';
import { runAllMigrations } from '../../helpers/migrations.js';
import type { Database } from 'bun:sqlite';

function setup(): {
  db: Database;
  tools: ReturnType<typeof createTeamemTools>;
} {
  const db = createSqliteClient(':memory:');
  runAllMigrations(db);
  const store = new SqliteEventStore(db);
  const tools = createTeamemTools({ db, store });
  return { db, tools };
}

const SPACE = 'space-pr-01';
const REPO = 'github.com/org/repo';
const BRANCH = 'feature/alice';
const PATH = 'src/Form.jsx';

function seedClaim(
  tools: ReturnType<typeof createTeamemTools>,
  principal: string,
  branch = BRANCH,
  path = PATH
): string {
  const result = tools.claimScope({
    space_id: SPACE,
    principal,
    actor: principal,
    delegation: `${principal}->${principal}`,
    scope: { paths: [path] },
    repo_id: REPO,
    branch,
    auto_release_mode: 'manual_only'
  });
  if (!result.ok)
    throw new Error(`seed claim failed: ${JSON.stringify(result)}`);
  return result.data.claim_id;
}

describe('pauseClaimsForBranch tool (slice #33)', () => {
  let db: Database;
  let tools: ReturnType<typeof createTeamemTools>;

  beforeEach(() => {
    ({ db, tools } = setup());
    db.prepare(
      `INSERT OR IGNORE INTO spaces (id, label, created_at) VALUES (?1, ?2, ?3)`
    ).run(SPACE, 'test-space', new Date().toISOString());
  });

  it('sets paused_at and paused_reason on active claims and emits claim_paused event', () => {
    seedClaim(tools, 'alice');

    const result = tools.pauseClaimsForBranch({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      repo_id: REPO,
      branch: BRANCH,
      reason: 'branch_switch'
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.paused_count).toBe(1);

    const claim = db
      .prepare(
        `SELECT paused_at, paused_reason FROM claims WHERE space_id = ?1 AND principal = ?2 AND status = 'active'`
      )
      .get(SPACE, 'alice') as {
      paused_at: string | null;
      paused_reason: string | null;
    } | null;

    expect(claim?.paused_at).toBeTruthy();
    expect(claim?.paused_reason).toBe('branch_switch');

    const event = db
      .prepare(
        `SELECT event_type, payload_json FROM events WHERE event_type = 'claim_paused' LIMIT 1`
      )
      .get() as { event_type: string; payload_json: string } | null;

    expect(event).toBeTruthy();
    const payload = JSON.parse(event!.payload_json) as Record<string, unknown>;
    expect(payload.repo_id).toBe(REPO);
    expect(payload.branch).toBe(BRANCH);
    expect(payload.paused_reason).toBe('branch_switch');
  });

  it('returns paused_count=0 when no active non-paused claims exist', () => {
    const result = tools.pauseClaimsForBranch({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      repo_id: REPO,
      branch: BRANCH,
      reason: 'branch_switch'
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.paused_count).toBe(0);
  });

  it('double-pause is a no-op — already-paused claims are skipped', () => {
    seedClaim(tools, 'alice');

    tools.pauseClaimsForBranch({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      repo_id: REPO,
      branch: BRANCH,
      reason: 'branch_switch'
    });

    const second = tools.pauseClaimsForBranch({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      repo_id: REPO,
      branch: BRANCH,
      reason: 'branch_switch'
    });

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.paused_count).toBe(0);

    const eventCount = (
      db
        .prepare(
          `SELECT COUNT(*) as c FROM events WHERE event_type = 'claim_paused'`
        )
        .get() as { c: number }
    ).c;
    expect(eventCount).toBe(1);
  });

  it('codex-review task #3: bulk pause atomically locks branch — no claim escapes (10 active + late peer claim)', () => {
    // Seed 10 active claims for alice on the same branch.
    for (let i = 0; i < 10; i++) {
      seedClaim(tools, 'alice', BRANCH, `src/file-${i}.ts`);
    }

    // Pause alice's branch. With .immediate() the locked tx pauses them
    // all atomically — no fetch-then-iterate window where a new claim
    // could slip through.
    const pauseResult = tools.pauseClaimsForBranch({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      repo_id: REPO,
      branch: BRANCH,
      reason: 'branch_switch'
    });
    expect(pauseResult.ok).toBe(true);
    if (!pauseResult.ok) return;
    expect(pauseResult.data.paused_count).toBe(10);

    // Now bob tries to claim path-0 on the same branch — alice's claim
    // is paused, so bob must see claim_paused_by_peer (NOT
    // scope_conflict, which would mean alice's claim escaped pause).
    const bobAttempt = tools.claimScope({
      space_id: SPACE,
      principal: 'bob',
      actor: 'bob',
      delegation: 'bob->bob',
      scope: { paths: ['src/file-0.ts'] },
      repo_id: REPO,
      branch: BRANCH,
      auto_release_mode: 'manual_only'
    });
    expect(bobAttempt.ok).toBe(false);
    if (bobAttempt.ok) return;
    expect(bobAttempt.error.code).toBe('claim_paused_by_peer');

    // Verify all 10 claims have paused_at set — none escaped.
    const allPaused = (
      db
        .prepare(
          `SELECT COUNT(*) as c FROM claims
        WHERE space_id = ?1 AND principal = 'alice' AND status = 'active'
          AND paused_at IS NOT NULL`
        )
        .get(SPACE) as { c: number }
    ).c;
    expect(allPaused).toBe(10);

    // And none remain unpaused.
    const stillActive = (
      db
        .prepare(
          `SELECT COUNT(*) as c FROM claims
        WHERE space_id = ?1 AND principal = 'alice' AND status = 'active'
          AND paused_at IS NULL`
        )
        .get(SPACE) as { c: number }
    ).c;
    expect(stillActive).toBe(0);
  });

  it('only pauses claims for the authenticated principal', () => {
    seedClaim(tools, 'alice');
    seedClaim(tools, 'bob', BRANCH, 'src/Other.jsx');

    tools.pauseClaimsForBranch({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      repo_id: REPO,
      branch: BRANCH,
      reason: 'branch_switch'
    });

    const bobClaim = db
      .prepare(
        `SELECT paused_at FROM claims WHERE space_id = ?1 AND principal = ?2 AND status = 'active'`
      )
      .get(SPACE, 'bob') as { paused_at: string | null } | null;

    expect(bobClaim?.paused_at).toBeNull();
  });
});

describe('resumeClaimsForBranch tool (slice #33)', () => {
  let db: Database;
  let tools: ReturnType<typeof createTeamemTools>;

  beforeEach(() => {
    ({ db, tools } = setup());
    db.prepare(
      `INSERT OR IGNORE INTO spaces (id, label, created_at) VALUES (?1, ?2, ?3)`
    ).run(SPACE, 'test-space', new Date().toISOString());
  });

  it('clears paused_at/paused_reason and emits claim_resumed event', () => {
    seedClaim(tools, 'alice');
    tools.pauseClaimsForBranch({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      repo_id: REPO,
      branch: BRANCH,
      reason: 'branch_switch'
    });

    const result = tools.resumeClaimsForBranch({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      repo_id: REPO,
      branch: BRANCH
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.resumed_count).toBe(1);

    const claim = db
      .prepare(
        `SELECT paused_at, paused_reason FROM claims WHERE space_id = ?1 AND principal = ?2 AND status = 'active'`
      )
      .get(SPACE, 'alice') as {
      paused_at: string | null;
      paused_reason: string | null;
    } | null;

    expect(claim?.paused_at).toBeNull();
    expect(claim?.paused_reason).toBeNull();

    const event = db
      .prepare(
        `SELECT event_type FROM events WHERE event_type = 'claim_resumed' LIMIT 1`
      )
      .get() as { event_type: string } | null;

    expect(event?.event_type).toBe('claim_resumed');
  });

  it('resume of non-paused claims returns resumed_count=0', () => {
    seedClaim(tools, 'alice');

    const result = tools.resumeClaimsForBranch({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      repo_id: REPO,
      branch: BRANCH
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.resumed_count).toBe(0);
  });
});

describe('claimScope claim_paused_by_peer error (slice #33)', () => {
  let db: Database;
  let tools: ReturnType<typeof createTeamemTools>;

  beforeEach(() => {
    ({ db, tools } = setup());
    db.prepare(
      `INSERT OR IGNORE INTO spaces (id, label, created_at) VALUES (?1, ?2, ?3)`
    ).run(SPACE, 'test-space', new Date().toISOString());
  });

  it('returns claim_paused_by_peer (not scope_conflict) when overlap claim is paused', () => {
    seedClaim(tools, 'alice');

    tools.pauseClaimsForBranch({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      repo_id: REPO,
      branch: BRANCH,
      reason: 'branch_switch'
    });

    const result = tools.claimScope({
      space_id: SPACE,
      principal: 'bob',
      actor: 'bob',
      delegation: 'bob->bob',
      scope: { paths: [PATH] },
      repo_id: REPO,
      branch: BRANCH,
      auto_release_mode: 'manual_only'
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const err = result.error as unknown as ScopeConflictPayload;
    expect(err.code).toBe('claim_paused_by_peer');
    expect(err.conflicting_principal).toBe('alice');
    expect(err.conflicting_claim_id).toBeTruthy();
    expect(Array.isArray(err.colliding_paths)).toBe(true);
    expect(err.paused_at).toBeTruthy();
  });

  it('claim_paused_by_peer payload has shape parity with scope_conflict (required fields)', () => {
    seedClaim(tools, 'alice');
    tools.pauseClaimsForBranch({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      repo_id: REPO,
      branch: BRANCH,
      reason: 'branch_switch'
    });

    const pausedResult = tools.claimScope({
      space_id: SPACE,
      principal: 'bob',
      actor: 'bob',
      delegation: 'bob->bob',
      scope: { paths: [PATH] },
      repo_id: REPO,
      branch: BRANCH,
      auto_release_mode: 'manual_only'
    });

    expect(pausedResult.ok).toBe(false);
    if (pausedResult.ok) return;
    const err = pausedResult.error as Record<string, unknown>;

    // Shape-identical to scope_conflict fields
    expect(typeof err.code).toBe('string');
    expect(typeof err.message).toBe('string');
    expect(typeof err.conflicting_claim_id).toBe('string');
    expect(typeof err.conflicting_principal).toBe('string');
    expect(Array.isArray(err.colliding_paths)).toBe(true);
    // Plus the paused-specific fields
    expect(typeof err.paused_at).toBe('string');
  });

  it('after resume, same overlap returns scope_conflict (active, not paused)', () => {
    seedClaim(tools, 'alice');

    tools.pauseClaimsForBranch({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      repo_id: REPO,
      branch: BRANCH,
      reason: 'branch_switch'
    });

    tools.resumeClaimsForBranch({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      repo_id: REPO,
      branch: BRANCH
    });

    const result = tools.claimScope({
      space_id: SPACE,
      principal: 'bob',
      actor: 'bob',
      delegation: 'bob->bob',
      scope: { paths: [PATH] },
      repo_id: REPO,
      branch: BRANCH,
      auto_release_mode: 'manual_only'
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('scope_conflict');
  });

  it('coord_pref router: claim_paused_by_peer and scope_conflict share the same error shape fields', () => {
    // Both errors must have the same base fields so the coord_pref router
    // (ADR-0001) needs no per-error-class branch.
    seedClaim(tools, 'alice');

    // Get a scope_conflict (not paused)
    const conflictResult = tools.claimScope({
      space_id: SPACE,
      principal: 'bob',
      actor: 'bob',
      delegation: 'bob->bob',
      scope: { paths: [PATH] },
      repo_id: REPO,
      branch: BRANCH,
      auto_release_mode: 'manual_only'
    });
    expect(conflictResult.ok).toBe(false);
    if (conflictResult.ok) return;
    expect(conflictResult.error.code).toBe('scope_conflict');

    // Now pause alice's claim and get a claim_paused_by_peer
    tools.pauseClaimsForBranch({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      repo_id: REPO,
      branch: BRANCH,
      reason: 'branch_switch'
    });

    // Bob (different space to avoid idempotency collision) tries again
    const db2 = createSqliteClient(':memory:');
    runAllMigrations(db2);
    const store2 = new SqliteEventStore(db2);
    const tools2 = createTeamemTools({ db: db2, store: store2 });
    db2
      .prepare(
        `INSERT OR IGNORE INTO spaces (id, label, created_at) VALUES (?1, ?2, ?3)`
      )
      .run(SPACE, 'test-space', new Date().toISOString());

    seedClaim(tools2, 'alice');
    tools2.pauseClaimsForBranch({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      repo_id: REPO,
      branch: BRANCH,
      reason: 'branch_switch'
    });

    const pausedResult = tools2.claimScope({
      space_id: SPACE,
      principal: 'bob',
      actor: 'bob',
      delegation: 'bob->bob',
      scope: { paths: [PATH] },
      repo_id: REPO,
      branch: BRANCH,
      auto_release_mode: 'manual_only'
    });
    expect(pausedResult.ok).toBe(false);
    if (pausedResult.ok) return;

    // Both error shapes must have these fields (the router reads them)
    const conflictErr = conflictResult.error as Record<string, unknown>;
    const pausedErr = pausedResult.error as Record<string, unknown>;

    for (const field of [
      'code',
      'message',
      'conflicting_claim_id',
      'conflicting_principal',
      'colliding_paths'
    ]) {
      expect(field in conflictErr).toBe(true);
      expect(field in pausedErr).toBe(true);
    }
  });
});

describe('end-to-end pause/resume lifecycle (slice #33)', () => {
  let db: Database;
  let tools: ReturnType<typeof createTeamemTools>;

  beforeEach(() => {
    ({ db, tools } = setup());
    db.prepare(
      `INSERT OR IGNORE INTO spaces (id, label, created_at) VALUES (?1, ?2, ?3)`
    ).run(SPACE, 'test-space', new Date().toISOString());
  });

  it('alice acquires claim, pause → bob sees claim_paused_by_peer, resume → bob sees scope_conflict', () => {
    // Alice acquires claim on feature/alice
    seedClaim(tools, 'alice', BRANCH);

    // Simulated post-checkout feature/alice → main: pause alice's claims
    tools.pauseClaimsForBranch({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      repo_id: REPO,
      branch: BRANCH,
      reason: 'branch_switch'
    });

    // Bob's claim_scope on feature/alice returns claim_paused_by_peer
    const pausedCheck = tools.claimScope({
      space_id: SPACE,
      principal: 'bob',
      actor: 'bob',
      delegation: 'bob->bob',
      scope: { paths: [PATH] },
      repo_id: REPO,
      branch: BRANCH,
      auto_release_mode: 'manual_only'
    });
    expect(pausedCheck.ok).toBe(false);
    if (pausedCheck.ok) return;
    expect(pausedCheck.error.code).toBe('claim_paused_by_peer');

    // Simulated post-checkout main → feature/alice: resume alice's claims
    tools.resumeClaimsForBranch({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      repo_id: REPO,
      branch: BRANCH
    });

    // Bob's repeat claim_scope now returns scope_conflict (active, not paused)
    const activeCheck = tools.claimScope({
      space_id: SPACE,
      principal: 'bob',
      actor: 'bob',
      delegation: 'bob->bob',
      scope: { paths: [PATH] },
      repo_id: REPO,
      branch: BRANCH,
      auto_release_mode: 'manual_only'
    });
    expect(activeCheck.ok).toBe(false);
    if (activeCheck.ok) return;
    expect(activeCheck.error.code).toBe('scope_conflict');
  });
});

describe('pause/resume cycles must not collide on idempotency_key (codex P1)', () => {
  it('pause → resume → pause again succeeds with two distinct claim_paused events', async () => {
    const { db, tools } = setup();
    const claimId = seedClaim(tools, 'alice');

    // Cycle 1: pause
    const p1 = tools.pauseClaimsForBranch({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      repo_id: REPO,
      branch: BRANCH,
      reason: 'branch_switch'
    });
    expect(p1.ok).toBe(true);

    // Resume
    await new Promise((r) => setTimeout(r, 5));
    const r1 = tools.resumeClaimsForBranch({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      repo_id: REPO,
      branch: BRANCH
    });
    expect(r1.ok).toBe(true);

    // Cycle 2: pause again — used to throw because the idempotency_key
    // `pause-${claim_id}-${principal}` collided with cycle 1's event.
    await new Promise((r) => setTimeout(r, 5));
    const p2 = tools.pauseClaimsForBranch({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      repo_id: REPO,
      branch: BRANCH,
      reason: 'branch_switch'
    });
    expect(p2.ok).toBe(true);

    const pausedEvents = db
      .query(
        `SELECT COUNT(*) AS cnt FROM events WHERE event_type = 'claim_paused' AND payload_json LIKE ?`
      )
      .get(`%${claimId}%`) as { cnt: number };
    expect(pausedEvents.cnt).toBe(2);
  });

  it('resume → pause → resume cycle succeeds with two distinct claim_resumed events', async () => {
    const { db, tools } = setup();
    const claimId = seedClaim(tools, 'alice');

    // Pause first so we have something to resume.
    tools.pauseClaimsForBranch({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      repo_id: REPO,
      branch: BRANCH,
      reason: 'branch_switch'
    });

    // Cycle 1: resume.
    await new Promise((r) => setTimeout(r, 5));
    expect(
      tools.resumeClaimsForBranch({
        space_id: SPACE,
        principal: 'alice',
        actor: 'alice',
        delegation: 'alice->alice',
        repo_id: REPO,
        branch: BRANCH
      }).ok
    ).toBe(true);

    // Pause to enable cycle 2 resume.
    await new Promise((r) => setTimeout(r, 5));
    tools.pauseClaimsForBranch({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      repo_id: REPO,
      branch: BRANCH,
      reason: 'branch_switch'
    });

    // Cycle 2: resume — used to collide with cycle 1's resume key.
    await new Promise((r) => setTimeout(r, 5));
    expect(
      tools.resumeClaimsForBranch({
        space_id: SPACE,
        principal: 'alice',
        actor: 'alice',
        delegation: 'alice->alice',
        repo_id: REPO,
        branch: BRANCH
      }).ok
    ).toBe(true);

    const resumedEvents = db
      .query(
        `SELECT COUNT(*) AS cnt FROM events WHERE event_type = 'claim_resumed' AND payload_json LIKE ?`
      )
      .get(`%${claimId}%`) as { cnt: number };
    expect(resumedEvents.cnt).toBe(2);
  });
});
