import { describe, expect, it } from 'bun:test';
import { createSqliteClient } from '../../../src/infra/db/sqlite-client.js';
import { SqliteEventStore } from '../../../src/infra/db/sqlite-event-store.js';
import { createTeamemTools } from '../../../src/server/tools/index.js';
import { runAllMigrations } from '../../helpers/migrations.js';

const SPACE = 'space-sprint-context';
const REPO = 'github.com/org/repo';
const BRANCH = 'feature/context';
const HEAD_SHA_BEFORE = 'aaa1111111111111111111111111111111111111';
const HEAD_SHA_AFTER = 'bbb2222222222222222222222222222222222222';

function setup() {
  const db = createSqliteClient(':memory:');
  runAllMigrations(db);
  db.exec(
    `INSERT INTO spaces (id, label, creator_member_id, created_at)
     VALUES ('${SPACE}', 'Sprint Context', 'm-alice', '2026-05-27T00:00:00.000Z')`
  );
  db.exec(
    `INSERT INTO members (id, space_id, name, joined_at, is_creator)
     VALUES
       ('m-alice', '${SPACE}', 'alice', '2026-05-27T00:00:00.000Z', 1),
       ('m-bob', '${SPACE}', 'bob', '2026-05-27T00:00:01.000Z', 0),
       ('m-carol', '${SPACE}', 'carol', '2026-05-27T00:00:02.000Z', 0)`
  );
  const store = new SqliteEventStore(db);
  const tools = createTeamemTools({ db, store });
  return { db, tools };
}

function claim(
  tools: ReturnType<typeof createTeamemTools>,
  principal: string,
  path: string,
  opts: {
    current_head_sha?: string;
    auto_release_mode?: 'on_commit' | 'manual_only' | 'ttl';
  } = {}
) {
  return tools.claimScope({
    space_id: SPACE,
    principal,
    actor: principal,
    delegation: `${principal}->teamem`,
    scope: { paths: [path] },
    repo_id: REPO,
    branch: BRANCH,
    ...opts
  });
}

function sprintIdFor(
  db: ReturnType<typeof createSqliteClient>,
  slug: string
): string {
  const row = db
    .prepare('SELECT sprint_id FROM sprints WHERE slug = ?1')
    .get(slug) as { sprint_id: string } | null;
  expect(row).not.toBeNull();
  return row!.sprint_id;
}

