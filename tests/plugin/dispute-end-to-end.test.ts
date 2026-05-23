/**
 * Deferred-runtime regression — dispute events are still emitted with the
 * expected server shape, but the current plugin build MUST NOT wire any
 * watcher/negotiator Notification agents. The classification must use the
 * actual server emission shape.
 *
 * Pre-#22 the Notification hook routed `teamem.peer_event` exclusively to
 * `teamem-watcher` (read-only). Pre-#23 the monitor classifier looked
 * for a `dispute_move_posted` event type that no server code emits —
 * the real move emission is a `discussion_posted` event with
 * `payload.dispute_move` set per slice #12. F21 caught the gap with a
 * production-path test (this file).
 *
 * Coverage in this file:
 *   1. Static — `plugin/hooks/hooks.json` has no Notification agent routes.
 *   2. Pure-function unit test of the monitor's classifier with
 *      synthetic inputs (acceptable per F21 process note: the function
 *      under test is itself, not its routing).
 *   3. **Production-path test (F21).** Drives the real server tools to
 *      open a dispute and post a move, captures the bridge's
 *      `get_updates` response, and asserts the monitor classifies the
 *      resulting `discussion_posted`-with-`dispute_move`-payload event
 *      as `teamem.dispute_event`.
 *
 * Bun unit tests don't have access to the Claude Code harness. The
 * monitor's emission of `teamem.dispute_event` remains the closest
 * verifiable boundary, and the static hooks.json assertion proves the
 * plugin no longer wires an agent to consume it.
 */
import { describe, expect, it } from 'bun:test';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  chmodSync,
  copyFileSync,
  existsSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { marketplaceEnv } from '../helpers/marketplace-env.js';
import { runAllMigrations } from '../helpers/migrations.js';
import { createSqliteClient } from '../../src/infra/db/sqlite-client.js';
import { SqliteEventStore } from '../../src/infra/db/sqlite-event-store.js';
import { createTeamemTools } from '../../src/server/tools/index.js';

const REPO_ROOT = resolve(import.meta.dir, '../..');

