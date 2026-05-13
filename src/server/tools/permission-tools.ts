import type { ToolContext } from './context.js';
import type { TeamemEvent } from '../../domain/events/types.js';
import type { ToolResponse } from '../types.js';

export async function requestEditPermission(
  ctx: ToolContext,
  input: {
    space_id: string;
    principal: string;
    actor: string;
    delegation: string;
    req_id?: unknown;
    blocking_claim_id: unknown;
    paths: unknown;
    intent?: unknown;
    _create_only?: boolean;
    _long_poll_timeout_ms?: number;
    _disable_waker_for_test?: boolean;
  }
): Promise<
  ToolResponse<{
    req_id: string;
    action: 'allow' | 'skip' | 'pending';
    claim_id?: string;
    expires_at?: string;
    reason?: 'denied_by_incumbent' | 'timeout';
  }>
> {
  const suppliedReqId =
    typeof input.req_id === 'string' && input.req_id.trim() !== ''
      ? input.req_id.trim()
      : '';
  const reqId = suppliedReqId || ctx.ulid();
  const createOnly = input._create_only === true;
  const timeoutMs =
    typeof input._long_poll_timeout_ms === 'number' &&
    input._long_poll_timeout_ms >= 0
      ? input._long_poll_timeout_ms
      : ctx.DEFAULT_PERMISSION_REQUEST_TIMEOUT_MS;
  try {
    const existingReq = ctx.readPermissionRequestRow(
      ctx.db,
      input.space_id,
      reqId
    );
    if (existingReq) {
      if (existingReq.requester_principal !== input.principal) {
        return ctx.toolError(
          'permission_request_not_owned',
          'req_id belongs to a different requester'
        );
      }
      const projected = ctx.readPermissionResolutionFromProjection(
        ctx.db,
        input.space_id,
        reqId
      );
      if (projected) {
        return {
          ok: true,
          data: ctx.permissionResolutionToResponseData(reqId, projected)
        };
      }
      if (createOnly) {
        return { ok: true, data: { req_id: reqId, action: 'pending' } };
      }

      const existingResolution = await ctx.waitForPermissionResolution({
        db: ctx.db,
        reqId,
        spaceId: input.space_id,
        timeoutMs,
        disableWaker: input._disable_waker_for_test
      });

      if (
        existingResolution.action === 'skip' &&
        existingResolution.reason === 'timeout'
      ) {
        try {
          const stillOpen = ctx.db
            .prepare(
              `SELECT 1 FROM permission_requests
                WHERE req_id = ?1 AND status = 'open'`
            )
            .get(reqId);
          if (stillOpen) {
            const expEvt: TeamemEvent = {
              schema_version: '1.0',
              event_id: ctx.newEventId(),
              idempotency_key: `idem-permexp-${reqId}`,
              space_id: input.space_id,
              timestamp: new Date().toISOString(),
              principal: input.principal,
              actor: input.actor,
              delegation: input.delegation,
              event_type: 'permission_expired',
              scope: {},
              payload: { req_id: reqId }
            };
            ctx.db
              .transaction(() => {
                ctx.store.appendInTx(expEvt);
                ctx.applyProjectionUpdate(ctx.db, expEvt);
              })
              .immediate();
          }
        } catch {
          // best-effort — caller still receives skip(timeout)
        }
      }

      return {
        ok: true,
        data: ctx.permissionResolutionToResponseData(reqId, existingResolution)
      };
    }
  } catch {
    return ctx.toolError(
      'permission_requests_unavailable',
      'permission_requests table missing — run migration 016'
    );
  }

  const blockingClaimId =
    typeof input.blocking_claim_id === 'string' ? input.blocking_claim_id : '';
  if (!blockingClaimId) {
    return ctx.toolError(
      'blocking_claim_id_required',
      'blocking_claim_id must be a non-empty string'
    );
  }
  const requestedPaths = Array.isArray(input.paths)
    ? input.paths.filter((p): p is string => typeof p === 'string')
    : [];
  if (requestedPaths.length === 0) {
    return ctx.toolError(
      'paths_required',
      'paths must be a non-empty array of strings'
    );
  }
  const intent = typeof input.intent === 'string' ? input.intent : '';

  let claimRow: {
    principal: string;
    scope_json: string;
    released_at: string | null;
  } | null;
  try {
    claimRow = ctx.db
      .query(
        `SELECT principal, scope_json, released_at
           FROM claims
          WHERE claim_id = ?1
            AND space_id = ?2
            AND tombstoned_at IS NULL`
      )
      .get(blockingClaimId, input.space_id) as typeof claimRow;
  } catch {
    return ctx.toolError(
      'permission_requests_unavailable',
      'permission_requests/claims tables missing — run migrations'
    );
  }
  if (!claimRow || claimRow.released_at !== null) {
    return ctx.toolError(
      'blocking_claim_not_active',
      'cited blocking_claim_id does not match an active claim'
    );
  }
  let claimPaths: string[] = [];
  try {
    const parsed = JSON.parse(claimRow.scope_json) as TeamemEvent['scope'];
    claimPaths = Array.isArray(parsed.paths) ? parsed.paths : [];
  } catch {
    // malformed — falls through to no_overlap below
  }
  if (!ctx.hasOverlap(claimPaths, requestedPaths)) {
    return ctx.toolError(
      'no_overlap',
      'requested paths do not overlap the cited claim'
    );
  }

  // Per-space concurrency cap: max(20, 2 × active_members) (Pre-mortem
  // F1). Count active (non-left) members and outstanding open requests.
  let activeMemberCount = 1;
  try {
    const row = ctx.db
      .prepare(
        `SELECT COUNT(*) AS c FROM members
          WHERE space_id = ?1 AND left_at IS NULL`
      )
      .get(input.space_id) as { c: number } | null;
    activeMemberCount = Math.max(1, row?.c ?? 1);
  } catch {
    // members table absent — use floor of 1
  }
  const cap = Math.max(20, 2 * activeMemberCount);

  let openCount = 0;
  try {
    const row = ctx.db
      .prepare(
        `SELECT COUNT(*) AS c FROM permission_requests
          WHERE space_id = ?1 AND status = 'open' AND tombstoned_at IS NULL`
      )
      .get(input.space_id) as { c: number } | null;
    openCount = row?.c ?? 0;
  } catch {
    return ctx.toolError(
      'permission_requests_unavailable',
      'permission_requests table missing — run migration 016'
    );
  }
  if (openCount >= cap) {
    return ctx.toolError('too_many_pending_requests', `cap=${cap}`);
  }

  const timestamp = new Date().toISOString();
  const event: TeamemEvent = {
    schema_version: '1.0',
    event_id: ctx.newEventId(),
    idempotency_key: `idem-permreq-${reqId}`,
    space_id: input.space_id,
    timestamp,
    principal: input.principal,
    actor: input.actor,
    delegation: input.delegation,
    event_type: 'permission_requested',
    scope: { paths: requestedPaths },
    payload: {
      req_id: reqId,
      incumbent_principal: claimRow.principal,
      blocking_claim_id: blockingClaimId,
      intent
    }
  };

  try {
    ctx.db
      .transaction(() => {
        ctx.store.appendInTx(event);
        ctx.applyProjectionUpdate(ctx.db, event);
      })
      .immediate();
  } catch (err) {
    const e = err as { message?: string };
    if (e?.message?.includes('no such table: permission_requests')) {
      return ctx.toolError(
        'permission_requests_unavailable',
        'permission_requests table missing — run migration 016'
      );
    }
    throw err;
  }

  if (createOnly) {
    return { ok: true, data: { req_id: reqId, action: 'pending' } };
  }

  const resolution = await ctx.waitForPermissionResolution({
    db: ctx.db,
    reqId,
    spaceId: input.space_id,
    timeoutMs,
    disableWaker: input._disable_waker_for_test
  });

  // Side-effect: timeout path needs to append `permission_expired` so
  // any subsequent grant attempt sees a non-`open` row and 409s.
  if (resolution.action === 'skip' && resolution.reason === 'timeout') {
    try {
      const stillOpen = ctx.db
        .prepare(
          `SELECT 1 FROM permission_requests
            WHERE req_id = ?1 AND status = 'open'`
        )
        .get(reqId);
      if (stillOpen) {
        const expEvt: TeamemEvent = {
          schema_version: '1.0',
          event_id: ctx.newEventId(),
          idempotency_key: `idem-permexp-${reqId}`,
          space_id: input.space_id,
          timestamp: new Date().toISOString(),
          principal: input.principal,
          actor: input.actor,
          delegation: input.delegation,
          event_type: 'permission_expired',
          scope: {},
          payload: { req_id: reqId }
        };
        ctx.db
          .transaction(() => {
            ctx.store.appendInTx(expEvt);
            ctx.applyProjectionUpdate(ctx.db, expEvt);
          })
          .immediate();
      }
    } catch {
      // best-effort — the row stays open until GC, but the latter has
      // already received `skip` so the gate-claim path falls through.
    }
  }

  return {
    ok: true,
    data: ctx.permissionResolutionToResponseData(reqId, resolution)
  };
}

