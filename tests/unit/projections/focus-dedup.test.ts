import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyProjectionUpdate } from '../../../src/infra/projections/apply-event.js';
import {
  canonicalScopePaths,
  computeScopeHash
} from '../../../src/domain/focus/scope-hash.js';
import { loadRecentFocus } from '../../../src/domain/focus/index.js';
import type { TeamemEvent } from '../../../src/domain/events/types.js';

// Issue #15 — focus projection unit tests. Drives `applyProjectionUpdate`
// directly with `agent_focus_changed` events and asserts the dedup
// projection collapses same-scope events within 60s but bypass_dedup
// forces a fresh row.

function buildDb(): Database {
  const db = new Database(':memory:');
  const migDir = join(process.cwd(), 'src/infra/db/migrations');
  const files = readdirSync(migDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const f of files) {
    db.exec(readFileSync(join(migDir, f), 'utf-8'));
  }
  return db;
}

function seedSpace(db: Database, spaceId = 'sp-test'): void {
  db.prepare(
    `INSERT INTO spaces (id, label, creator_member_id) VALUES (?1, 'test', 'm-1')`
  ).run(spaceId);
}

function buildFocusEvent(opts: {
  event_id: string;
  focus_id: string;
  principal: string;
  paths: string[];
  timestamp: string;
  bypass_dedup?: boolean;
  intent?: string;
}): TeamemEvent {
  const canonical = canonicalScopePaths(opts.paths);
  return {
    schema_version: '1.0',
    event_id: opts.event_id,
    idempotency_key: `idem-${opts.event_id}`,
    space_id: 'sp-test',
    timestamp: opts.timestamp,
    principal: opts.principal,
    actor: opts.principal,
    delegation: `${opts.principal}->agent`,
    event_type: 'agent_focus_changed',
    scope: { paths: canonical },
    payload: {
      focus_id: opts.focus_id,
      scope_hash: computeScopeHash(canonical),
      intent: opts.intent ?? '',
      bypass_dedup: opts.bypass_dedup === true
    }
  };
}

function focusCount(db: Database): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM focus').get() as { c: number })
    .c;
}

describe('agent_focus_changed projection — same-scope collapse', () => {
  it('rapid same-scope events within 60s leave one focus row', () => {
    const db = buildDb();
    seedSpace(db);

    const t0 = '2026-05-03T10:00:00.000Z';
    const t1 = '2026-05-03T10:00:30.000Z'; // +30s
    const t2 = '2026-05-03T10:00:59.000Z'; // +59s

    applyProjectionUpdate(
      db,
      buildFocusEvent({
        event_id: 'e1',
        focus_id: 'f1',
        principal: 'alice',
        paths: ['src/auth/login.ts'],
        timestamp: t0
      })
    );
    applyProjectionUpdate(
      db,
      buildFocusEvent({
        event_id: 'e2',
        focus_id: 'f2',
        principal: 'alice',
        paths: ['src/auth/login.ts'],
        timestamp: t1
      })
    );
    applyProjectionUpdate(
      db,
      buildFocusEvent({
        event_id: 'e3',
        focus_id: 'f3',
        principal: 'alice',
        paths: ['src/auth/login.ts'],
        timestamp: t2
      })
    );

    expect(focusCount(db)).toBe(1);
    const row = db
      .prepare('SELECT focus_id, started_at FROM focus LIMIT 1')
      .get() as { focus_id: string; started_at: string };
    // First event won; subsequent in-window same-scope ones deduped.
    expect(row.focus_id).toBe('f1');
    expect(row.started_at).toBe(t0);
  });

  it('beyond 60s window, a same-scope event creates a fresh row', () => {
    const db = buildDb();
    seedSpace(db);

    applyProjectionUpdate(
      db,
      buildFocusEvent({
        event_id: 'e1',
        focus_id: 'f1',
        principal: 'alice',
        paths: ['src/auth/login.ts'],
        timestamp: '2026-05-03T10:00:00.000Z'
      })
    );
    applyProjectionUpdate(
      db,
      buildFocusEvent({
        event_id: 'e2',
        focus_id: 'f2',
        principal: 'alice',
        paths: ['src/auth/login.ts'],
        timestamp: '2026-05-03T10:01:01.000Z' // +61s
      })
    );

    expect(focusCount(db)).toBe(2);
  });
});