describe('Issue 03 sprint-scoped claims and coordination', () => {
  it('defaults blockers to the current Sprint context', () => {
    const { db, tools } = setup();
    const sprint = tools.createSprint({
      space_id: SPACE,
      principal: 'alice',
      display_name: 'Blocker Sprint',
      goal: 'Keep blockers scoped'
    });
    expect(sprint.ok).toBe(true);
    if (!sprint.ok) return;
    const sprintId = sprintIdFor(db, 'blocker-sprint');

    const raised = tools.raiseBlocker({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->teamem',
      summary: 'Need a fixture from Bob'
    });
    expect(raised.ok).toBe(true);
    if (!raised.ok) return;
    expect(raised.data).toMatchObject({
      sprint_id: sprintId,
      context: 'sprint'
    });

    expect(
      db
        .prepare('SELECT sprint_id, status FROM blockers WHERE blocker_id = ?1')
        .get(raised.data.blocker_id)
    ).toEqual({ sprint_id: sprintId, status: 'open' });
  });

  it('defaults blockers to Space context when the member is not in a Sprint', () => {
    const { db, tools } = setup();

    const raised = tools.raiseBlocker({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->teamem',
      summary: 'Need deployment credentials'
    });
    expect(raised.ok).toBe(true);
    if (!raised.ok) return;
    expect(raised.data).toMatchObject({
      sprint_id: null,
      context: 'space'
    });

    expect(
      db
        .prepare('SELECT sprint_id, status FROM blockers WHERE blocker_id = ?1')
        .get(raised.data.blocker_id)
    ).toEqual({ sprint_id: null, status: 'open' });
  });

  it('requires explicit Space scope to resolve a Space blocker while in Sprint mode', () => {
    const { db, tools } = setup();

    const spaceBlocker = tools.raiseBlocker({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->teamem',
      summary: 'Need Space-wide decision'
    });
    expect(spaceBlocker.ok).toBe(true);
    if (!spaceBlocker.ok) return;

    const sprint = tools.createSprint({
      space_id: SPACE,
      principal: 'alice',
      display_name: 'Escalation Sprint',
      goal: 'Prove explicit escalation'
    });
    expect(sprint.ok).toBe(true);
    if (!sprint.ok) return;

    const implicitResolve = tools.resolveBlocker({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->teamem',
      blocker_id: spaceBlocker.data.blocker_id,
      resolution: 'Resolved in Sprint mode without explicit scope'
    });
    expect(implicitResolve.ok).toBe(false);
    if (implicitResolve.ok) return;
    expect(implicitResolve.error.code).toBe('blocker_not_found');

    const explicitResolve = tools.resolveBlocker({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->teamem',
      blocker_id: spaceBlocker.data.blocker_id,
      resolution: 'Resolved with explicit Space scope',
      scope: 'space'
    });
    expect(explicitResolve.ok).toBe(true);
    if (!explicitResolve.ok) return;
    expect(explicitResolve.data).toMatchObject({
      blocker_id: spaceBlocker.data.blocker_id,
      sprint_id: null,
      context: 'space'
    });

    expect(
      db
        .prepare('SELECT sprint_id, status FROM blockers WHERE blocker_id = ?1')
        .get(spaceBlocker.data.blocker_id)
    ).toEqual({ sprint_id: null, status: 'resolved' });
  });

  it('requires explicit Space scope to raise a Space blocker while in Sprint mode', () => {
    const { db, tools } = setup();
    tools.createSprint({
      space_id: SPACE,
      principal: 'alice',
      display_name: 'Explicit Space Blockers',
      goal: 'Escalate only on request'
    });
    const sprintId = sprintIdFor(db, 'explicit-space-blockers');

    const implicit = tools.raiseBlocker({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->teamem',
      summary: 'Sprint-local blocker'
    });
    expect(implicit.ok).toBe(true);
    if (!implicit.ok) return;
    expect(implicit.data).toMatchObject({
      sprint_id: sprintId,
      context: 'sprint'
    });

    const explicit = tools.raiseBlocker({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->teamem',
      summary: 'Space-wide blocker',
      scope: 'space'
    });
    expect(explicit.ok).toBe(true);
    if (!explicit.ok) return;
    expect(explicit.data).toMatchObject({
      sprint_id: null,
      context: 'space'
    });
  });

  it('stamps claims with current context and filters conflicts/listing by context', () => {
    const { db, tools } = setup();

    const spaceClaim = claim(tools, 'alice', 'src/shared.ts');
    expect(spaceClaim.ok).toBe(true);
    if (!spaceClaim.ok) return;
    const join = tools.createSprint({
      space_id: SPACE,
      principal: 'alice',
      display_name: 'Sprint One',
      goal: 'Focused work'
    });
    expect(join.ok).toBe(true);
    if (!join.ok) return;
    expect(join.data.warnings).toHaveLength(1);
    const sprintOneId = sprintIdFor(db, 'sprint-one');

    const sprintClaim = claim(tools, 'alice', 'src/shared.ts');
    expect(sprintClaim.ok).toBe(true);
    if (!sprintClaim.ok) return;

    const rows = db
      .prepare(
        'SELECT claim_id, sprint_id, status FROM claims ORDER BY created_at ASC'
      )
      .all() as Array<{
      claim_id: string;
      sprint_id: string | null;
      status: string;
    }>;
    expect(rows).toEqual([
      expect.objectContaining({
        claim_id: spaceClaim.data.claim_id,
        sprint_id: null,
        status: 'active'
      }),
      expect.objectContaining({
        claim_id: sprintClaim.data.claim_id,
        sprint_id: sprintOneId,
        status: 'active'
      })
    ]);

    tools.joinSprint({
      space_id: SPACE,
      principal: 'bob',
      sprint: 'sprint-one'
    });
    const sameSprintConflict = claim(tools, 'bob', 'src/shared.ts');
    expect(sameSprintConflict.ok).toBe(false);
    if (sameSprintConflict.ok) return;
    expect(sameSprintConflict.error.code).toBe('scope_conflict');

    tools.createSprint({
      space_id: SPACE,
      principal: 'carol',
      display_name: 'Sprint Two',
      goal: 'Parallel work'
    });
    const crossSprint = claim(tools, 'carol', 'src/shared.ts');
    expect(crossSprint.ok).toBe(true);

    const current = tools.listClaims({
      space_id: SPACE,
      principal: 'alice',
      scope: 'space'
    });
    expect(current.ok).toBe(true);
    if (!current.ok) return;
    expect(current.data.claims.map((row) => row.claim_id)).toEqual([
      sprintClaim.data.claim_id
    ]);

    const spaceView = tools.listClaims({
      space_id: SPACE,
      principal: 'alice',
      scope: 'space',
      view: 'space'
    });
    expect(spaceView.ok).toBe(true);
    if (!spaceView.ok) return;
    expect(spaceView.data.claims.map((row) => row.claim_id)).toEqual([
      spaceClaim.data.claim_id
    ]);

    const leftovers = tools.listClaims({
      space_id: SPACE,
      principal: 'alice',
      scope: 'self',
      view: 'outside_current_context'
    });
    expect(leftovers.ok).toBe(true);
    if (!leftovers.ok) return;
    expect(leftovers.data.claims.map((row) => row.claim_id)).toEqual([
      spaceClaim.data.claim_id
    ]);

    const leave = tools.leaveSprint({ space_id: SPACE, principal: 'alice' });
    expect(leave.ok).toBe(true);
    if (!leave.ok) return;
    expect(leave.data.message).toContain(
      'remain active outside the current context'
    );
    expect(
      db
        .prepare('SELECT status FROM claims WHERE claim_id = ?1')
        .get(sprintClaim.data.claim_id)
    ).toEqual({ status: 'active' });
  });

  it('force-release path defaults to current context but exact id can cross context', () => {
    const { db, tools } = setup();
    tools.createSprint({
      space_id: SPACE,
      principal: 'alice',
      display_name: 'Release Sprint',
      goal: 'Release behavior'
    });
    const sprintId = sprintIdFor(db, 'release-sprint');
    const sprintClaim = claim(tools, 'alice', 'src/release.ts');
    expect(sprintClaim.ok).toBe(true);
    if (!sprintClaim.ok) return;
    tools.leaveSprint({ space_id: SPACE, principal: 'alice' });

    const pathRelease = tools.forceRelease({
      space_id: SPACE,
      principal: 'bob',
      actor: 'bob',
      delegation: 'bob->teamem',
      repo_id: REPO,
      branch: BRANCH,
      path: 'src/release.ts',
      target_principal: 'alice'
    });
    expect(pathRelease.ok).toBe(false);

    const idRelease = tools.forceRelease({
      space_id: SPACE,
      principal: 'bob',
      actor: 'bob',
      delegation: 'bob->teamem',
      claim_id: sprintClaim.data.claim_id
    });
    expect(idRelease.ok).toBe(true);
    if (!idRelease.ok) return;
    expect(idRelease.data).toMatchObject({
      claim_id: sprintClaim.data.claim_id,
      sprint_id: sprintId,
      context: 'sprint'
    });
  });

  it('carries pending edit context through enqueue and unblock resolution', () => {
    const { db, tools } = setup();
    tools.createSprint({
      space_id: SPACE,
      principal: 'alice',
      display_name: 'Queue Sprint',
      goal: 'Queue behavior'
    });
    const sprintId = sprintIdFor(db, 'queue-sprint');
    const sprintClaim = claim(tools, 'alice', 'src/queue.ts');
    expect(sprintClaim.ok).toBe(true);
    if (!sprintClaim.ok) return;
    tools.leaveSprint({ space_id: SPACE, principal: 'alice' });

    const queued = tools.queuePendingEdit({
      space_id: SPACE,
      principal: 'bob',
      actor: 'bob',
      delegation: 'bob->teamem',
      blocking_claim_id: sprintClaim.data.claim_id,
      paths: ['src/queue.ts']
    });
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    expect(
      db
        .prepare('SELECT sprint_id FROM pending_edits WHERE pending_id = ?1')
        .get(queued.data.pending_id)
    ).toEqual({ sprint_id: sprintId });

    const released = tools.releaseScope({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->teamem',
      claim_id: sprintClaim.data.claim_id
    });
    expect(released.ok).toBe(true);
    const releaseEvent = db
      .prepare(
        `SELECT raw_json
           FROM events
          WHERE event_type = 'scope_released'
            AND payload_json LIKE ?1
          ORDER BY timestamp DESC
          LIMIT 1`
      )
      .get(`%${sprintClaim.data.claim_id}%`) as { raw_json: string } | null;
    expect(JSON.parse(releaseEvent?.raw_json ?? '{}')).toMatchObject({
      sprint_id: sprintId,
      delivery_scope: 'sprint'
    });
    const resolved = db
      .prepare(
        `SELECT raw_json
           FROM events
          WHERE event_type = 'conflict_resolved'
          ORDER BY timestamp DESC
          LIMIT 1`
      )
      .get() as { raw_json: string } | null;
    expect(JSON.parse(resolved?.raw_json ?? '{}')).toMatchObject({
      sprint_id: sprintId
    });
  });

  it('does not silently succeed when unblock resolution fails unexpectedly', () => {
    const { db, tools } = setup();
    const spaceClaim = claim(tools, 'alice', 'src/fail-resolve.ts');
    expect(spaceClaim.ok).toBe(true);
    if (!spaceClaim.ok) return;
    const queued = tools.queuePendingEdit({
      space_id: SPACE,
      principal: 'bob',
      actor: 'bob',
      delegation: 'bob->teamem',
      blocking_claim_id: spaceClaim.data.claim_id,
      paths: ['src/fail-resolve.ts']
    });
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    db.exec(
      `CREATE TEMP TRIGGER pending_edits_fail_resolve
       BEFORE UPDATE OF resolved_at ON pending_edits
       WHEN NEW.resolved_at IS NOT NULL
       BEGIN
         SELECT RAISE(FAIL, 'pending resolve failed');
       END`
    );

    expect(() =>
      tools.releaseScope({
        space_id: SPACE,
        principal: 'alice',
        actor: 'alice',
        delegation: 'alice->teamem',
        claim_id: spaceClaim.data.claim_id
      })
    ).toThrow('pending resolve failed');
    expect(
      db
        .prepare('SELECT status, released_at FROM claims WHERE claim_id = ?1')
        .get(spaceClaim.data.claim_id)
    ).toEqual({ status: 'active', released_at: null });
    expect(
      db
        .prepare('SELECT resolved_at FROM pending_edits WHERE pending_id = ?1')
        .get(queued.data.pending_id)
    ).toEqual({ resolved_at: null });
  });

  it('keeps release_scope_via_git events tied to the original claim context', () => {
    const { db, tools } = setup();
    tools.createSprint({
      space_id: SPACE,
      principal: 'alice',
      display_name: 'Git Release Sprint',
      goal: 'Git release behavior'
    });
    const sprintId = sprintIdFor(db, 'git-release-sprint');
    const sprintClaim = claim(tools, 'alice', 'src/git-release.ts', {
      current_head_sha: HEAD_SHA_BEFORE,
      auto_release_mode: 'on_commit'
    });
    expect(sprintClaim.ok).toBe(true);
    if (!sprintClaim.ok) return;
    tools.leaveSprint({ space_id: SPACE, principal: 'alice' });
    const queuedSprint = tools.queuePendingEdit({
      space_id: SPACE,
      principal: 'bob',
      actor: 'bob',
      delegation: 'bob->teamem',
      blocking_claim_id: sprintClaim.data.claim_id,
      paths: ['src/git-release.ts']
    });
    expect(queuedSprint.ok).toBe(true);
    if (!queuedSprint.ok) return;
    const spaceClaim = claim(tools, 'carol', 'src/git-release.ts');
    expect(spaceClaim.ok).toBe(true);
    if (!spaceClaim.ok) return;
    const queuedSpace = tools.queuePendingEdit({
      space_id: SPACE,
      principal: 'bob',
      actor: 'bob',
      delegation: 'bob->teamem',
      blocking_claim_id: spaceClaim.data.claim_id,
      paths: ['src/git-release.ts']
    });
    expect(queuedSpace.ok).toBe(true);
    if (!queuedSpace.ok) return;

    const released = tools.releaseScopeViaGit({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->teamem',
      repo_id: REPO,
      branch: BRANCH,
      paths_with_status: [{ status: 'M', path: 'src/git-release.ts' }],
      current_head_sha: HEAD_SHA_AFTER,
      porcelain_dirty_paths: []
    });
    expect(released.ok).toBe(true);
    if (!released.ok) return;
    expect(released.data.released).toBe(1);

    const releaseEvent = db
      .prepare(
        `SELECT raw_json
           FROM events
          WHERE event_type = 'scope_released_via_git'
            AND payload_json LIKE ?1
          ORDER BY timestamp DESC
          LIMIT 1`
      )
      .get(`%${sprintClaim.data.claim_id}%`) as { raw_json: string } | null;
    expect(JSON.parse(releaseEvent?.raw_json ?? '{}')).toMatchObject({
      sprint_id: sprintId,
      delivery_scope: 'sprint'
    });
    expect(
      db
        .prepare('SELECT resolved_at FROM pending_edits WHERE pending_id = ?1')
        .get(queuedSprint.data.pending_id)
    ).toEqual(expect.objectContaining({ resolved_at: expect.any(String) }));
    expect(
      db
        .prepare('SELECT resolved_at FROM pending_edits WHERE pending_id = ?1')
        .get(queuedSpace.data.pending_id)
    ).toEqual({ resolved_at: null });
    const resolvedEvent = db
      .prepare(
        `SELECT raw_json
           FROM events
          WHERE event_type = 'conflict_resolved'
            AND payload_json LIKE ?1
          ORDER BY timestamp DESC
          LIMIT 1`
      )
      .get(`%${queuedSprint.data.pending_id}%`) as { raw_json: string } | null;
    expect(JSON.parse(resolvedEvent?.raw_json ?? '{}')).toMatchObject({
      sprint_id: sprintId
    });
  });

  it('defaults decisions and gotchas to Sprint scope while Space Rules remain Space-wide', () => {
    const { db, tools } = setup();
    tools.createSprint({
      space_id: SPACE,
      principal: 'alice',
      display_name: 'Memory Sprint',
      goal: 'Memory behavior'
    });
    const sprintId = sprintIdFor(db, 'memory-sprint');

    const decision = tools.publishDecision({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->teamem',
      decision_id: 'dec-sprint',
      title: 'Sprint decision',
      kind: 'process'
    });
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.data.sprint_id).toBe(sprintId);

    const spaceDecision = tools.publishDecision({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->teamem',
      decision_id: 'dec-shared',
      title: 'Space decision',
      kind: 'process',
      scope: 'space'
    });
    expect(spaceDecision.ok).toBe(true);
    if (!spaceDecision.ok) return;
    expect(spaceDecision.data.sprint_id).toBeNull();

    const accidentalCrossContextPublish = tools.publishDecision({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->teamem',
      decision_id: 'dec-shared',
      title: 'Would overwrite Space decision',
      kind: 'process'
    });
    expect(accidentalCrossContextPublish.ok).toBe(false);
    if (accidentalCrossContextPublish.ok) return;
    expect(accidentalCrossContextPublish.error.code).toBe('decision_exists');

    const accidentalCrossContextAmend = tools.amendDecision({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->teamem',
      decision_id: 'dec-shared',
      summary: 'would amend the Space decision without escalation'
    });
    expect(accidentalCrossContextAmend.ok).toBe(false);
    if (accidentalCrossContextAmend.ok) return;
    expect(accidentalCrossContextAmend.error.code).toBe('decision_not_found');

    const explicitSpaceAmend = tools.amendDecision({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->teamem',
      decision_id: 'dec-shared',
      summary: 'explicitly amends the Space decision',
      scope: 'space'
    });
    expect(explicitSpaceAmend.ok).toBe(true);
    if (!explicitSpaceAmend.ok) return;
    expect(explicitSpaceAmend.data.sprint_id).toBeNull();
    const rows = db
      .prepare(
        `SELECT sprint_id, summary, version
           FROM decisions
          WHERE decision_id = 'dec-shared'
          ORDER BY sprint_id IS NOT NULL, sprint_id`
      )
      .all() as Array<{
      sprint_id: string | null;
      summary: string | null;
      version: number;
    }>;
    expect(rows).toEqual([
      {
        sprint_id: null,
        summary: 'explicitly amends the Space decision',
        version: 2
      }
    ]);

    const gotcha = tools.shareFinding({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->teamem',
      kind: 'gotcha',
      summary: 'Sprint-local gotcha',
      paths: ['src/memory.ts']
    });
    expect(gotcha.ok).toBe(true);
    if (!gotcha.ok) return;
    expect(gotcha.data.sprint_id).toBe(sprintId);

    const spaceGotcha = tools.shareFinding({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->teamem',
      kind: 'gotcha',
      summary: 'Space-wide gotcha',
      paths: ['src/memory.ts'],
      scope: 'space'
    });
    expect(spaceGotcha.ok).toBe(true);
    if (!spaceGotcha.ok) return;
    expect(spaceGotcha.data.sprint_id).toBeNull();

    const snapshot = tools.exportSpaceRulesSnapshot({
      space_id: SPACE,
      principal: 'alice'
    });
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;
    const updated = tools.updateSpaceRules({
      space_id: SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->teamem',
      rules_markdown: 'Keep Space Rules global.',
      base_version: snapshot.data.metadata.rules_version,
      base_hash: snapshot.data.metadata.rules_hash
    });
    expect(updated.ok).toBe(true);
    const ruleEvent = db
      .prepare(
        `SELECT raw_json
           FROM events
          WHERE event_type = 'space_rule_added'
          ORDER BY timestamp DESC
          LIMIT 1`
      )
      .get() as { raw_json: string } | null;
    expect(JSON.parse(ruleEvent?.raw_json ?? '{}')).toMatchObject({
      sprint_id: null,
      delivery_scope: 'space'
    });
  });

  it('surfaces cross-context overlap awareness without blocking claims', () => {
    const { tools } = setup();

    const spaceClaim = claim(tools, 'alice', 'src/**/*.ts');
    expect(spaceClaim.ok).toBe(true);
    if (!spaceClaim.ok) return;

    tools.createSprint({
      space_id: SPACE,
      principal: 'bob',
      display_name: 'Briefing Sprint',
      goal: 'Briefing behavior'
    });
    const sprintClaim = claim(tools, 'bob', 'src/foo.ts');
    expect(sprintClaim.ok).toBe(true);
    if (!sprintClaim.ok) return;

    const briefing = tools.getBriefing({
      space_id: SPACE,
      principal: 'bob'
    });
    expect(briefing.ok).toBe(true);
    if (!briefing.ok) return;
    expect(
      briefing.data.meta.cross_context_overlap_awareness?.overlapping_claims
    ).toBe(1);
  });
});