export function respondPermissionRequest(
  ctx: ToolContext,
  input: {
    space_id: string;
    principal: string;
    actor: string;
    delegation: string;
    req_id: unknown;
    decision: unknown;
  }
): ToolResponse<{
  req_id: string;
  status: 'granted' | 'denied';
  new_claim_id?: string;
  kept_paths?: string[];
  released_paths?: string[];
}> {
  const reqId = typeof input.req_id === 'string' ? input.req_id : '';
  if (!reqId) {
    return ctx.toolError('req_id_required', 'req_id must be a string');
  }
  if (input.decision !== 'accept' && input.decision !== 'deny') {
    return ctx.toolError(
      'invalid_decision',
      'decision must be one of: accept | deny'
    );
  }

  try {
    return ctx.db
      .transaction(() => {
        const reqRow = ctx.db
          .prepare(
            `SELECT requester_principal, incumbent_principal,
                    blocking_claim_id, paths_json, status
               FROM permission_requests
              WHERE req_id = ?1
                AND space_id = ?2
                AND tombstoned_at IS NULL`
          )
          .get(reqId, input.space_id) as {
          requester_principal: string;
          incumbent_principal: string;
          blocking_claim_id: string;
          paths_json: string;
          status: string;
        } | null;
        if (!reqRow) {
          return ctx.toolError(
            'permission_request_not_found',
            `req_id=${reqId}`
          );
        }
        if (reqRow.status !== 'open') {
          return ctx.toolError(
            'already_resolved',
            `request status=${reqRow.status}`
          );
        }
        if (reqRow.incumbent_principal !== input.principal) {
          return ctx.toolError(
            'not_incumbent',
            'only the cited claim incumbent may respond'
          );
        }

        let requestedPaths: string[] = [];
        try {
          const parsed = JSON.parse(reqRow.paths_json) as unknown;
          if (Array.isArray(parsed)) {
            requestedPaths = parsed.filter(
              (p): p is string => typeof p === 'string'
            );
          }
        } catch {
          // malformed — surface invalid_state below
        }

        const timestamp = new Date().toISOString();

        if (input.decision === 'deny') {
          const denyEvt: TeamemEvent = {
            schema_version: '1.0',
            event_id: ctx.newEventId(),
            idempotency_key: `idem-permdeny-${reqId}`,
            space_id: input.space_id,
            timestamp,
            principal: input.principal,
            actor: input.actor,
            delegation: input.delegation,
            event_type: 'permission_denied',
            scope: {},
            payload: { req_id: reqId }
          };
          ctx.store.appendInTx(denyEvt);
          ctx.applyProjectionUpdate(ctx.db, denyEvt);
          const waker = ctx.permissionWakers.get(reqId);
          if (waker) {
            waker({ action: 'skip', reason: 'denied_by_incumbent' });
          }
          return {
            ok: true,
            data: { req_id: reqId, status: 'denied' as const }
          };
        }

        // accept path — narrow claim + emit grant
        const claimRow = ctx.db
          .query(
            `SELECT principal, scope_json
               FROM claims
              WHERE claim_id = ?1
                AND space_id = ?2
                AND tombstoned_at IS NULL`
          )
          .get(reqRow.blocking_claim_id, input.space_id) as {
          principal: string;
          scope_json: string;
        } | null;
        if (!claimRow || claimRow.principal !== input.principal) {
          return ctx.toolError(
            'not_incumbent',
            'cited claim no longer owned by caller'
          );
        }
        let claimPaths: string[] = [];
        try {
          const parsed = JSON.parse(
            claimRow.scope_json
          ) as TeamemEvent['scope'];
          claimPaths = Array.isArray(parsed.paths) ? parsed.paths : [];
        } catch {
          // malformed — proceed with empty kept set
        }
        const { kept, released } = ctx.narrowClaimPaths(
          claimPaths,
          requestedPaths
        );

        // 1. scope_released for incumbent — payload includes
        // released_paths so audit trail records the partial release.
        const releaseEvt: TeamemEvent = {
          schema_version: '1.0',
          event_id: ctx.newEventId(),
          idempotency_key: `idem-narrowrel-${reqId}`,
          space_id: input.space_id,
          timestamp,
          principal: input.principal,
          actor: input.actor,
          delegation: input.delegation,
          event_type: 'scope_released',
          scope: { paths: released },
          payload: {
            claim_id: reqRow.blocking_claim_id,
            released_paths: released,
            narrowed: true
          }
        };
        ctx.store.appendInTx(releaseEvt);
        // Update claim row directly: keep status='active' but narrow
        // scope_json to kept. If kept is empty, flip status to released.
        if (kept.length === 0) {
          ctx.db
            .prepare(
              `UPDATE claims SET status = 'released', released_at = ?1,
                               scope_json = ?2
              WHERE claim_id = ?3`
            )
            .run(
              timestamp,
              JSON.stringify({ paths: kept }),
              reqRow.blocking_claim_id
            );
        } else {
          ctx.db
            .prepare(
              `UPDATE claims SET scope_json = ?1
              WHERE claim_id = ?2`
            )
            .run(JSON.stringify({ paths: kept }), reqRow.blocking_claim_id);
        }

        // 2. fresh scope_claimed for latter
        const grantedClaimId = ctx.newClaimId();
        const newExpiresAt = new Date(
          new Date(timestamp).getTime() + 60 * 60 * 1000
        ).toISOString();
        const claimEvt: TeamemEvent = {
          schema_version: '1.0',
          event_id: ctx.newEventId(),
          idempotency_key: `idem-narrowclaim-${reqId}`,
          space_id: input.space_id,
          timestamp,
          principal: reqRow.requester_principal,
          actor: reqRow.requester_principal,
          delegation: `${reqRow.requester_principal}->${reqRow.requester_principal}`,
          event_type: 'scope_claimed',
          scope: { paths: requestedPaths },
          payload: {
            claim_id: grantedClaimId,
            intent: 'granted via permission_request',
            expires_at: newExpiresAt
          }
        };
        ctx.store.appendInTx(claimEvt);
        ctx.applyProjectionUpdate(ctx.db, claimEvt);

        // 3. permission_granted marker — flips the request row to
        // status='granted'.
        const grantEvt: TeamemEvent = {
          schema_version: '1.0',
          event_id: ctx.newEventId(),
          idempotency_key: `idem-permgrant-${reqId}`,
          space_id: input.space_id,
          timestamp,
          principal: input.principal,
          actor: input.actor,
          delegation: input.delegation,
          event_type: 'permission_granted',
          scope: { paths: requestedPaths },
          payload: {
            req_id: reqId,
            granted_to: reqRow.requester_principal,
            new_claim_id: grantedClaimId
          }
        };
        ctx.store.appendInTx(grantEvt);
        ctx.applyProjectionUpdate(ctx.db, grantEvt);

        // Issue #15 — fire a focus event for the LATTER with
        // bypass_dedup: true so the post-grant focus shift always
        // lands in the projection, even if the latter recently held
        // a same-scope focus (e.g. they queued, got denied, then
        // got granted on a retry). The audit trail thus reflects
        // every grant-narrow boundary regardless of timing.
        const grantedPaths = ctx.canonicalScopePaths(requestedPaths);
        const grantedHash = ctx.computeScopeHash(grantedPaths);
        const grantedFocusId = ctx.ulid();
        const focusEvt: TeamemEvent = {
          schema_version: '1.0',
          event_id: ctx.newEventId(),
          idempotency_key: `idem-focus-grant-${reqId}`,
          space_id: input.space_id,
          timestamp,
          principal: reqRow.requester_principal,
          actor: reqRow.requester_principal,
          delegation: `${reqRow.requester_principal}->${reqRow.requester_principal}`,
          event_type: 'agent_focus_changed',
          scope: { paths: grantedPaths },
          payload: {
            focus_id: grantedFocusId,
            scope_hash: grantedHash,
            intent: 'granted via permission_request',
            bypass_dedup: true,
            source: 'mode_6b_grant',
            req_id: reqId
          }
        };
        try {
          ctx.store.appendInTx(focusEvt);
          ctx.applyProjectionUpdate(ctx.db, focusEvt);
        } catch {
          // focus table missing in legacy fixtures — non-fatal,
          // grant must still succeed.
        }

        const waker = ctx.permissionWakers.get(reqId);
        if (waker) {
          waker({
            action: 'allow',
            claim_id: grantedClaimId,
            expires_at: newExpiresAt
          });
        }

        return {
          ok: true,
          data: {
            req_id: reqId,
            status: 'granted' as const,
            new_claim_id: grantedClaimId,
            kept_paths: kept,
            released_paths: released
          }
        };
      })
      .immediate() as ToolResponse<{
      req_id: string;
      status: 'granted' | 'denied';
      new_claim_id?: string;
      kept_paths?: string[];
      released_paths?: string[];
    }>;
  } catch (err) {
    const e = err as { message?: string };
    if (e?.message?.includes('no such table: permission_requests')) {
      return ctx.toolError(
        'permission_requests_unavailable',
        'permission_requests table missing — run migration 016'
      );
    }
    throw err;
  }
}
