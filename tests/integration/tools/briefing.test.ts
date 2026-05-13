import { runAllMigrations } from '../../helpers/migrations.js';
import { describe, expect, it } from 'bun:test';
import { createSqliteClient } from '../../../src/infra/db/sqlite-client.js';
import { SqliteEventStore } from '../../../src/infra/db/sqlite-event-store.js';
import { createTeamemTools } from '../../../src/server/tools/index.js';
import { buildBriefing } from '../../../src/server/tools/briefing.js';
import { BriefingResponseSchema } from '../../../src/server/tools/briefing-schema.js';
function setup() {
  const db = createSqliteClient(':memory:');
  runAllMigrations(db);
  const store = new SqliteEventStore(db);
  const tools = createTeamemTools({ db, store });
  return { db, store, tools };
}

describe('buildBriefing — shape validation', () => {
  it('returns a valid BriefingResponse on empty repo', () => {
    const { db } = setup();
    const result = buildBriefing(db, {
      space_id: 'teamem-poc',
      principal: 'alice'
    });
    const parsed = BriefingResponseSchema.safeParse(result);
    expect(parsed.success).toBe(true);
    expect(result.current_plan).toBeNull();
    expect(result.active_claims).toHaveLength(0);
    expect(result.meta.heuristic_trust).toBe('unverified');
    // AC25: recent_joins is always present and is an array
    expect(Array.isArray(result.recent_joins)).toBe(true);
  });

  it('AC25: recent_joins surfaces top-5 active members ordered by joined_at DESC', () => {
    const { db } = setup();
    db.exec(
      `INSERT INTO spaces (id, label, creator_member_id, created_at) VALUES
        ('space-ac25', 'Test', 'm-creator', '2026-04-01T00:00:00.000Z')`
    );
    db.exec(
      `INSERT INTO members (id, space_id, name, joined_at, left_at, is_creator) VALUES
        ('m-creator', 'space-ac25', 'alice',   '2026-04-01T00:00:00.000Z', NULL, 1),
        ('m-bob',     'space-ac25', 'bob',     '2026-04-02T00:00:00.000Z', NULL, 0),
        ('m-carol',   'space-ac25', 'carol',   '2026-04-03T00:00:00.000Z', NULL, 0),
        ('m-left',    'space-ac25', 'gone',    '2026-04-04T00:00:00.000Z', '2026-04-05T00:00:00.000Z', 0)`
    );
    const result = buildBriefing(db, {
      space_id: 'space-ac25',
      principal: 'alice'
    });
    expect(Array.isArray(result.recent_joins)).toBe(true);
    expect(result.recent_joins).toHaveLength(3); // gone is filtered (left_at NOT NULL)
    expect(result.recent_joins[0]?.member_name).toBe('carol'); // newest
    expect(result.recent_joins[2]?.member_name).toBe('alice'); // oldest of active
    const aliceRow = result.recent_joins.find((j) => j.member_name === 'alice');
    expect(aliceRow?.is_creator).toBe(true);
  });

  it('current_plan reflects most recent plan-kind decision', () => {
    const { db, tools } = setup();

    tools.recordDecision({
      space_id: 'teamem-poc',
      principal: 'alice',
      actor: 'alice/agent',
      delegation: 'alice->agent',
      decision_id: 'dec-plan-1',
      title: 'Phase 1 plan',
      summary: 'Build the server first.',
      kind: 'plan'
    });

    const result = buildBriefing(db, {
      space_id: 'teamem-poc',
      principal: 'alice'
    });
    expect(result.current_plan).not.toBeNull();
    expect(result.current_plan?.title).toBe('Phase 1 plan');
    expect(result.current_plan?.summary).toBe('Build the server first.');
    expect(result.recent_decisions[0]?.version).toBe(1);
    expect(result.recent_decisions[0]?.latest_event_type).toBe(
      'decision_published'
    );
  });

  it('supersession: second plan-kind decision supersedes the first', () => {
    const { db, tools } = setup();

    tools.recordDecision({
      space_id: 'teamem-poc',
      principal: 'alice',
      actor: 'alice/agent',
      delegation: 'alice->agent',
      decision_id: 'dec-plan-1',
      title: 'Old plan',
      summary: 'Original.',
      kind: 'plan'
    });

    tools.recordDecision({
      space_id: 'teamem-poc',
      principal: 'alice',
      actor: 'alice/agent',
      delegation: 'alice->agent',
      decision_id: 'dec-plan-2',
      title: 'New plan',
      summary: 'Revised.',
      kind: 'plan'
    });

    const result = buildBriefing(db, {
      space_id: 'teamem-poc',
      principal: 'alice'
    });
    // Only the new plan should be current
    expect(result.current_plan?.title).toBe('New plan');
    // Old plan should be in recent_decisions with status=superseded
    const old = result.recent_decisions.find((d) => d.id === 'dec-plan-1');
    expect(old?.status).toBe('superseded');
    expect(old?.latest_event_type).toBe('decision_superseded');
    expect(old?.superseded_by_decision_id).toBe('dec-plan-2');
  });

  it('active_claims returns active scope claims', () => {
    const { db, tools } = setup();

    tools.claimScope({
      space_id: 'teamem-poc',
      principal: 'alice',
      actor: 'alice/agent',
      delegation: 'alice->agent',
      scope: { paths: ['src/api/user.ts'] },
      intent: 'implement user endpoint'
    });

    const result = buildBriefing(db, {
      space_id: 'teamem-poc',
      principal: 'alice'
    });
    expect(result.active_claims).toHaveLength(1);
    expect(result.active_claims[0]?.principal).toBe('alice');
  });

  it('meta.token_estimate is a positive integer', () => {
    const { db } = setup();
    const result = buildBriefing(db, {
      space_id: 'teamem-poc',
      principal: 'alice'
    });
    expect(result.meta.token_estimate).toBeGreaterThan(0);
    expect(Number.isInteger(result.meta.token_estimate)).toBe(true);
  });

  it('token_budget truncation: drops oldest recent_progress first', () => {
    const { db, tools } = setup();

    // Add many task_started events
    for (let i = 0; i < 20; i++) {
      tools.publishEvent({
        schema_version: '1.0',
        event_id: `evt-task-${i}`,
        idempotency_key: `idem-task-${i}`,
        space_id: 'teamem-poc',
        timestamp: `2026-05-01T${String(i).padStart(2, '0')}:00:00.000Z`,
        principal: 'alice',
        actor: 'alice/agent',
        delegation: 'alice->agent',
        event_type: 'task_started',
        scope: { paths: [`src/module-${i}.ts`] },
        payload: { task_id: `TASK-${i}`, what: `working on module ${i}` }
      });
    }

    // Very small budget forces truncation
    const result = buildBriefing(db, {
      space_id: 'teamem-poc',
      principal: 'alice',
      token_budget: 100
    });

    // Response is still valid shape
    const parsed = BriefingResponseSchema.safeParse(result);
    expect(parsed.success).toBe(true);
    // recent_progress should be truncated
    expect(result.recent_progress.length).toBeLessThan(20);
  });
});

