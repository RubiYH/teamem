import type { Database } from 'bun:sqlite';
import type { TeamemEvent } from '../../domain/events/types.js';
import {
  canonicalScopePaths,
  computeScopeHash
} from '../../domain/focus/scope-hash.js';

const FOCUS_DEDUP_WINDOW_MS = 60_000;

type DecisionProjectionPayload = {
  decisionId: string;
  title: string;
  summary: string;
  body: string;
  kind: string;
  version: number;
  supersededByDecisionId: string | null;
};

function readDecisionProjectionPayload(
  event: TeamemEvent,
  fallbackVersion: number
): DecisionProjectionPayload {
  const rawVersion = event.payload.version;
  return {
    decisionId: String(
      (event.payload.decision_id as string | undefined) ?? event.event_id
    ),
    title: String((event.payload.title as string | undefined) ?? ''),
    summary: String((event.payload.summary as string | undefined) ?? ''),
    body: String((event.payload.body as string | undefined) ?? ''),
    kind: String((event.payload.kind as string | undefined) ?? 'architectural'),
    version:
      typeof rawVersion === 'number' && Number.isFinite(rawVersion)
        ? rawVersion
        : fallbackVersion,
    supersededByDecisionId:
      typeof event.payload.superseded_by_decision_id === 'string' &&
      event.payload.superseded_by_decision_id.length > 0
        ? (event.payload.superseded_by_decision_id as string)
        : null
  };
}

function insertDecisionHistory(
  db: Database,
  event: TeamemEvent,
  payload: DecisionProjectionPayload,
  lifecycleEvent: string,
  status: 'open' | 'superseded'
): void {
  db.prepare(
    `INSERT OR REPLACE INTO decision_history
     (source_event_id, decision_id, space_id, version, lifecycle_event, title, summary, body, kind, status, decided_by, created_at, predecessor_decision_id, superseded_by_decision_id, tombstoned_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, NULL)`
  ).run(
    event.event_id,
    payload.decisionId,
    event.space_id,
    payload.version,
    lifecycleEvent,
    payload.title,
    payload.summary,
    payload.body,
    payload.kind,
    status,
    event.principal,
    event.timestamp,
    typeof event.payload.predecessor_decision_id === 'string'
      ? event.payload.predecessor_decision_id
      : null,
    payload.supersededByDecisionId
  );
}

