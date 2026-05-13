import type { Database } from 'bun:sqlite';
import type { TeamemEvent } from '../../domain/events/types.js';
import { applyProjectionUpdate } from './apply-event.js';

export function rebuildProjections(
  db: Database,
  spaceId: string
): { replayed: number } {
  db.prepare('DELETE FROM claims WHERE space_id = ?1').run(spaceId);
  db.prepare('DELETE FROM findings WHERE space_id = ?1').run(spaceId);
  try {
    db.prepare('DELETE FROM finding_acknowledgements WHERE space_id = ?1').run(
      spaceId
    );
  } catch {
    // legacy fixtures
  }
  db.prepare('DELETE FROM discussions WHERE space_id = ?1').run(spaceId);
  db.prepare('DELETE FROM discussion_threads WHERE space_id = ?1').run(spaceId);
  db.prepare('DELETE FROM space_rules_snapshots WHERE space_id = ?1').run(
    spaceId
  );
  try {
    db.prepare('DELETE FROM decisions WHERE space_id = ?1').run(spaceId);
  } catch {
    // legacy fixtures
  }
  try {
    db.prepare('DELETE FROM decision_history WHERE space_id = ?1').run(spaceId);
  } catch {
    // legacy fixtures
  }

  const rows = db
    .query(
      'SELECT raw_json FROM events WHERE space_id = ?1 ORDER BY timestamp ASC'
    )
    .all(spaceId) as Array<{ raw_json: string }>;

  for (const row of rows) {
    const event = JSON.parse(row.raw_json) as TeamemEvent;
    applyProjectionUpdate(db, event);
  }

  return { replayed: rows.length };
}