describe('buildBriefing — AC17 truncation policy at budget tiers', () => {
  function seedProgressEvents(
    tools: ReturnType<
      typeof import('../../../src/server/tools/index.js').createTeamemTools
    >,
    count: number
  ) {
    // Issue #15 — recent_progress is now sourced from `agent_focus_changed`
    // events. Previous task_started/task_completed seeding is legacy. Each
    // distinct path bucket produces a fresh focus row; bypass_dedup keeps
    // the bucket count from collapsing under the 60s window.
    for (let i = 0; i < count; i++) {
      tools.agentFocusChanged({
        space_id: 'trunc-repo',
        principal: 'alice',
        actor: 'alice/agent',
        delegation: 'alice->agent',
        scope: { paths: [`src/module-${i}.ts`] },
        intent: `working on module ${i} with some extra description text to increase token size`,
        bypass_dedup: true
      });
    }
  }

  it('1k token_budget: response fits within budget or marks over_budget', () => {
    const { db, tools } = setup();
    seedProgressEvents(tools, 50);

    const result = buildBriefing(db, {
      space_id: 'trunc-repo',
      principal: 'alice',
      token_budget: 1000
    });
    const parsed = BriefingResponseSchema.safeParse(result);
    expect(parsed.success).toBe(true);
    if (!result.meta.over_budget) {
      expect(result.meta.token_estimate).toBeLessThanOrEqual(1000);
    }
  });

  it('4k token_budget: response fits within budget or marks over_budget', () => {
    const { db, tools } = setup();
    seedProgressEvents(tools, 100);

    const result = buildBriefing(db, {
      space_id: 'trunc-repo',
      principal: 'alice',
      token_budget: 4000
    });
    const parsed = BriefingResponseSchema.safeParse(result);
    expect(parsed.success).toBe(true);
    if (!result.meta.over_budget) {
      expect(result.meta.token_estimate).toBeLessThanOrEqual(4000);
    }
  });

  it('16k token_budget: response includes all events when data is small enough', () => {
    const { db, tools } = setup();
    seedProgressEvents(tools, 20);

    const result = buildBriefing(db, {
      space_id: 'trunc-repo',
      principal: 'alice',
      token_budget: 16000
    });
    const parsed = BriefingResponseSchema.safeParse(result);
    expect(parsed.success).toBe(true);
    expect(result.meta.over_budget).toBeUndefined();
    expect(result.recent_progress.length).toBeGreaterThan(0);
  });

  it('truncation drops oldest recent_progress first (progress items ordered newest first)', () => {
    const { db, tools } = setup();
    seedProgressEvents(tools, 20);

    const fullResult = buildBriefing(db, {
      space_id: 'trunc-repo',
      principal: 'alice',
      token_budget: 16000
    });
    const truncResult = buildBriefing(db, {
      space_id: 'trunc-repo',
      principal: 'alice',
      token_budget: 500
    });

    if (
      fullResult.recent_progress.length > 0 &&
      !truncResult.meta.over_budget &&
      truncResult.recent_progress.length > 0
    ) {
      // The truncated result's items should be a prefix (newest) of the full result
      const newestTimestamp = fullResult.recent_progress[0]?.at;
      const truncNewest = truncResult.recent_progress[0]?.at;
      expect(truncNewest).toBe(newestTimestamp);
    }
  });
});

