import type { Database } from 'bun:sqlite';
import { findOverlaps } from './path-match.js';

/**
 * Pending-edit projection helpers (issue #10, Mode 6.A).
 *
 * The `pending_edits` table is populated by `teamem.queue_pending_edit` and
 * drained by:
 *   - resolve-on-release: when a `scope_released` event fires for a claim,
 *     `findResolvableByRelease` returns every pending row whose
 *     `blocking_claim_id` matches OR whose paths overlap the released
 *     scope. Caller marks each row resolved and emits `conflict_resolved`.
 *   - resolve-on-expiry: when a claim's `expires_at` falls behind wall
 *     clock, the same projection logic fires (server-side sweep).
 *   - GC: rows whose `expires_at` has passed and that are still unresolved
 *     are deleted by `gcExpiredPendingEdits`.
 *
 * All functions here are sync and do not commit or rollback their own
 * transactions; callers wrap them in the appropriate tx context.
 */

export type PendingEditRow = {
  pending_id: string;
  space_id: string;
  blocked_principal: string;
  blocking_claim_id: string;
  sprint_id: string | null;
  paths: string[];
  intent: string | null;
  created_at: string;
  expires_at: string;
  resolved_at: string | null;
  source_event_id: string;
};

type RawPendingRow = Omit<PendingEditRow, 'paths'> & { paths_json: string };

function decodeRow(row: RawPendingRow): PendingEditRow {
  let paths: string[] = [];
  try {
    const parsed = JSON.parse(row.paths_json) as unknown;
    if (Array.isArray(parsed)) {
      paths = parsed.filter((p): p is string => typeof p === 'string');
    }
  } catch {
    // malformed paths_json — surface empty so caller doesn't blow up;
    // the row is still resolvable by blocking_claim_id match.
  }
  const { paths_json: _ignored, ...rest } = row;
  void _ignored;
  return { ...rest, paths };
}

/**
 * Resolve-on-release query. Returns every active pending row in `space_id`
 * whose `blocking_claim_id` matches the released claim OR whose `paths`
 * overlap any of `released_paths` under the path-match engine. Excludes
 * already-resolved and tombstoned rows.
 */
export function findResolvableByRelease(
  db: Database,
  space_id: string,
  released_claim_id: string,
  released_paths: readonly string[],
  released_sprint_id: string | null = null
): PendingEditRow[] {
  const rows = db
    .prepare(
      `SELECT pending_id, space_id, blocked_principal, blocking_claim_id,
              sprint_id, paths_json, intent, created_at, expires_at, resolved_at, source_event_id
         FROM pending_edits
        WHERE space_id = ?1
          AND resolved_at IS NULL
          AND tombstoned_at IS NULL
          AND ${
            released_sprint_id === null ? 'sprint_id IS NULL' : 'sprint_id = ?2'
          }`
    )
    .all(
      ...(released_sprint_id === null
        ? [space_id]
        : [space_id, released_sprint_id])
    ) as RawPendingRow[];

  const decoded = rows.map(decodeRow);
  // Coerce to a writable copy once — `findOverlaps` predates the readonly
  // hardening on this module; copying is O(n) and far cheaper than the
  // overlap loop itself.
  const releasedCopy: string[] | null =
    released_paths.length > 0 ? released_paths.slice() : null;

  return decoded.filter((r) => {
    if (r.blocking_claim_id === released_claim_id) return true;
    if (releasedCopy === null) return false;
    if (r.paths.length === 0) return false;
    return findOverlaps(r.paths, releasedCopy).length > 0;
  });
}

/**
 * Marks a pending row resolved. Does NOT emit the `conflict_resolved` event;
 * caller is responsible for appending the event in the same tx so the
 * audit trail and the projection state stay aligned.
 */
export function markPendingResolved(
  db: Database,
  pending_id: string,
  resolved_at: string
): void {
  db.prepare(
    `UPDATE pending_edits
        SET resolved_at = ?1
      WHERE pending_id = ?2
        AND resolved_at IS NULL`
  ).run(resolved_at, pending_id);
}

/**
 * GC sweep. Removes pending rows whose `expires_at` has passed and that
 * have not been resolved. Returns the number of rows removed.
 *
 * Tombstoned rows are left alone — soft-wipe owns their lifecycle. Resolved
 * rows are kept for audit; a separate retention policy may prune them later.
 */
export function gcExpiredPendingEdits(db: Database, now_iso: string): number {
  const result = db
    .prepare(
      `DELETE FROM pending_edits
        WHERE expires_at < ?1
          AND resolved_at IS NULL
          AND tombstoned_at IS NULL`
    )
    .run(now_iso);
  return Number(result.changes ?? 0);
}

/**
 * Briefing helper — returns blocked-principal preview lines per active claim
 * for the given space. Result keyed by `blocking_claim_id` so the briefing
 * builder can join by claim row in one pass without an N+1.
 */
export function loadBlockingPreviews(
  db: Database,
  space_id: string,
  sprint_id: string | null = null
): Map<string, Array<{ blocked_principal: string; paths: string[] }>> {
  const rows = db
    .prepare(
      `SELECT blocking_claim_id, blocked_principal, paths_json
         FROM pending_edits
        WHERE space_id = ?1
          AND ${sprint_id === null ? 'sprint_id IS NULL' : 'sprint_id = ?2'}
          AND resolved_at IS NULL
          AND tombstoned_at IS NULL`
    )
    .all(
      ...(sprint_id === null ? [space_id] : [space_id, sprint_id])
    ) as Array<{
    blocking_claim_id: string;
    blocked_principal: string;
    paths_json: string;
  }>;

  const out = new Map<
    string,
    Array<{ blocked_principal: string; paths: string[] }>
  >();
  for (const r of rows) {
    let paths: string[] = [];
    try {
      const parsed = JSON.parse(r.paths_json) as unknown;
      if (Array.isArray(parsed)) {
        paths = parsed.filter((p): p is string => typeof p === 'string');
      }
    } catch {
      // ignore malformed
    }
    const list = out.get(r.blocking_claim_id) ?? [];
    list.push({ blocked_principal: r.blocked_principal, paths });
    out.set(r.blocking_claim_id, list);
  }
  return out;
}