describe('agent_focus_changed projection — different-scope creates new row', () => {
  it('a different scope produces a new focus row even within 60s', () => {
    const db = buildDb();
    seedSpace(db);

    applyProjectionUpdate(
      db,
      buildFocusEvent({
        event_id: 'e1',
        focus_id: 'f1',
        principal: 'alice',
        paths: ['src/auth/login.ts'],
        timestamp: '2026-05-03T10:00:00.000Z'
      })
    );
    applyProjectionUpdate(
      db,
      buildFocusEvent({
        event_id: 'e2',
        focus_id: 'f2',
        principal: 'alice',
        paths: ['src/auth/session.ts'],
        timestamp: '2026-05-03T10:00:10.000Z'
      })
    );
    applyProjectionUpdate(
      db,
      buildFocusEvent({
        event_id: 'e3',
        focus_id: 'f3',
        principal: 'alice',
        paths: ['src/auth/login.ts'], // back to login — same hash as e1, still in 60s
        timestamp: '2026-05-03T10:00:20.000Z'
      })
    );

    // Per CONTEXT spec example: login → session → login dedupes the third
    // claim against the first if same scope_hash within window.
    expect(focusCount(db)).toBe(2);
    const ids = (
      db
        .prepare('SELECT focus_id FROM focus ORDER BY started_at')
        .all() as Array<{ focus_id: string }>
    ).map((r) => r.focus_id);
    expect(ids).toEqual(['f1', 'f2']);
  });

  it('different principal does not collide with another principal`s focus', () => {
    const db = buildDb();
    seedSpace(db);

    applyProjectionUpdate(
      db,
      buildFocusEvent({
        event_id: 'e1',
        focus_id: 'f-alice',
        principal: 'alice',
        paths: ['src/x.ts'],
        timestamp: '2026-05-03T10:00:00.000Z'
      })
    );
    applyProjectionUpdate(
      db,
      buildFocusEvent({
        event_id: 'e2',
        focus_id: 'f-bob',
        principal: 'bob',
        paths: ['src/x.ts'], // same hash, different principal
        timestamp: '2026-05-03T10:00:10.000Z'
      })
    );

    expect(focusCount(db)).toBe(2);
  });
});

describe('agent_focus_changed projection — bypass_dedup', () => {
  it('bypass_dedup: true forces a fresh row even within the 60s window', () => {
    const db = buildDb();
    seedSpace(db);

    applyProjectionUpdate(
      db,
      buildFocusEvent({
        event_id: 'e1',
        focus_id: 'f1',
        principal: 'alice',
        paths: ['src/auth/login.ts'],
        timestamp: '2026-05-03T10:00:00.000Z'
      })
    );
    applyProjectionUpdate(
      db,
      buildFocusEvent({
        event_id: 'e2',
        focus_id: 'f2',
        principal: 'alice',
        paths: ['src/auth/login.ts'],
        timestamp: '2026-05-03T10:00:30.000Z',
        bypass_dedup: true
      })
    );

    expect(focusCount(db)).toBe(2);
    const ids = (
      db
        .prepare('SELECT focus_id FROM focus ORDER BY started_at')
        .all() as Array<{ focus_id: string }>
    ).map((r) => r.focus_id);
    expect(ids).toEqual(['f1', 'f2']);
  });
});

describe('loadRecentFocus — dedup-by-scope-hash on read side', () => {
  it('returns most-recent row per (principal, scope_hash)', () => {
    const db = buildDb();
    seedSpace(db);

    // Three rows: alice on login at t0, alice on login at t+90s (outside
    // 60s window so two rows persist), bob on login at t+30s.
    applyProjectionUpdate(
      db,
      buildFocusEvent({
        event_id: 'e1',
        focus_id: 'f1',
        principal: 'alice',
        paths: ['src/auth/login.ts'],
        timestamp: '2026-05-03T10:00:00.000Z'
      })
    );
    applyProjectionUpdate(
      db,
      buildFocusEvent({
        event_id: 'e2',
        focus_id: 'f2',
        principal: 'alice',
        paths: ['src/auth/login.ts'],
        timestamp: '2026-05-03T10:01:30.000Z' // outside 60s — second row
      })
    );
    applyProjectionUpdate(
      db,
      buildFocusEvent({
        event_id: 'e3',
        focus_id: 'f3',
        principal: 'bob',
        paths: ['src/auth/login.ts'],
        timestamp: '2026-05-03T10:00:30.000Z'
      })
    );

    const recent = loadRecentFocus(db, 'sp-test', 10);
    // Alice: f2 wins over f1 (most-recent same scope_hash). Bob: f3.
    const byPrincipal = new Map(recent.map((r) => [r.principal, r.focus_id]));
    expect(byPrincipal.get('alice')).toBe('f2');
    expect(byPrincipal.get('bob')).toBe('f3');
    expect(recent.length).toBe(2);
  });
});

describe('computeScopeHash', () => {
  it('is order-independent', () => {
    const a = computeScopeHash(['b.ts', 'a.ts', 'c.ts']);
    const b = computeScopeHash(['c.ts', 'a.ts', 'b.ts']);
    expect(a).toBe(b);
  });

  it('is duplicate-insensitive', () => {
    const a = computeScopeHash(['a.ts', 'a.ts', 'b.ts']);
    const b = computeScopeHash(['a.ts', 'b.ts']);
    expect(a).toBe(b);
  });

  it('produces distinct hashes for distinct path sets', () => {
    const a = computeScopeHash(['a.ts']);
    const b = computeScopeHash(['b.ts']);
    expect(a).not.toBe(b);
  });

  it('handles empty/undefined scope deterministically', () => {
    const a = computeScopeHash([]);
    const b = computeScopeHash(undefined);
    expect(a).toBe(b);
  });
});