describe('deferred dispute runtime boundaries', () => {
  it('plugin/hooks/hooks.json has no Notification agent routes', () => {
    const hooks = JSON.parse(
      readFileSync(join(REPO_ROOT, 'plugin/hooks/hooks.json'), 'utf-8')
    ) as {
      hooks: {
        Notification?: Array<{
          matcher: string;
          hooks: Array<{ type: string; prompt?: string; command?: string }>;
        }>;
      };
    };
    const notif = hooks.hooks.Notification ?? [];
    expect(notif).toEqual([]);
  });

  it('the bundled bridge.js contains the teamem.whoami binding (F18 dependency)', () => {
    const bridgePath = join(REPO_ROOT, 'plugin/lib/bridge.js');
    expect(existsSync(bridgePath)).toBe(true);
    const bundle = readFileSync(bridgePath, 'utf-8');
    expect(bundle).toContain('teamem.whoami');
  });

  /**
   * Production-path test — drives real `tools.openDispute` and
   * `tools.disputePostMove`, captures the resulting events via
   * `tools.getUpdates`, and asserts the monitor's classifier returns
   * `teamem.dispute_event` for the move event (a `discussion_posted`
   * with `payload.dispute_move`). NO event-type stubbing.
   *
   * This catches F21: the #22 monitor classifier looked for a
   * `dispute_move_posted` event_type that the server never emits.
   */
  it('F21 production path: real disputePostMove emits a `discussion_posted` event with `payload.dispute_move`; monitor classifies it as teamem.dispute_event', async () => {
    const work = mkdtempSync(join(tmpdir(), 'teamem-f21-prod-'));
    const SPACE = 'space-f21';

    try {
      // Set up an in-memory server: db + store + tools. Mirrors the
      // pattern used by `tests/integration/tools/disputes.test.ts`.
      const db = createSqliteClient(':memory:');
      runAllMigrations(db);
      const store = new SqliteEventStore(db);
      const tools = createTeamemTools({ db, store });

      // Seed the space + two members with auto-discuss prefs so disputes
      // are valid.
      db.exec(
        `INSERT INTO spaces (id, label, creator_member_id, created_at)
           VALUES ('${SPACE}', 'test', 'm-alice', '2026-04-01T00:00:00.000Z');
         INSERT INTO members (id, space_id, name, joined_at, is_creator, coord_pref)
           VALUES ('m-alice', '${SPACE}', 'alice', '2026-04-01T00:00:00.000Z', 1, 'auto-discuss'),
                  ('m-bob',   '${SPACE}', 'bob',   '2026-04-02T00:00:00.000Z', 0, 'auto-discuss');`
      );

      // 1. Alice claims the contested scope.
      const claim = tools.claimScope({
        space_id: SPACE,
        principal: 'alice',
        actor: 'alice',
        delegation: 'alice->alice',
        scope: { paths: ['src/auth/login.ts', 'src/auth/middleware.ts'] }
      });
      expect(claim.ok).toBe(true);
      if (!claim.ok) throw new Error('claim_scope failed');

      // 2. Bob opens a dispute on a subset.
      const opened = tools.openDispute({
        space_id: SPACE,
        principal: 'bob',
        actor: 'bob',
        delegation: 'bob->bob',
        blocking_claim_id: claim.data.claim_id,
        paths: ['src/auth/login.ts'],
        intent: 'F21 production-path test'
      });
      expect(opened.ok).toBe(true);
      if (!opened.ok) throw new Error('open_dispute failed');

      // 3. Bob posts a real move via the production code path. This is
      //    the call whose emission shape F21 caught — it MUST emit a
      //    `discussion_posted` event with `payload.dispute_move`.
      const move = tools.disputePostMove({
        space_id: SPACE,
        principal: 'bob',
        actor: 'bob',
        delegation: 'bob->bob',
        thread_id: opened.data.thread_id,
        move_type: 'propose_release_subset',
        payload: { paths: ['src/auth/login.ts'] }
      });
      expect(move.ok).toBe(true);
      if (!move.ok) throw new Error('dispute_post_move failed');

      // 4. Read events back via `tools.getUpdates` — same path the
      //    bridge serves to the monitor.
      const updates = tools.getUpdates({
        space_id: SPACE,
        actor: 'alice'
      });
      expect(updates.ok).toBe(true);
      if (!updates.ok) throw new Error('get_updates failed');

      const events = updates.data.events;
      // Confirm the production code emits the shape F21 expected:
      //   - exactly one `dispute_opened` event (for the open).
      //   - at least one `discussion_posted` event whose
      //     `payload.dispute_move` is set (for the real move).
      const disputeOpened = events.filter(
        (e) => e.event_type === 'dispute_opened'
      );
      expect(disputeOpened.length).toBe(1);

      const movePostedEvents = events.filter(
        (e) =>
          e.event_type === 'discussion_posted' &&
          e.payload != null &&
          typeof e.payload === 'object' &&
          (e.payload as Record<string, unknown>).dispute_move != null
      );
      expect(movePostedEvents.length).toBeGreaterThanOrEqual(1);

      // Critical for F21: the server did NOT emit a `dispute_move_posted`
      // event. Pre-#23 the monitor classifier was looking for this
      // type; the test now asserts the type doesn't exist in the wire
      // shape. (This is the "stub vs production" gap that F21 caught.)
      const synthetic = events.filter(
        (e) => (e.event_type as string) === 'dispute_move_posted'
      );
      expect(synthetic.length).toBe(0);

      // 5. Stage a fake plugin install whose stub bridge returns these
      //    REAL events to the monitor. Run the monitor for one poll
      //    cycle and confirm the classifier emits
      //    `teamem.dispute_event` for the move event.
      mkdirSync(join(work, 'plugin/bin'), { recursive: true });
      mkdirSync(join(work, 'plugin/lib'), { recursive: true });
      copyFileSync(
        join(REPO_ROOT, 'plugin/bin/teamem-monitor'),
        join(work, 'plugin/bin/teamem-monitor')
      );
      chmodSync(join(work, 'plugin/bin/teamem-monitor'), 0o755);

      // The "stub" here is a thin pass-through: the bridge subprocess
      // emits the SAME events the production server just produced. No
      // synthetic shape-shifting — the only stubbed surface is the
      // network transport, not the event content.
      const eventsForMonitor = events.map((e) => ({
        event_id: e.event_id,
        event_type: e.event_type,
        principal: e.principal,
        scope: e.scope,
        payload: e.payload
      }));
      writeFileSync(
        join(work, 'plugin/lib/bridge.js'),
        `#!/usr/bin/env bun
process.stdout.write(JSON.stringify({
  ok: true,
  data: { events: ${JSON.stringify(eventsForMonitor)} }
}));
process.exit(0);
`,
        { mode: 0o755 }
      );

      const sessionId = 'sess-f21-prod';
      const sessionDir = join(work, 'plugin-data/sessions', sessionId);
      mkdirSync(sessionDir, {
        recursive: true
      });
      writeFileSync(join(sessionDir, 'active'), new Date().toISOString());

      // No credentials → myPrincipal stays empty → both events surface
      // (no self-filter). HOME points at the empty workdir to avoid
      // accidentally reading the dev's real ~/.teamem/credentials.json.
      const env = marketplaceEnv({
        CLAUDE_PLUGIN_ROOT: join(work, 'plugin'),
        CLAUDE_PLUGIN_DATA: join(work, 'plugin-data'),
        CLAUDE_SESSION_ID: sessionId,
        HOME: work,
        TEAMEM_MONITOR_POLL_MS: '500'
      });

      const child = spawn(
        'bun',
        ['run', join(work, 'plugin/bin/teamem-monitor')],
        { env: env as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'] }
      );
      let stdout = '';
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
      const exitPromise = new Promise<void>((resolveFn) =>
        child.on('close', () => resolveFn())
      );

      const moveEventId = movePostedEvents[0]!.event_id;
      const openEventId = disputeOpened[0]!.event_id;

      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        if (
          stdout.includes(`"event_id":"${moveEventId}"`) &&
          stdout.includes(`"event_id":"${openEventId}"`)
        ) {
          break;
        }
        Bun.sleepSync(100);
      }
      Bun.sleepSync(300);
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      await Promise.race([
        exitPromise,
        new Promise<void>((resolveFn) => setTimeout(resolveFn, 500))
      ]).catch(() => {});

      const lines = stdout
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l) as {
              name: string;
              event_id: string;
              event_type: string;
            };
          } catch {
            return null;
          }
        })
        .filter(
          (x): x is { name: string; event_id: string; event_type: string } =>
            x !== null
        );

      // The dispute_opened event must be on the dispute-event channel.
      const openLine = lines.find((l) => l.event_id === openEventId);
      expect(openLine).toBeDefined();
      expect(openLine!.name).toBe('teamem.dispute_event');
      expect(openLine!.event_type).toBe('dispute_opened');

      // F21: the move event (`discussion_posted` with `payload.dispute_move`)
      // MUST also be on the dispute-event channel, NOT peer_event.
      const moveLine = lines.find((l) => l.event_id === moveEventId);
      expect(moveLine).toBeDefined();
      expect(moveLine!.event_type).toBe('discussion_posted');
      expect(moveLine!.name).toBe('teamem.dispute_event');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 30_000);

  /**
   * Pure-function unit coverage of the monitor's classifier. Exhaustive
   * across the four shapes the production wire format produces:
   *   - `dispute_opened`                 → dispute_event
   *   - `discussion_posted` w/ dispute_move payload → dispute_event
   *   - `discussion_posted` w/o dispute_move payload → peer_event
   *   - any other event type            → peer_event
   *
   * Re-derives the classifier inline because the monitor file is a Bun
   * script (not a module) — keeping the classifier function shape in
   * sync between the script and this test is the contract the F21 fix
   * locks down.
   */
  function classifyNotificationName(ev: {
    event_type: string;
    payload?: Record<string, unknown>;
  }): string {
    if (ev.event_type === 'dispute_opened') return 'teamem.dispute_event';
    if (
      ev.event_type === 'discussion_posted' &&
      ev.payload != null &&
      typeof ev.payload === 'object' &&
      ev.payload.dispute_move != null
    ) {
      return 'teamem.dispute_event';
    }
    return 'teamem.peer_event';
  }

  it('classifier: dispute_opened → teamem.dispute_event', () => {
    expect(
      classifyNotificationName({ event_type: 'dispute_opened', payload: {} })
    ).toBe('teamem.dispute_event');
  });
  it('classifier: discussion_posted with dispute_move → teamem.dispute_event', () => {
    expect(
      classifyNotificationName({
        event_type: 'discussion_posted',
        payload: { dispute_move: { move_type: 'propose_release_subset' } }
      })
    ).toBe('teamem.dispute_event');
  });
  it('classifier: discussion_posted without dispute_move → teamem.peer_event', () => {
    expect(
      classifyNotificationName({
        event_type: 'discussion_posted',
        payload: { body: 'hello world' }
      })
    ).toBe('teamem.peer_event');
  });
  it('classifier: scope_claimed → teamem.peer_event', () => {
    expect(
      classifyNotificationName({ event_type: 'scope_claimed', payload: {} })
    ).toBe('teamem.peer_event');
  });
  it('classifier: undefined payload still classifies safely', () => {
    expect(classifyNotificationName({ event_type: 'discussion_posted' })).toBe(
      'teamem.peer_event'
    );
    expect(classifyNotificationName({ event_type: 'dispute_opened' })).toBe(
      'teamem.dispute_event'
    );
  });
});
