import type { Database } from 'bun:sqlite';

/**
 * Focus projection read helpers (issue #15).
 *
 * Briefing's `recent_progress` dimension wants the most-recent focus row
 * per `(principal, scope_hash)` so users see distinct work areas, not
 * heartbeat noise. Sorted by `started_at` desc and capped at `limit`.
 */
export type FocusRow = {
  focus_id: string;
  principal: string;
  scope_paths: string[];
  scope_hash: string;
  intent: string | null;
  started_at: string;
};

export function loadRecentFocus(
  db: Database,
  space_id: string,
  limit = 20
): FocusRow[] {
  let rows: Array<{
    focus_id: string;
    principal: string;
    scope_paths_json: string;
    scope_hash: string;
    intent: string | null;
    started_at: string;
  }>;
  try {
    rows = db
      .prepare(
        `SELECT f.focus_id, f.principal, f.scope_paths_json, f.scope_hash,
                f.intent, f.started_at
           FROM focus f
          WHERE f.space_id = ?1
            AND f.tombstoned_at IS NULL
            AND f.focus_id = (
              SELECT focus_id FROM focus
               WHERE space_id = ?1
                 AND principal = f.principal
                 AND scope_hash = f.scope_hash
                 AND tombstoned_at IS NULL
               ORDER BY started_at DESC
               LIMIT 1
            )
          ORDER BY f.started_at DESC
          LIMIT ?2`
      )
      .all(space_id, limit) as typeof rows;
  } catch (err) {
    const e = err as { message?: string };
    if (e?.message?.includes('no such table: focus')) return [];
    throw err;
  }

  return rows.map((r) => {
    let scope_paths: string[] = [];
    try {
      const parsed = JSON.parse(r.scope_paths_json) as unknown;
      if (Array.isArray(parsed)) {
        scope_paths = parsed.filter((p): p is string => typeof p === 'string');
      }
    } catch {
      // tolerate malformed
    }
    return {
      focus_id: r.focus_id,
      principal: r.principal,
      scope_paths,
      scope_hash: r.scope_hash,
      intent: r.intent,
      started_at: r.started_at
    };
  });
}