describe('buildBriefing — AC16 full perf gate (10k events, p50 < 200ms)', () => {
  it('get_briefing p50 < 200ms over 10k events', () => {
    const { db, store } = setup();

    for (let i = 0; i < 10000; i++) {
      store.append({
        schema_version: '1.0',
        event_id: `ac16-evt-${String(i).padStart(6, '0')}`,
        idempotency_key: `ac16-idem-${String(i).padStart(6, '0')}`,
        space_id: 'perf-repo-10k',
        timestamp: new Date(Date.UTC(2026, 4, 1, 0, 0, i % 3600)).toISOString(),
        principal: i % 3 === 0 ? 'alice' : i % 3 === 1 ? 'bob' : 'carol',
        actor: 'agent',
        delegation: 'principal->agent',
        event_type: 'task_started' as const,
        scope: { paths: [`src/module-${i % 100}.ts`] },
        payload: { task_id: `TASK-${i}` }
      });
    }

    const times: number[] = [];
    for (let run = 0; run < 11; run++) {
      const t = performance.now();
      buildBriefing(db, { space_id: 'perf-repo-10k', principal: 'alice' });
      times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    const p50 = times[Math.floor(times.length / 2)]!;
    expect(p50).toBeLessThan(200);
  });
});

describe('buildBriefing — performance smoke (1k events, p50 < 100ms)', () => {
  it('get_briefing p50 < 100ms over 1k events', () => {
    const { db, store } = setup();

    // Synthesize 1000 events directly into the store
    for (let i = 0; i < 1000; i++) {
      const event = {
        schema_version: '1.0' as const,
        event_id: `perf-evt-${String(i).padStart(5, '0')}`,
        idempotency_key: `perf-idem-${String(i).padStart(5, '0')}`,
        space_id: 'perf-repo',
        timestamp: new Date(Date.UTC(2026, 4, 1, 0, 0, i)).toISOString(),
        principal: i % 2 === 0 ? 'alice' : 'bob',
        actor: 'agent',
        delegation: 'principal->agent',
        event_type: 'task_started' as const,
        scope: { paths: [`src/module-${i % 50}.ts`] },
        payload: { task_id: `TASK-${i}` }
      };
      store.append(event);
    }

    const times: number[] = [];
    for (let run = 0; run < 11; run++) {
      const t = performance.now();
      buildBriefing(db, { space_id: 'perf-repo', principal: 'alice' });
      times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    const p50 = times[Math.floor(times.length / 2)]!;
    expect(p50).toBeLessThan(100);
  });

  it('getUpdates p50 < 50ms over 1k events', () => {
    const { store, tools } = setup();

    for (let i = 0; i < 1000; i++) {
      store.append({
        schema_version: '1.0',
        event_id: `gu-evt-${String(i).padStart(5, '0')}`,
        idempotency_key: `gu-idem-${String(i).padStart(5, '0')}`,
        space_id: 'perf-repo2',
        timestamp: new Date(Date.UTC(2026, 4, 1, 0, 0, i)).toISOString(),
        principal: 'alice',
        actor: 'agent',
        delegation: 'alice->agent',
        event_type: 'task_started',
        scope: {},
        payload: { task_id: `T-${i}` }
      });
    }

    const times: number[] = [];
    for (let run = 0; run < 11; run++) {
      const t = performance.now();
      tools.getUpdates({ space_id: 'perf-repo2', limit: 100 });
      times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    const p50 = times[Math.floor(times.length / 2)]!;
    expect(p50).toBeLessThan(50);
  });
});
