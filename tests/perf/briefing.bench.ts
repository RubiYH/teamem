import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';
import {
  createSqliteClient,
  runMigration
} from '../../src/infra/db/sqlite-client.js';
import { SqliteEventStore } from '../../src/infra/db/sqlite-event-store.js';
import { createTeamemTools } from '../../src/server/tools/index.js';
import { buildBriefing } from '../../src/server/tools/briefing.js';
import { applyProjectionUpdate } from '../../src/infra/projections/apply-event.js';

function setup() {
  const db = createSqliteClient(':memory:');
  runMigration(db, join(process.cwd(), 'src/infra/db/migrations/001_init.sql'));
  try {
    runMigration(
      db,
      join(
        process.cwd(),
        'src/infra/db/migrations/002_decisions_kind_and_indexes.sql'
      )
    );
  } catch {
    // migration 002 may already be applied in some environments
  }
  runMigration(
    db,
    join(
      process.cwd(),
      'src/infra/db/migrations/003_room_codes_and_members.sql'
    )
  );
  const store = new SqliteEventStore(db);
  const tools = createTeamemTools({ db, store });
  return { db, store, tools };
}

describe('perf: get_briefing — AC16 full (10k events + 50 claims + 20 blockers, p50 < 200ms)', () => {
  it('get_briefing p50 < 200ms with 10k events, 50 active claims, 20 open blockers', () => {
    const { db, store } = setup();

    // Seed 10k mixed events
    for (let i = 0; i < 10000; i++) {
      const eventType =
        i % 5 === 0
          ? 'decision_recorded'
          : i % 5 === 1
            ? 'task_completed'
            : i % 5 === 2
              ? 'contract_changed'
              : 'task_started';

      const event = {
        schema_version: '1.0' as const,
        event_id: `briefing-perf-${String(i).padStart(6, '0')}`,
        idempotency_key: `briefing-idem-${String(i).padStart(6, '0')}`,
        space_id: 'briefing-repo',
        timestamp: new Date(
          Date.UTC(2026, 4, 1, 0, Math.floor(i / 60), i % 60)
        ).toISOString(),
        principal: i % 3 === 0 ? 'alice' : i % 3 === 1 ? 'bob' : 'carol',
        actor: 'agent',
        delegation: 'principal->agent',
        event_type: eventType as
          | 'task_started'
          | 'task_completed'
          | 'decision_recorded'
          | 'contract_changed',
        scope: { paths: [`src/module-${i % 100}.ts`] },
        payload:
          eventType === 'decision_recorded'
            ? {
                decision_id: `dec-${i}`,
                title: `Decision ${i}`,
                summary: `Summary for decision ${i}`,
                kind: 'architectural'
              }
            : eventType === 'contract_changed'
              ? {
                  contract_key: `api/v${i % 5}`,
                  change_summary: `Change ${i}`,
                  breaking: false
                }
              : { task_id: `TASK-${i}`, what: `Working on module ${i % 100}` }
      };
      store.append(event);
      // Apply projections for non-task events to keep DB state consistent
      if (eventType !== 'task_started' && eventType !== 'task_completed') {
        try {
          applyProjectionUpdate(db, event);
        } catch {
          /* ignore projection errors */
        }
      }
    }

    // Seed 50 active scope claims
    for (let i = 0; i < 50; i++) {
      const claimEvent = {
        schema_version: '1.0' as const,
        event_id: `brief-claim-${String(i).padStart(3, '0')}`,
        idempotency_key: `brief-claim-idem-${String(i).padStart(3, '0')}`,
        space_id: 'briefing-repo',
        timestamp: new Date(Date.UTC(2026, 4, 1, 1, 0, i)).toISOString(),
        principal: i % 3 === 0 ? 'alice' : i % 3 === 1 ? 'bob' : 'carol',
        actor: 'agent',
        delegation: 'principal->agent',
        event_type: 'scope_claimed' as const,
        scope: { paths: [`src/module-${i}.ts`] },
        payload: {
          claim_id: `brief-claim-${i}`,
          intent: `edit module ${i}`,
          expires_at: '2026-05-02T00:00:00.000Z'
        }
      };
      store.append(claimEvent);
      applyProjectionUpdate(db, claimEvent);
    }

    // Seed 20 open blockers
    for (let i = 0; i < 20; i++) {
      const blockerEvent = {
        schema_version: '1.0' as const,
        event_id: `brief-blocker-${String(i).padStart(3, '0')}`,
        idempotency_key: `brief-blocker-idem-${String(i).padStart(3, '0')}`,
        space_id: 'briefing-repo',
        timestamp: new Date(Date.UTC(2026, 4, 1, 2, 0, i)).toISOString(),
        principal: i % 2 === 0 ? 'alice' : 'bob',
        actor: 'alice',
        delegation: 'alice->alice',
        event_type: 'blocker_raised' as const,
        scope: {},
        payload: {
          blocker_id: `blocker-${i}`,
          summary: `Blocker ${i}: waiting on dependency`,
          owner_principal: 'alice'
        }
      };
      store.append(blockerEvent);
      applyProjectionUpdate(db, blockerEvent);
    }

    const times: number[] = [];
    for (let run = 0; run < 11; run++) {
      const t = performance.now();
      buildBriefing(db, { space_id: 'briefing-repo', principal: 'alice' });
      times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    const p50 = times[Math.floor(times.length / 2)]!;
    expect(p50).toBeLessThan(200);
  });

  it('get_briefing with token_budget=4000 p50 < 200ms with 10k events', () => {
    const { db, store } = setup();

    for (let i = 0; i < 10000; i++) {
      store.append({
        schema_version: '1.0',
        event_id: `brief-bud-${String(i).padStart(6, '0')}`,
        idempotency_key: `brief-bud-idem-${String(i).padStart(6, '0')}`,
        space_id: 'budget-repo',
        timestamp: new Date(
          Date.UTC(2026, 4, 1, 0, Math.floor(i / 60), i % 60)
        ).toISOString(),
        principal: i % 2 === 0 ? 'alice' : 'bob',
        actor: 'agent',
        delegation: 'principal->agent',
        event_type: 'task_started' as const,
        scope: { paths: [`src/module-${i % 50}.ts`] },
        payload: { task_id: `TASK-${i}` }
      });
    }

    const times: number[] = [];
    for (let run = 0; run < 11; run++) {
      const t = performance.now();
      buildBriefing(db, {
        space_id: 'budget-repo',
        principal: 'alice',
        token_budget: 4000
      });
      times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    const p50 = times[Math.floor(times.length / 2)]!;
    expect(p50).toBeLessThan(200);
  });
});
