import type { Database } from 'bun:sqlite';
import { normalizeEventRoutingForRead } from '../../domain/events/routing.js';
import type { TeamemEvent } from '../../domain/events/types.js';
import { validateEvent } from '../../domain/events/validate.js';
import type { EventStore } from './types.js';

function parseEvent(rawJson: string): TeamemEvent {
  return normalizeEventRoutingForRead(JSON.parse(rawJson) as TeamemEvent);
}

export class SqliteEventStore implements EventStore {
  constructor(private readonly db: Database) {}

  append(event: TeamemEvent): void {
    const existing = this.db
      .query('SELECT event_id FROM idempotency_keys WHERE idempotency_key = ?1')
      .get(event.idempotency_key) as { event_id: string } | null;

    if (existing) {
      if (existing.event_id !== event.event_id) {
        throw new Error(
          `Idempotency conflict for key ${event.idempotency_key}`
        );
      }
      return;
    }

    const tx = this.db.transaction(() => {
      this.appendInTx(event);
    });

    tx();
  }

  /**
   * Sibling of {@link append} that performs the same INSERTs but does NOT
   * open its own `db.transaction()`. Callers who already hold a transaction
   * (e.g. the TOCTOU pre-claim gate in `claimScope`) MUST use this entry
   * point — opening a nested transaction inside an outer
   * `db.transaction(fn).immediate()` would either error or fragment the
   * RESERVED lock window. See plan §4 / §5 Phase 2b and the K3/H1 critique.
   *
   * Idempotency check is in-line with the same write so retries with a
   * pre-existing key short-circuit before the INSERT (defense-in-depth for
   * the deterministic idempotency-key strategy in F-NEW-3).
   */
  appendInTx(event: TeamemEvent): void {
    validateEvent(event, { requireRoutingMetadata: true });

    const existing = this.db
      .query('SELECT event_id FROM idempotency_keys WHERE idempotency_key = ?1')
      .get(event.idempotency_key) as { event_id: string } | null;

    if (existing) {
      if (existing.event_id !== event.event_id) {
        throw new Error(
          `Idempotency conflict for key ${event.idempotency_key}`
        );
      }
      return;
    }

    this.db
      .prepare(
        `INSERT INTO events (
        event_id, idempotency_key, space_id, timestamp, principal, actor, delegation,
        event_type, scope_json, payload_json, refs_json, confidence, schema_version, raw_json
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`
      )
      .run(
        event.event_id,
        event.idempotency_key,
        event.space_id,
        event.timestamp,
        event.principal,
        event.actor,
        event.delegation,
        event.event_type,
        JSON.stringify(event.scope),
        JSON.stringify(event.payload),
        event.refs ? JSON.stringify(event.refs) : null,
        event.confidence ?? null,
        event.schema_version,
        JSON.stringify(event)
      );

    this.db
      .prepare(
        'INSERT INTO idempotency_keys (idempotency_key, event_id, created_at) VALUES (?1, ?2, ?3)'
      )
      .run(event.idempotency_key, event.event_id, new Date().toISOString());
  }

  getById(eventId: string): TeamemEvent | null {
    const row = this.db
      .query('SELECT raw_json FROM events WHERE event_id = ?1')
      .get(eventId) as { raw_json: string } | null;
    if (!row) {
      return null;
    }
    return parseEvent(row.raw_json);
  }

  getUpdates(
    spaceId: string,
    sinceEventId?: string,
    limit = 100
  ): TeamemEvent[] {
    // ULID-based cursor: event_id is a ULID so lexicographic order = insertion order
    const rows = sinceEventId
      ? (this.db
          .query(
            'SELECT raw_json FROM events WHERE space_id = ?1 AND event_id > ?2 ORDER BY event_id ASC LIMIT ?3'
          )
          .all(spaceId, sinceEventId, limit) as Array<{ raw_json: string }>)
      : (this.db
          .query(
            'SELECT raw_json FROM events WHERE space_id = ?1 ORDER BY event_id ASC LIMIT ?2'
          )
          .all(spaceId, limit) as Array<{ raw_json: string }>);

    return rows.map((row) => parseEvent(row.raw_json));
  }
}