function insertLegacyDecisionRow(
  db: Database,
  event: TeamemEvent,
  payload: DecisionProjectionPayload,
  status: 'open' | 'superseded'
): void {
  db.prepare(
    `INSERT OR REPLACE INTO decisions
     (decision_id, space_id, title, status, summary, updated_at, source_event_id, kind, decided_by)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
  ).run(
    payload.decisionId,
    event.space_id,
    payload.title,
    status,
    payload.summary,
    event.timestamp,
    event.event_id,
    payload.kind,
    event.principal
  );
}

export function applyProjectionUpdate(db: Database, event: TeamemEvent): void {
  if (event.event_type === 'scope_claimed') {
    const claimId = String(
      (event.payload.claim_id as string | undefined) ?? event.event_id
    );
    db.prepare(
      `INSERT OR REPLACE INTO claims
      (claim_id, space_id, principal, actor, scope_json, intent, status, created_at, expires_at, released_at,
       repo_id, branch, head_sha_at_acquire, last_edit_at, auto_release_mode, path)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)`
    ).run(
      claimId,
      event.space_id,
      event.principal,
      event.actor,
      JSON.stringify(event.scope),
      String((event.payload.intent as string | undefined) ?? ''),
      'active',
      event.timestamp,
      (event.payload.expires_at as string | undefined) ?? null,
      null,
      String((event.payload.repo_id as string | undefined) ?? ''),
      String((event.payload.branch as string | undefined) ?? ''),
      (event.payload.head_sha_at_acquire as string | undefined) ?? null,
      (event.payload.last_edit_at as string | undefined) ?? null,
      String(
        (event.payload.auto_release_mode as string | undefined) ?? 'on_commit'
      ),
      String((event.payload.path as string | undefined) ?? '')
    );
  }

  if (event.event_type === 'scope_released') {
    const claimId = String(
      (event.payload.claim_id as string | undefined) ?? ''
    );
    if (claimId.length > 0) {
      db.prepare(
        'UPDATE claims SET status = ?1, released_at = ?2 WHERE claim_id = ?3'
      ).run('released', event.timestamp, claimId);
    }
  }

  // Codex round-2 review fix (#14): projection handlers for the new
  // claim-lifecycle event types. Live tools UPDATE the claims row inline
  // inside the same transaction that emits the event, but `rebuildProjections`
  // replays the event log through `applyProjectionUpdate` only — without
  // these handlers a rebuilt projection would leave already-released /
  // paused / expired claims in their pre-event state.
  if (
    event.event_type === 'scope_released_via_git' ||
    event.event_type === 'claim_force_released' ||
    event.event_type === 'claim_expired'
  ) {
    const claimId = String(
      (event.payload.claim_id as string | undefined) ?? ''
    );
    if (claimId.length > 0) {
      db.prepare(
        'UPDATE claims SET status = ?1, released_at = ?2 WHERE claim_id = ?3'
      ).run('released', event.timestamp, claimId);
    }
  }

  if (
    event.event_type === 'space_rule_added' ||
    event.event_type === 'space_rule_amended' ||
    event.event_type === 'space_rule_disabled'
  ) {
    const rulesMarkdown = String(
      (event.payload.rules_markdown as string | undefined) ?? ''
    );
    const rulesVersion = Number(
      (event.payload.rules_version as number | undefined) ?? 0
    );
    const isDisabled = event.event_type === 'space_rule_disabled' ? 1 : 0;
    const updater = db
      .query(
        `SELECT id
           FROM members
          WHERE space_id = ?1
            AND name = ?2
            AND left_at IS NULL
          LIMIT 1`
      )
      .get(event.space_id, event.principal) as { id: string } | null;

    try {
      db.prepare(
        `INSERT OR REPLACE INTO space_rules_snapshots
         (space_id, rules_markdown, rules_version, source_event_id, updated_at, updated_by_member_id, is_disabled)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
      ).run(
        event.space_id,
        rulesMarkdown,
        rulesVersion,
        event.event_id,
        event.timestamp,
        updater?.id ?? null,
        isDisabled
      );
    } catch (err) {
      const e = err as { message?: string };
      if (
        e?.message?.includes('no such table: space_rules_snapshots') ||
        e?.message?.includes('no such column: is_disabled')
      ) {
        return;
      }
      throw err;
    }
  }

  if (event.event_type === 'claim_paused') {
    const claimId = String(
      (event.payload.claim_id as string | undefined) ?? ''
    );
    const reason = String(
      (event.payload.paused_reason as string | undefined) ?? ''
    );
    if (claimId.length > 0) {
      db.prepare(
        'UPDATE claims SET paused_at = ?1, paused_reason = ?2 WHERE claim_id = ?3'
      ).run(event.timestamp, reason, claimId);
    }
  }

  if (event.event_type === 'claim_resumed') {
    const claimId = String(
      (event.payload.claim_id as string | undefined) ?? ''
    );
    if (claimId.length > 0) {
      db.prepare(
        'UPDATE claims SET paused_at = NULL, paused_reason = NULL WHERE claim_id = ?1'
      ).run(claimId);
    }
  }

  if (event.event_type === 'contract_changed') {
    const contractKey = String(
      (event.payload.contract_key as string | undefined) ?? 'default'
    );
    db.prepare(
      `INSERT OR REPLACE INTO contracts (contract_key, space_id, state_json, updated_at, updated_by_event_id)
       VALUES (?1, ?2, ?3, ?4, ?5)`
    ).run(
      contractKey,
      event.space_id,
      JSON.stringify(event.payload),
      event.timestamp,
      event.event_id
    );
  }

  if (
    event.event_type === 'blocker_raised' ||
    event.event_type === 'blocker_resolved'
  ) {
    const blockerId = String(
      (event.payload.blocker_id as string | undefined) ?? event.event_id
    );
    const status = event.event_type === 'blocker_raised' ? 'open' : 'resolved';
    db.prepare(
      `INSERT OR REPLACE INTO blockers (blocker_id, space_id, status, owner_principal, summary, updated_at, source_event_id)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
    ).run(
      blockerId,
      event.space_id,
      status,
      event.principal,
      String((event.payload.summary as string | undefined) ?? ''),
      event.timestamp,
      event.event_id
    );
  }

  if (
    event.event_type === 'decision_published' ||
    event.event_type === 'decision_amended' ||
    event.event_type === 'decision_superseded' ||
    event.event_type === 'decision_recorded'
  ) {
    const decisionId = String(
      (event.payload.decision_id as string | undefined) ?? event.event_id
    );

    try {
      const existing = db
        .query(
          `SELECT version
           FROM decisions
           WHERE space_id = ?1 AND decision_id = ?2 AND tombstoned_at IS NULL`
        )
        .get(event.space_id, decisionId) as { version: number } | null;
      const fallbackVersion =
        event.event_type === 'decision_published'
          ? 1
          : (existing?.version ?? 0) + 1;
      const payload = readDecisionProjectionPayload(event, fallbackVersion);
      const lifecycleEvent =
        event.event_type === 'decision_recorded'
          ? existing
            ? 'decision_amended'
            : 'decision_published'
          : event.event_type;
      const status =
        event.event_type === 'decision_superseded' ? 'superseded' : 'open';

      db.transaction(() => {
        if (event.event_type === 'decision_superseded') {
          db.prepare(
            `UPDATE decisions
             SET status = 'superseded',
                 updated_at = ?1,
                 source_event_id = ?2,
                 decided_by = ?3,
                 version = ?4,
                 latest_event_type = ?5,
                 superseded_by_decision_id = ?6,
                 superseded_at = ?1
             WHERE space_id = ?7 AND decision_id = ?8 AND tombstoned_at IS NULL`
          ).run(
            event.timestamp,
            event.event_id,
            event.principal,
            payload.version,
            event.event_type,
            payload.supersededByDecisionId,
            event.space_id,
            payload.decisionId
          );
        } else {
          db.prepare(
            `INSERT INTO decisions
             (decision_id, space_id, title, status, summary, updated_at, source_event_id, kind, decided_by, version, latest_event_type, superseded_by_decision_id, superseded_at, body)
             VALUES (?1, ?2, ?3, 'open', ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL, NULL, ?11)
             ON CONFLICT(decision_id) DO UPDATE SET
               title = excluded.title,
               status = 'open',
               summary = excluded.summary,
               updated_at = excluded.updated_at,
               source_event_id = excluded.source_event_id,
               kind = excluded.kind,
               decided_by = excluded.decided_by,
               version = excluded.version,
               latest_event_type = excluded.latest_event_type,
               superseded_by_decision_id = NULL,
               superseded_at = NULL,
               body = excluded.body`
          ).run(
            payload.decisionId,
            event.space_id,
            payload.title,
            payload.summary,
            event.timestamp,
            event.event_id,
            payload.kind,
            event.principal,
            payload.version,
            event.event_type,
            payload.body
          );
        }

        insertDecisionHistory(db, event, payload, lifecycleEvent, status);
      })();
    } catch (err) {
      const e = err as { message?: string };
      if (e?.message?.includes('no such table: decision_history')) {
        const payload = readDecisionProjectionPayload(event, 1);
        const status =
          event.event_type === 'decision_superseded' ? 'superseded' : 'open';
        insertLegacyDecisionRow(db, event, payload, status);
        return;
      }
      if (e?.message?.includes('table decisions has no column named version')) {
        const payload = readDecisionProjectionPayload(event, 1);
        const status =
          event.event_type === 'decision_superseded' ? 'superseded' : 'open';
        insertLegacyDecisionRow(db, event, payload, status);
        return;
      }
      throw err;
    }
  }

  if (event.event_type === 'discussion_posted') {
    const messageId = String(
      (event.payload.message_id as string | undefined) ?? event.event_id
    );
    const threadId = String(
      (event.payload.thread_id as string | undefined) ?? messageId
    );
    const visibilityMode = String(
      (event.payload.visibility_mode as string | undefined) ??
        (event.payload.recipient_principal == null ? 'broadcast' : 'direct')
    );
    const recipient = event.payload.recipient_principal as
      | string
      | null
      | undefined;
    const body = String((event.payload.body as string | undefined) ?? '');
    const inReplyTo = (event.payload.in_reply_to as string | undefined) ?? null;
    const participantPrincipals = normalizeParticipantPrincipals(
      event.payload.participant_principals,
      event.principal,
      recipient ?? null,
      visibilityMode
    );

    try {
      db.prepare(
        `INSERT OR IGNORE INTO discussion_threads
         (thread_id, space_id, visibility_mode, participant_principals_json, source_message_id, source_event_id, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
      ).run(
        threadId,
        event.space_id,
        visibilityMode,
        JSON.stringify(participantPrincipals),
        messageId,
        event.event_id,
        event.timestamp
      );

      db.prepare(
        `INSERT OR REPLACE INTO discussions
         (message_id, space_id, thread_id, sender_principal, recipient_principal, body, in_reply_to, created_at, source_event_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
      ).run(
        messageId,
        event.space_id,
        threadId,
        event.principal,
        recipient ?? null,
        body,
        inReplyTo,
        event.timestamp,
        event.event_id
      );
    } catch (err) {
      const e = err as { code?: string; message?: string };
      if (e?.message?.includes('no such table: discussions')) return;
      throw err;
    }
  }

  if (event.event_type === 'artifact_shared') {
    const artifactId = String(
      (event.payload.artifact_id as string | undefined) ?? event.event_id
    );
    const kindRaw = event.payload.kind;
    const kind =
      kindRaw === 'spec' ||
      kindRaw === 'fixture' ||
      kindRaw === 'doc' ||
      kindRaw === 'snippet'
        ? kindRaw
        : 'doc';
    const uri = String((event.payload.uri as string | undefined) ?? '');
    const title = String((event.payload.title as string | undefined) ?? '');
    const summary =
      typeof event.payload.summary === 'string'
        ? (event.payload.summary as string)
        : null;

    try {
      db.prepare(
        `INSERT OR REPLACE INTO artifacts
         (artifact_id, space_id, principal, kind, uri, title, summary, created_at, source_event_id, tombstoned_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL)`
      ).run(
        artifactId,
        event.space_id,
        event.principal,
        kind,
        uri,
        title,
        summary,
        event.timestamp,
        event.event_id
      );
    } catch (err) {
      const e = err as { message?: string };
      if (e?.message?.includes('no such table: artifacts')) return;
      throw err;
    }
  }

  if (event.event_type === 'finding_shared') {
    const findingId = String(
      (event.payload.finding_id as string | undefined) ?? event.event_id
    );
    const kind = event.payload.kind === 'gotcha' ? 'gotcha' : 'finding';
    const lifecycle =
      event.payload.lifecycle === 'persistent' || kind === 'gotcha'
        ? 'persistent'
        : 'ttl';
    const statusRaw = event.payload.status;
    const status =
      statusRaw === 'resolved' || statusRaw === 'archived'
        ? statusRaw
        : 'active';
    const versionRaw = event.payload.version;
    const version =
      typeof versionRaw === 'number' &&
      Number.isInteger(versionRaw) &&
      versionRaw > 0
        ? versionRaw
        : 1;
    const summary = String((event.payload.summary as string | undefined) ?? '');
    const body =
      typeof event.payload.body === 'string'
        ? (event.payload.body as string)
        : null;
    const pathsRaw = event.payload.paths;
    const paths = Array.isArray(pathsRaw)
      ? (pathsRaw as unknown[]).filter((p) => typeof p === 'string')
      : [];
    const tagsRaw = event.payload.tags;
    const tags = Array.isArray(tagsRaw)
      ? (tagsRaw as unknown[]).filter((t) => typeof t === 'string')
      : [];
    const recipientPrincipalsRaw = event.payload.recipient_principals;
    const recipientPrincipals = Array.isArray(recipientPrincipalsRaw)
      ? (recipientPrincipalsRaw as unknown[]).filter(
          (principal) => typeof principal === 'string'
        )
      : [];
    const severityRaw = event.payload.severity;
    const severity =
      severityRaw === 'urgent' || severityRaw === 'warning'
        ? severityRaw
        : 'info';
    const refsRaw = event.payload.refs;
    const refsJson =
      refsRaw && typeof refsRaw === 'object' ? JSON.stringify(refsRaw) : null;
    const expiresAtRaw = event.payload.expires_at;
    const expiresAt =
      typeof expiresAtRaw === 'string'
        ? expiresAtRaw
        : lifecycle === 'ttl'
          ? new Date(
              new Date(event.timestamp).getTime() + 7 * 24 * 60 * 60 * 1000
            ).toISOString()
          : null;

    try {
      db.prepare(
        `INSERT OR REPLACE INTO findings
         (finding_id, space_id, principal, summary, body, tags_json, severity,
          paths_json, refs_json, recipient_principals_json, kind, lifecycle, status, version,
          created_at, expires_at, source_event_id, tombstoned_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, NULL)`
      ).run(
        findingId,
        event.space_id,
        event.principal,
        summary,
        body,
        JSON.stringify(tags),
        severity,
        JSON.stringify(paths),
        refsJson,
        JSON.stringify(recipientPrincipals),
        kind,
        lifecycle,
        status,
        version,
        event.timestamp,
        expiresAt,
        event.event_id
      );
    } catch (err) {
      const e = err as { message?: string };
      if (e?.message?.includes('no such table: findings')) return;
      throw err;
    }
  }

  if (event.event_type === 'acknowledgment_recorded') {
    const findingId = String(
      (event.payload.finding_id as string | undefined) ?? ''
    );
    const principal = String(
      (event.payload.acknowledged_by as string | undefined) ?? event.principal
    );
    const versionRaw = event.payload.version;
    const version =
      typeof versionRaw === 'number' &&
      Number.isInteger(versionRaw) &&
      versionRaw > 0
        ? versionRaw
        : 1;
    const note =
      typeof event.payload.note === 'string'
        ? (event.payload.note as string)
        : null;

    if (findingId.length === 0 || principal.length === 0) return;

    try {
      db.prepare(
        `INSERT OR REPLACE INTO finding_acknowledgements
         (space_id, finding_id, version, principal, acknowledged_at, source_event_id, note)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
      ).run(
        event.space_id,
        findingId,
        version,
        principal,
        event.timestamp,
        event.event_id,
        note
      );
    } catch (err) {
      const e = err as { message?: string };
      if (e?.message?.includes('no such table: finding_acknowledgements')) {
        return;
      }
      throw err;
    }
  }

  if (event.event_type === 'conflict_queued') {
    // Issue #10 — Mode 6.A. Latter's gate-claim resolved to auto-skip and
    // the server enqueued a pending_edit row. Idempotent on `pending_id`.
    const pendingId = String(
      (event.payload.pending_id as string | undefined) ?? event.event_id
    );
    const blockingClaimId = String(
      (event.payload.blocking_claim_id as string | undefined) ?? ''
    );
    const intent = String((event.payload.intent as string | undefined) ?? '');
    const paths = Array.isArray(event.scope.paths) ? event.scope.paths : [];
    const expiresAt = String(
      (event.payload.expires_at as string | undefined) ??
        new Date(
          new Date(event.timestamp).getTime() + 24 * 60 * 60 * 1000
        ).toISOString()
    );

    try {
      db.prepare(
        `INSERT OR REPLACE INTO pending_edits
         (pending_id, space_id, blocked_principal, blocking_claim_id,
          paths_json, intent, created_at, expires_at, resolved_at,
          source_event_id, tombstoned_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, ?9, NULL)`
      ).run(
        pendingId,
        event.space_id,
        event.principal,
        blockingClaimId,
        JSON.stringify(paths),
        intent,
        event.timestamp,
        expiresAt,
        event.event_id
      );
    } catch (err) {
      const e = err as { message?: string };
      if (e?.message?.includes('no such table: pending_edits')) return;
      throw err;
    }
  }

  if (event.event_type === 'conflict_resolved') {
    // Mark the queued row resolved. The server's resolve-on-release scan
    // emits one event per matched pending_id; the projection updates that
    // single row.
    const pendingId = (event.payload.pending_id as string | undefined) ?? '';
    if (pendingId.length > 0) {
      try {
        db.prepare(
          `UPDATE pending_edits
              SET resolved_at = ?1
            WHERE pending_id = ?2
              AND resolved_at IS NULL`
        ).run(event.timestamp, pendingId);
      } catch (err) {
        const e = err as { message?: string };
        if (e?.message?.includes('no such table: pending_edits')) return;
        throw err;
      }
    }
  }

  if (event.event_type === 'permission_requested') {
    // Issue #11 — Mode 6.B. Insert the permission_requests row with
    // status='open'. The tool layer checks the per-space concurrency cap
    // BEFORE inserting (so a hard cap is upheld even if multiple concurrent
    // requesters race); this projection writer just persists the row.
    const reqId = String(
      (event.payload.req_id as string | undefined) ?? event.event_id
    );
    const incumbentPrincipal = String(
      (event.payload.incumbent_principal as string | undefined) ?? ''
    );
    const blockingClaimId = String(
      (event.payload.blocking_claim_id as string | undefined) ?? ''
    );
    const intent = String((event.payload.intent as string | undefined) ?? '');
    const paths = Array.isArray(event.scope.paths) ? event.scope.paths : [];

    try {
      db.prepare(
        `INSERT OR REPLACE INTO permission_requests
         (req_id, space_id, requester_principal, incumbent_principal,
          blocking_claim_id, paths_json, intent, status, created_at,
          resolved_at, source_event_id, tombstoned_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'open', ?8, NULL, ?9, NULL)`
      ).run(
        reqId,
        event.space_id,
        event.principal,
        incumbentPrincipal,
        blockingClaimId,
        JSON.stringify(paths),
        intent,
        event.timestamp,
        event.event_id
      );
    } catch (err) {
      const e = err as { message?: string };
      if (e?.message?.includes('no such table: permission_requests')) return;
      throw err;
    }
  }

  if (
    event.event_type === 'permission_granted' ||
    event.event_type === 'permission_denied' ||
    event.event_type === 'permission_expired'
  ) {
    const reqId = String((event.payload.req_id as string | undefined) ?? '');
    if (reqId.length === 0) return;
    const status =
      event.event_type === 'permission_granted'
        ? 'granted'
        : event.event_type === 'permission_denied'
          ? 'denied'
          : 'expired';

    try {
      db.prepare(
        `UPDATE permission_requests
            SET status = ?1, resolved_at = ?2
          WHERE req_id = ?3
            AND status = 'open'`
      ).run(status, event.timestamp, reqId);
    } catch (err) {
      const e = err as { message?: string };
      if (e?.message?.includes('no such table: permission_requests')) return;
      throw err;
    }
  }

  if (
    event.event_type === 'task_started' ||
    event.event_type === 'task_progressed' ||
    event.event_type === 'task_completed'
  ) {
    const taskId = String(
      (event.payload.task_id as string | undefined) ?? event.event_id
    );
    const what = String((event.payload.what as string | undefined) ?? '');
    const status =
      event.event_type === 'task_completed'
        ? 'completed'
        : event.event_type === 'task_progressed'
          ? 'in_progress'
          : 'started';

    // task_state table may not exist until migration 002 runs — guard with try/catch
    try {
      db.prepare(
        `INSERT OR REPLACE INTO task_state
         (task_id, space_id, principal, status, what, started_at, completed_at, updated_at, source_event_id)
         VALUES (?1, ?2, ?3, ?4, ?5,
           COALESCE((SELECT started_at FROM task_state WHERE task_id = ?1 AND space_id = ?2), ?6),
           ?7, ?8, ?9)`
      ).run(
        taskId,
        event.space_id,
        event.principal,
        status,
        what,
        event.event_type === 'task_started' ? event.timestamp : null,
        event.event_type === 'task_completed' ? event.timestamp : null,
        event.timestamp,
        event.event_id
      );
    } catch {
      // task_state table not yet created (migration 002 not run) — silently skip
    }
  }

  if (event.event_type === 'agent_focus_changed') {
    // Issue #15. Computed scope_hash and canonical paths from event.scope.
    // The event has already been appended to the event log by the caller —
    // this projection step inserts a focus row UNLESS a row already exists
    // for `(space_id, principal, scope_hash)` within the last 60s and
    // bypass_dedup !== true. The collapsed case keeps the audit event but
    // skips the projection write so consumers see one focus per work area.
    const focusId = String(
      (event.payload.focus_id as string | undefined) ?? event.event_id
    );
    const scopePaths = canonicalScopePaths(event.scope.paths);
    const scopeHash = String(
      (event.payload.scope_hash as string | undefined) ??
        computeScopeHash(scopePaths)
    );
    const intent =
      typeof event.payload.intent === 'string'
        ? (event.payload.intent as string)
        : null;
    const bypass = event.payload.bypass_dedup === true;
    const ts = new Date(event.timestamp).getTime();
    const windowStart = new Date(ts - FOCUS_DEDUP_WINDOW_MS).toISOString();

    try {
      if (!bypass) {
        const existing = db
          .prepare(
            `SELECT focus_id FROM focus
              WHERE space_id = ?1
                AND principal = ?2
                AND scope_hash = ?3
                AND tombstoned_at IS NULL
                AND started_at >= ?4
              ORDER BY started_at DESC
              LIMIT 1`
          )
          .get(event.space_id, event.principal, scopeHash, windowStart) as {
          focus_id: string;
        } | null;
        if (existing) {
          // Dedup hit — projection collapses (no insert). Audit trail in
          // the events table still records this event for traceability.
          return;
        }
      }
      db.prepare(
        `INSERT OR REPLACE INTO focus
         (focus_id, space_id, principal, scope_paths_json, scope_hash,
          intent, started_at, source_event_id, tombstoned_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL)`
      ).run(
        focusId,
        event.space_id,
        event.principal,
        JSON.stringify(scopePaths),
        scopeHash,
        intent,
        event.timestamp,
        event.event_id
      );
    } catch (err) {
      const e = err as { message?: string };
      if (e?.message?.includes('no such table: focus')) return;
      throw err;
    }
  }
}

function normalizeParticipantPrincipals(
  raw: unknown,
  senderPrincipal: string,
  recipientPrincipal: string | null,
  visibilityMode: string
): string[] {
  if (Array.isArray(raw)) {
    return Array.from(
      new Set(raw.filter((v): v is string => typeof v === 'string').sort())
    );
  }
  if (visibilityMode === 'broadcast') return [];
  return Array.from(
    new Set(
      [senderPrincipal, recipientPrincipal].filter((v): v is string => !!v)
    )
  ).sort();
}
