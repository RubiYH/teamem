import type { ToolContext } from './context.js';
import type { ClaimScopeTestHooks } from './context.js';
import type { TeamemEvent } from '../../domain/events/types.js';
import type { ToolResponse } from '../types.js';
import type { OverlapHit } from '../../domain/conflicts/index.js';

export function claimScope(
  ctx: ToolContext,
  input: {
    space_id: string;
    principal: string;
    actor: string;
    delegation: string;
    scope: TeamemEvent['scope'];
    intent?: string;
    lease_seconds?: number;
    repo_id?: string;
    branch?: string;
    current_head_sha?: string;
    auto_release_mode?: 'on_commit' | 'manual_only' | 'ttl';
  },
  hooks?: ClaimScopeTestHooks
): ToolResponse<{ claim_id: string; expires_at: string | null }> {
  // Slice #29 validation: reject explicitly-empty required fields.
  if (input.repo_id !== undefined && input.repo_id === '') {
    return ctx.toolError('INVALID_PAYLOAD', 'repo_id is required', {});
  }
  if (input.branch !== undefined && input.branch === '') {
    return ctx.toolError('INVALID_PAYLOAD', 'branch is required', {});
  }
  const validModes = ['on_commit', 'manual_only', 'ttl'];
  if (
    input.auto_release_mode !== undefined &&
    !validModes.includes(input.auto_release_mode)
  ) {
    return ctx.toolError(
      'INVALID_PAYLOAD',
      'auto_release_mode must be on_commit, manual_only, or ttl',
      {}
    );
  }
  const resolvedMode = input.auto_release_mode ?? 'on_commit';
  // PRD §150: expires_at must be NULL for on_commit and manual_only;
  // only ttl mode sets expires_at = acquire_time + lease_seconds.
  // Reject lease_seconds for non-ttl modes — there is nothing to set.
  if (resolvedMode !== 'ttl' && input.lease_seconds !== undefined) {
    return ctx.toolError(
      'INVALID_PAYLOAD',
      `expires_at must be null for ${resolvedMode} claims; lease_seconds applies only to ttl mode`,
      {}
    );
  }

  const claimId = ctx.newClaimId();
  const leaseSeconds = input.lease_seconds ?? 0;
  if (resolvedMode === 'ttl' && leaseSeconds <= 0) {
    return ctx.toolError(
      'INVALID_PAYLOAD',
      'ttl mode requires a positive lease_seconds',
      {}
    );
  }
  const expiresAt =
    resolvedMode === 'ttl'
      ? new Date(Date.now() + leaseSeconds * 1000).toISOString()
      : null;

  // F-NEW-3: derive the deterministic idempotency_key BEFORE opening
  // the tx. Keyed on (space_id, principal, normalized_scope_paths) —
  // never on actor (route-layer auto-defaults actor=principal). The
  // events-table UNIQUE on idempotency_key is defense-in-depth: any
  // duplicate self-claim that bypasses the gate still collides here.
  const normalizedPaths = ctx.normalizeScopePaths(input.scope.paths);
  const currentSprintId = ctx.readCurrentSprintId(
    ctx.db,
    input.space_id,
    input.principal
  );
  const idempotencyKey = `${ctx.deterministicClaimIdempotencyKey(
    input.space_id,
    input.principal,
    normalizedPaths
  )}:context:${currentSprintId ?? 'space'}`;
  const nowIso = new Date().toISOString();
  const event: TeamemEvent = {
    schema_version: '1.0',
    event_id: ctx.newEventId(),
    idempotency_key: idempotencyKey,
    space_id: input.space_id,
    timestamp: nowIso,
    principal: input.principal,
    actor: input.actor,
    delegation: input.delegation,
    event_type: 'scope_claimed',
    ...ctx.routingMetadataForPrincipal(ctx.db, input, {
      delivery: 'broadcast'
    }),
    scope: input.scope,
    payload: {
      claim_id: claimId,
      intent: input.intent ?? '',
      expires_at: expiresAt,
      repo_id: input.repo_id ?? '',
      branch: input.branch ?? '',
      head_sha_at_acquire: input.current_head_sha ?? null,
      last_edit_at: nowIso,
      auto_release_mode: resolvedMode,
      path: input.scope?.paths?.[0] ?? ''
    }
  };

  const txStartMs = performance.now();
  try {
    // CRITICAL: keep .immediate() — see plan §4 / R-NEW-2. Bare
    // ctx.db.transaction() is deferred and re-opens the TOCTOU race.
    return ctx.db
      .transaction(() => {
        const rows = ctx.selectActiveClaimsForOverlap(
          ctx.db,
          input.space_id,
          currentSprintId,
          input.repo_id,
          input.branch
        );

        // SYNC test-only seam — Critic iter-2 CRITICAL. afterSelectHook
        // fires AFTER the SELECT and BEFORE the INSERT, *inside* the
        // sync tx body. Awaiting a Promise here would commit the tx
        // before the seam ran (defeating AC-NEW-2). Production never
        // passes a hook.
        const hits: OverlapHit[] = ctx.findOverlappingActiveClaims(
          rows,
          normalizedPaths,
          hooks?.afterSelectHook
            ? { afterSelectHook: hooks.afterSelectHook }
            : undefined
        );

        const foreignHits = hits.filter((h) => h.principal !== input.principal);
        const selfHits = hits.filter((h) => h.principal === input.principal);

        if (foreignHits.length > 0) {
          // claim_scope.gate.foreign_conflict — counter increment.
          ctx.metrics.increment('claim_scope.gate.foreign_conflict');
          const firstHit = foreignHits[0]!;
          const requesterCoordPref = ctx.getMemberCoordPref(
            ctx.db,
            input.space_id,
            input.principal
          );
          const incumbentCoordPref = ctx.getMemberCoordPref(
            ctx.db,
            input.space_id,
            firstHit.principal
          );
          // Check whether the conflicting claim is paused — if so, emit
          // claim_paused_by_peer (same payload shape + paused_at/reason).
          const pauseInfo = ctx.getPausedAtForClaim(ctx.db, firstHit.claim_id);
          if (pauseInfo.paused_at != null) {
            throw new ctx.ScopeConflictError({
              code: 'claim_paused_by_peer',
              message: `Scope conflicts with paused claim ${firstHit.claim_id} held by ${firstHit.principal} (paused: ${pauseInfo.paused_at})`,
              conflicting_claim_id: firstHit.claim_id,
              conflicting_principal: firstHit.principal,
              colliding_paths: ctx.dedupeSorted(
                foreignHits.flatMap((h) => h.matched_target_paths)
              ),
              requester_coord_pref: requesterCoordPref,
              incumbent_coord_pref: incumbentCoordPref,
              paused_at: pauseInfo.paused_at,
              paused_reason: pauseInfo.paused_reason ?? undefined
            });
          }
          // Throwing aborts the .immediate() tx → automatic ROLLBACK.
          throw new ctx.ScopeConflictError({
            code: 'scope_conflict',
            message: `Scope conflicts with active claim ${firstHit.claim_id} held by ${firstHit.principal}`,
            conflicting_claim_id: firstHit.claim_id,
            conflicting_principal: firstHit.principal,
            colliding_paths: ctx.dedupeSorted(
              foreignHits.flatMap((h) => h.matched_target_paths)
            ),
            requester_coord_pref: requesterCoordPref,
            incumbent_coord_pref: incumbentCoordPref
          });
        }

        if (selfHits.length > 0) {
          const selfClaims = rows.filter(
            (r) => r.principal === input.principal
          );
          const existing = ctx.pickSupersetSelfClaim(
            selfHits,
            selfClaims,
            normalizedPaths
          );
          if (existing) {
            // claim_scope.gate.self_idempotent — counter increment.
            ctx.metrics.increment('claim_scope.gate.self_idempotent');
            // Codex review (P1): refresh decision MUST come from the
            // STORED claim's mode, not the new request's mode. Otherwise:
            //   - re-claiming a TTL claim with default args (no mode)
            //     resolves new mode = on_commit → would erase expires_at,
            //     leaving the TTL claim non-expiring.
            //   - re-claiming an on_commit claim with TTL args would
            //     stamp a non-null expires_at while the stored mode is
            //     still on_commit → mode/data drift.
            // Mode mismatch is silently ignored here; users must
            // release-and-reclaim to deliberately change a claim's mode.
            const storedRow = ctx.db
              .prepare(
                'SELECT auto_release_mode, expires_at FROM claims WHERE claim_id = ?1'
              )
              .get(existing.claim_id) as {
              auto_release_mode: string;
              expires_at: string | null;
            } | null;
            const storedMode = storedRow?.auto_release_mode ?? 'on_commit';
            const nowIso = new Date().toISOString();
            let refreshedExpiresAt: string | null;
            if (
              storedMode === 'ttl' &&
              resolvedMode === 'ttl' &&
              input.lease_seconds !== undefined
            ) {
              // Stored TTL claim, user explicitly re-asserted ttl + lease
              // → refresh expiry forward. last_edit_at also bumps.
              refreshedExpiresAt = new Date(
                Date.now() + leaseSeconds * 1000
              ).toISOString();
              ctx.db
                .prepare(
                  'UPDATE claims SET expires_at = ?1, last_edit_at = ?2 WHERE claim_id = ?3'
                )
                .run(refreshedExpiresAt, nowIso, existing.claim_id);
            } else {
              // Stored mode is on_commit/manual_only OR caller did not
              // re-assert TTL: leave expires_at untouched, just bump
              // last_edit_at to record the gate hit.
              refreshedExpiresAt = storedRow?.expires_at ?? null;
              ctx.db
                .prepare(
                  'UPDATE claims SET last_edit_at = ?1 WHERE claim_id = ?2'
                )
                .run(nowIso, existing.claim_id);
            }
            // F-NEW-3 (a)/(b): equal-shape or self-superset →
            // idempotent return of the existing claim. No event written.
            return {
              ok: true,
              data: {
                claim_id: existing.claim_id,
                expires_at: refreshedExpiresAt
              }
            } as ToolResponse<{
              claim_id: string;
              expires_at: string | null;
            }>;
          }
          // claim_scope.gate.foreign_conflict — self-widening also
          // surfaces as a 409 to the caller (release-and-reclaim).
          ctx.metrics.increment('claim_scope.gate.foreign_conflict');
          // F-NEW-3 (c) self-widening: existing scope is a strict
          // subset of the new scope (new path overlapped existing
          // claim, but existing did not cover all new paths). Caller
          // must release-and-reclaim with the wider scope.
          throw new ctx.ScopeConflictError({
            code: 'scope_conflict_self_widening',
            message: `New scope widens an existing self-claim ${selfHits[0]!.claim_id}; release it before claiming the wider scope`,
            conflicting_claim_id: selfHits[0]!.claim_id,
            conflicting_principal: input.principal,
            colliding_paths: ctx.dedupeSorted(
              selfHits.flatMap((h) => h.matched_target_paths)
            )
          });
        }

        // No overlap → write event + projection inside the SAME tx.
        // appendInTx is the sibling of append() that does NOT open a
        // nested transaction (resolves K3/H1).
        try {
          ctx.store.appendInTx(event);
        } catch (insertErr) {
          // F3 / AC16 / AC17: idempotency-collision recovery.
          // Default ON — flip to OFF only by setting TEAMEM_IDEMPOTENCY_RECOVERY=0.
          // Read per-call so tests can flip env without restart.
          if (process.env.TEAMEM_IDEMPOTENCY_RECOVERY === '0') {
            throw insertErr;
          }
          // Catch both SQLite UNIQUE constraint errors and the manual
          // "Idempotency conflict" throw in appendInTx (same-key, different event_id).
          const isIdempotencyError =
            insertErr instanceof Error &&
            (insertErr.message.includes('UNIQUE') ||
              insertErr.message.includes('SQLITE_CONSTRAINT') ||
              insertErr.message.includes('Idempotency conflict') ||
              (insertErr as NodeJS.ErrnoException).code ===
                'SQLITE_CONSTRAINT_UNIQUE' ||
              (insertErr as NodeJS.ErrnoException).code ===
                'SQLITE_CONSTRAINT');
          if (!isIdempotencyError) {
            throw insertErr;
          }
          // Look up the existing idempotency row.
          const existingRow = ctx.db
            .query(
              'SELECT event_id, created_at FROM idempotency_keys WHERE idempotency_key = ?1'
            )
            .get(idempotencyKey) as {
            event_id: string;
            created_at: string;
          } | null;
          if (!existingRow) {
            // Collision on events table but no idempotency_keys row — treat as non-recoverable.
            throw insertErr;
          }
          // The idempotency_key is derived deterministically from (space_id, principal,
          // normalized_scope_paths), so same key === same request shape. This is either
          // an idempotent retry (existing claim still active) OR a fresh acquisition
          // attempt after the prior claim has been released/expired.
          const storedEventRow = ctx.db
            .query('SELECT raw_json FROM events WHERE event_id = ?1')
            .get(existingRow.event_id) as { raw_json: string } | null;
          if (storedEventRow) {
            const storedEvent = JSON.parse(
              storedEventRow.raw_json
            ) as TeamemEvent;
            const storedClaimId =
              typeof storedEvent.payload === 'object' &&
              storedEvent.payload !== null &&
              'claim_id' in storedEvent.payload
                ? (storedEvent.payload as { claim_id: string }).claim_id
                : null;
            const storedExpiresAt =
              typeof storedEvent.payload === 'object' &&
              storedEvent.payload !== null &&
              'expires_at' in storedEvent.payload
                ? (storedEvent.payload as { expires_at: string }).expires_at
                : null;
            if (storedClaimId) {
              // Probe the projection: is the prior claim still active?
              // Terminal evidence is `released_at IS NOT NULL` OR an
              // expires_at in the past. If the projection row is missing,
              // the stored claim is invisible to list_claims and must be
              // treated as stale so recovery can acquire a fresh visible
              // claim. PRD §150: on_commit/manual_only claims have NULL
              // expires_at, so terminality must come from the projection
              // whenever the projection exists.
              const priorClaimRow = ctx.db
                .query(
                  'SELECT released_at, expires_at FROM claims WHERE claim_id = ?1'
                )
                .get(storedClaimId) as {
                released_at: string | null;
                expires_at: string | null;
              } | null;
              const nowMs = Date.now();
              const priorIsTerminal = priorClaimRow
                ? priorClaimRow.released_at !== null ||
                  (priorClaimRow.expires_at !== null &&
                    new Date(priorClaimRow.expires_at).getTime() < nowMs)
                : true;
              if (priorIsTerminal) {
                // Prior claim is released or expired — allow fresh
                // acquisition by salting the idempotency_key with the
                // new event_id so the unique constraint clears.
                event.idempotency_key = `${idempotencyKey}-${event.event_id.slice(0, 12)}`;
                ctx.store.appendInTx(event);
                ctx.applyProjectionUpdate(ctx.db, event);
                ctx.metrics.increment('claim_scope.gate.fresh_after_terminal');
                return {
                  ok: true,
                  data: { claim_id: claimId, expires_at: expiresAt }
                } as ToolResponse<{
                  claim_id: string;
                  expires_at: string | null;
                }>;
              }
              // Prior claim still active — idempotent retry semantics.
              ctx.metrics.increment('claim_scope.gate.idempotent_recovery');
              return {
                ok: true,
                data: {
                  claim_id: storedClaimId,
                  expires_at: storedExpiresAt
                }
              } as ToolResponse<{
                claim_id: string;
                expires_at: string | null;
              }>;
            }
          }
          // Stored event missing or malformed — surface idempotency_collision.
          return {
            ok: false,
            error: {
              code: 'idempotency_collision',
              message:
                'Idempotency-key reused with different payload. Likely a stale entry from a prior projection clear; clear the idempotency_keys row or follow the runbook.',
              idempotency_key: idempotencyKey,
              existing_created_at: existingRow.created_at,
              hint_doc_url:
                'https://github.com/RubiYH/teamem/blob/main/docs/troubleshooting.md'
            }
          } as ToolResponse<{
            claim_id: string;
            expires_at: string | null;
          }>;
        }
        ctx.applyProjectionUpdate(ctx.db, event);
        // claim_scope.gate.success — counter increment.
        ctx.metrics.increment('claim_scope.gate.success');
        return {
          ok: true,
          data: { claim_id: claimId, expires_at: expiresAt }
        } as ToolResponse<{ claim_id: string; expires_at: string | null }>;
      })
      .immediate();
  } catch (err) {
    if (err instanceof ctx.ScopeConflictError) {
      return { ok: false, error: err.payload };
    }
    throw err;
  } finally {
    // claim_scope.gate.tx_duration_ms — histogram observation.
    ctx.metrics.histogram(
      'claim_scope.gate.tx_duration_ms',
      performance.now() - txStartMs
    );
  }
}

export function releaseScope(
  ctx: ToolContext,
  input: {
    space_id: string;
    principal: string;
    actor: string;
    delegation: string;
    claim_id: string;
  }
): ToolResponse<{ released: boolean }> {
  const idempotencyKey = ctx.deterministicReleaseIdempotencyKey(
    input.space_id,
    input.principal,
    input.claim_id
  );
  // CRITICAL: keep .immediate() — see plan §4 / R-NEW-2.
  return ctx.db
    .transaction(() => {
      const row = ctx.db
        .query(
          `SELECT released_at, scope_json, sprint_id
             FROM claims
            WHERE claim_id = ?1
              AND space_id = ?2
              AND principal = ?3`
        )
        .get(input.claim_id, input.space_id, input.principal) as {
        released_at: string | null;
        scope_json: string;
        sprint_id: string | null;
      } | null;
      if (!row) {
        return ctx.toolError(
          'claim_not_found',
          `No active claim ${input.claim_id} owned by ${input.principal}`
        );
      }
      if (row.released_at !== null) {
        // Idempotent no-op — already released.
        return { ok: true, data: { released: true } };
      }
      const event: TeamemEvent = {
        schema_version: '1.0',
        event_id: ctx.newEventId(),
        idempotency_key: idempotencyKey,
        space_id: input.space_id,
        timestamp: new Date().toISOString(),
        principal: input.principal,
        actor: input.actor,
        delegation: input.delegation,
        event_type: 'scope_released',
        sprint_id: row.sprint_id,
        delivery_scope: row.sprint_id === null ? 'space' : 'sprint',
        scope: {},
        payload: { claim_id: input.claim_id }
      };
      ctx.store.appendInTx(event);
      ctx.applyProjectionUpdate(ctx.db, event);

      resolvePendingEditsForReleasedClaim(ctx, {
        space_id: input.space_id,
        principal: input.principal,
        actor: input.actor,
        delegation: input.delegation,
        claim_id: input.claim_id,
        sprint_id: row.sprint_id,
        released_paths: parseReleasedScopePaths(row.scope_json)
      });
      return { ok: true, data: { released: true } };
    })
    .immediate() as ToolResponse<{ released: boolean }>;
}

function parseReleasedScopePaths(scopeJson: string): string[] {
  try {
    const parsed = JSON.parse(scopeJson) as TeamemEvent['scope'];
    return Array.isArray(parsed.paths) ? parsed.paths : [];
  } catch {
    // Malformed legacy scope_json remains path-less; direct claim_id matches
    // can still resolve pending edits.
    return [];
  }
}

function resolvePendingEditsForReleasedClaim(
  ctx: ToolContext,
  input: {
    space_id: string;
    principal: string;
    actor: string;
    delegation: string;
    claim_id: string;
    sprint_id: string | null;
    released_paths: string[];
  }
): void {
  // Issue #10 — Mode 6.A resolve-on-release. Scan pending_edits for rows
  // whose blocking_claim_id matches OR whose paths overlap the released
  // scope; emit conflict_resolved per row in the same claim context.
  try {
    const resolvable = ctx.findResolvableByRelease(
      ctx.db,
      input.space_id,
      input.claim_id,
      input.released_paths,
      input.sprint_id
    );
    for (const pending of resolvable) {
      const resolvedAt = new Date().toISOString();
      const resolvedEvent: TeamemEvent = {
        schema_version: '1.0',
        event_id: ctx.newEventId(),
        idempotency_key: `idem-resolve-${pending.pending_id}`,
        space_id: input.space_id,
        timestamp: resolvedAt,
        principal: input.principal,
        actor: input.actor,
        delegation: input.delegation,
        event_type: 'conflict_resolved',
        sprint_id: pending.sprint_id,
        delivery_scope: 'direct',
        recipient_principals: [pending.blocked_principal],
        scope: { paths: pending.paths },
        payload: {
          pending_id: pending.pending_id,
          blocked_principal: pending.blocked_principal,
          blocking_claim_id: input.claim_id,
          previously_blocked_paths: pending.paths,
          now_free: true
        }
      };
      try {
        ctx.store.appendInTx(resolvedEvent);
        ctx.applyProjectionUpdate(ctx.db, resolvedEvent);
      } catch (err) {
        if (
          !isKnownPendingResolutionIdempotency(
            ctx,
            err,
            resolvedEvent.idempotency_key,
            pending.pending_id
          )
        ) {
          throw err;
        }
      }
    }
  } catch (err) {
    const e = err as { message?: string };
    if (!e?.message?.includes('no such table: pending_edits')) {
      throw err;
    }
    // Migration 006 not applied — pending_edits table absent in legacy
    // fixtures. Skip resolve-on-release silently.
  }
}

function isKnownPendingResolutionIdempotency(
  ctx: ToolContext,
  err: unknown,
  idempotencyKey: string,
  pendingId: string
): boolean {
  if (!(err instanceof Error)) return false;
  const message = err.message;
  const isIdempotencyError =
    message.includes('Idempotency conflict') ||
    message.includes('UNIQUE') ||
    message.includes('SQLITE_CONSTRAINT');
  if (!isIdempotencyError) return false;

  const row = ctx.db
    .prepare('SELECT event_id FROM idempotency_keys WHERE idempotency_key = ?1')
    .get(idempotencyKey) as { event_id: string } | null;
  if (!row) return false;
  const eventRow = ctx.db
    .prepare('SELECT payload_json FROM events WHERE event_id = ?1')
    .get(row.event_id) as { payload_json: string } | null;
  if (!eventRow) return false;
  try {
    const payload = JSON.parse(eventRow.payload_json) as {
      pending_id?: unknown;
    };
    return payload.pending_id === pendingId;
  } catch {
    return false;
  }
}

export function releaseScopeViaGit(
  ctx: ToolContext,
  input: {
    space_id: string;
    principal: string;
    actor: string;
    delegation: string;
    repo_id: string;
    branch: string;
    paths_with_status: Array<{
      status: 'M' | 'A' | 'D' | 'R';
      path: string;
      old_path?: string;
    }>;
    current_head_sha: string;
    porcelain_dirty_paths: string[];
  }
): ToolResponse<{ released: number; kept: number }> {
  if (!input.repo_id)
    return ctx.toolError('INVALID_PAYLOAD', 'repo_id is required', {});
  if (!input.branch)
    return ctx.toolError('INVALID_PAYLOAD', 'branch is required', {});
  if (!Array.isArray(input.paths_with_status))
    return ctx.toolError(
      'INVALID_PAYLOAD',
      'paths_with_status must be an array',
      {}
    );

  let released = 0;
  let kept = 0;

  type GitReleaseCandidate = {
    claim: {
      claim_id: string;
      status: string;
      auto_release_mode: string;
      head_sha_at_acquire: string | null;
      branch: string;
      path: string;
      scope_json: string;
      sprint_id: string | null;
    };
    evidence_targets: Array<{
      filePath: string;
      commitStatus: 'M' | 'A' | 'D' | 'R';
      porcelainDirty: boolean;
    }>;
  };

  return ctx.db
    .transaction(() => {
      const candidatesByClaimId = new Map<string, GitReleaseCandidate>();

      for (const entry of input.paths_with_status) {
        // For rename: release both old_path (status R) and new path (status R)
        const pathEntries: Array<{
          filePath: string;
          commitStatus: 'M' | 'A' | 'D' | 'R';
        }> = [{ filePath: entry.path, commitStatus: entry.status }];
        if (entry.old_path) {
          pathEntries.push({ filePath: entry.old_path, commitStatus: 'R' });
        }

        for (const { filePath, commitStatus } of pathEntries) {
          // Look up the claim whose scope contains filePath. The `path`
          // column on the projection only stores `paths[0]`, so a query
          // filtering on `path = ?` would miss multi-path claims when the
          // committed file is paths[1+]. json_each(scope_json) walks the
          // full scope.paths array and matches any entry.
          const claimRows = ctx.db
            .query(
              `SELECT c.claim_id, c.status, c.auto_release_mode, c.head_sha_at_acquire, c.branch, c.path, c.scope_json, c.sprint_id
               FROM claims c
              WHERE c.space_id = ?1
                AND c.principal = ?2
                AND c.repo_id = ?3
                AND c.branch = ?4
                AND c.status = 'active'
                AND c.tombstoned_at IS NULL
                AND (c.released_at IS NULL OR c.released_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                AND EXISTS (
                  SELECT 1 FROM json_each(json_extract(c.scope_json, '$.paths')) je
                   WHERE je.value = ?5
                )
              ORDER BY c.created_at ASC, c.claim_id ASC`
            )
            .all(
              input.space_id,
              input.principal,
              input.repo_id,
              input.branch,
              filePath
            ) as Array<{
            claim_id: string;
            status: string;
            auto_release_mode: string;
            head_sha_at_acquire: string | null;
            branch: string;
            path: string;
            scope_json: string;
            sprint_id: string | null;
          }>;

          for (const claimRow of claimRows) {
            const candidate = candidatesByClaimId.get(claimRow.claim_id) ?? {
              claim: claimRow,
              evidence_targets: []
            };
            candidate.evidence_targets.push({
              filePath,
              commitStatus,
              porcelainDirty: input.porcelain_dirty_paths.includes(filePath)
            });
            candidatesByClaimId.set(claimRow.claim_id, candidate);
          }
        }
      }

      for (const candidate of candidatesByClaimId.values()) {
        const { claim } = candidate;
        let releaseTarget: { filePath: string } | null = null;

        for (const target of candidate.evidence_targets) {
          const evidence = ctx.evaluateRelease(
            {
              head_sha_at_acquire: claim.head_sha_at_acquire,
              branch: claim.branch,
              // For multi-path claims, the committed file is the relevant
              // evidence target; claim.path only stores paths[0].
              path: target.filePath,
              auto_release_mode: claim.auto_release_mode as
                | 'on_commit'
                | 'manual_only'
                | 'ttl'
            },
            input.current_head_sha,
            target.porcelainDirty,
            input.branch,
            target.commitStatus
          );

          const result = ctx.claimTransition(
            {
              claim_id: claim.claim_id,
              status: claim.status,
              auto_release_mode: claim.auto_release_mode
            },
            { kind: 'release_via_git', evidence }
          );

          if (
            result.ok &&
            'nextStatus' in result &&
            result.nextStatus === 'released'
          ) {
            releaseTarget = {
              filePath: target.filePath
            };
            break;
          }
        }

        if (!releaseTarget) {
          kept++;
          continue;
        }

        const releaseEvent: TeamemEvent = {
          schema_version: '1.0',
          event_id: ctx.newEventId(),
          idempotency_key: `git-release-${claim.claim_id}-${input.current_head_sha}`,
          space_id: input.space_id,
          timestamp: new Date().toISOString(),
          principal: input.principal,
          actor: input.actor,
          delegation: input.delegation,
          event_type: 'scope_released_via_git',
          sprint_id: claim.sprint_id,
          delivery_scope: claim.sprint_id === null ? 'space' : 'sprint',
          scope: { paths: [releaseTarget.filePath] },
          payload: {
            claim_id: claim.claim_id,
            repo_id: input.repo_id,
            branch: input.branch,
            path: releaseTarget.filePath,
            head_sha: input.current_head_sha
          }
        };
        ctx.store.appendInTx(releaseEvent);
        ctx.db
          .prepare(
            `UPDATE claims SET status = 'released', released_at = ?1 WHERE claim_id = ?2`
          )
          .run(releaseEvent.timestamp, claim.claim_id);
        resolvePendingEditsForReleasedClaim(ctx, {
          space_id: input.space_id,
          principal: input.principal,
          actor: input.actor,
          delegation: input.delegation,
          claim_id: claim.claim_id,
          sprint_id: claim.sprint_id,
          released_paths: parseReleasedScopePaths(claim.scope_json)
        });
        released++;
      }
      return { ok: true, data: { released, kept } };
    })
    .immediate() as ToolResponse<{ released: number; kept: number }>;
}

export function forceRelease(
  ctx: ToolContext,
  input: {
    space_id: string;
    principal: string;
    actor: string;
    delegation: string;
    claim_id?: string;
    repo_id?: string;
    branch?: string;
    path?: string;
    target_principal?: string;
  }
): ToolResponse<{
  released: boolean;
  claim_id: string;
  original_holder: string;
  sprint_id: string | null;
  context: 'space' | 'sprint';
  idempotent?: boolean;
}> {
  const byClaimId = typeof input.claim_id === 'string' && input.claim_id !== '';
  if (!byClaimId) {
    if (!input.repo_id)
      return ctx.toolError('INVALID_PAYLOAD', 'repo_id is required', {});
    if (!input.branch)
      return ctx.toolError('INVALID_PAYLOAD', 'branch is required', {});
    if (!input.path)
      return ctx.toolError('INVALID_PAYLOAD', 'path is required', {});
    if (!input.target_principal)
      return ctx.toolError(
        'INVALID_PAYLOAD',
        'target_principal is required',
        {}
      );
  }
  const claimId = input.claim_id ?? '';
  const requestedRepoId = input.repo_id ?? '';
  const requestedBranch = input.branch ?? '';
  const requestedPath = input.path ?? '';
  const requestedTargetPrincipal = input.target_principal ?? '';
  const currentSprintId = ctx.readCurrentSprintId(
    ctx.db,
    input.space_id,
    input.principal
  );

  // codex-review fix (task #2): wrap in `.immediate()` to acquire
  // SQLite's RESERVED lock at BEGIN. Without it, two concurrent
  // force_release callers can both pass the existence check before
  // either UPDATE commits → 2 `claim_force_released` events emitted.
  // With .immediate(), the second tx blocks until the first commits,
  // then re-runs the SELECT and sees the now-released row → returns
  // an idempotent success (no event emitted).
  return ctx.db
    .transaction(() => {
      // SELECT runs inside the RESERVED-locked tx. Both `status = 'active'`
      // and the released_at guard ensure the second concurrent caller
      // sees no row after the first commits.
      const claim = (
        byClaimId
          ? ctx.db
              .prepare(
                `SELECT claim_id, principal, status, released_at, scope_json, repo_id, branch, path, sprint_id
                   FROM claims
                  WHERE space_id = ?1
                    AND claim_id = ?2
                    AND status IN ('active', 'paused')
                    AND (released_at IS NULL OR released_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                    AND tombstoned_at IS NULL
                  ORDER BY created_at DESC
                  LIMIT 1`
              )
              .get(input.space_id, claimId)
          : ctx.db
              .prepare(
                `SELECT claim_id, principal, status, released_at, scope_json, repo_id, branch, path, sprint_id
                   FROM claims
                  WHERE space_id = ?1
                    AND repo_id = ?2
                    AND branch = ?3
                    AND principal = ?5
                    AND ${currentSprintId === null ? 'sprint_id IS NULL' : 'sprint_id = ?6'}
                    AND status IN ('active', 'paused')
                    AND (path = ?4 OR EXISTS (
                      SELECT 1
                        FROM json_each(json_extract(scope_json, '$.paths')) je
                       WHERE je.value = ?4
                    ))
                    AND (released_at IS NULL OR released_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                    AND tombstoned_at IS NULL
                  ORDER BY created_at DESC
                  LIMIT 1`
              )
              .get(
                ...(currentSprintId === null
                  ? [
                      input.space_id,
                      requestedRepoId,
                      requestedBranch,
                      requestedPath,
                      requestedTargetPrincipal
                    ]
                  : [
                      input.space_id,
                      requestedRepoId,
                      requestedBranch,
                      requestedPath,
                      requestedTargetPrincipal,
                      currentSprintId
                    ])
              )
      ) as {
        claim_id: string;
        principal: string;
        status: string;
        released_at: string | null;
        scope_json: string;
        repo_id: string;
        branch: string;
        path: string;
        sprint_id: string | null;
      } | null;

      if (!claim) {
        // Idempotency window: was the claim already force-released by a
        // peer? Surface a typed idempotent-success rather than
        // claim_not_found so concurrent callers all observe the same
        // released-once outcome.
        const recentlyReleased = (
          byClaimId
            ? ctx.db
                .prepare(
                  `SELECT claim_id, principal, sprint_id FROM claims
                    WHERE space_id = ?1
                      AND claim_id = ?2
                      AND status = 'released'
                      AND tombstoned_at IS NULL
                    ORDER BY released_at DESC
                    LIMIT 1`
                )
                .get(input.space_id, claimId)
            : ctx.db
                .prepare(
                  `SELECT claim_id, principal, sprint_id FROM claims
                    WHERE space_id = ?1
                      AND repo_id = ?2
                      AND branch = ?3
                      AND principal = ?5
                      AND ${currentSprintId === null ? 'sprint_id IS NULL' : 'sprint_id = ?6'}
                      AND status = 'released'
                      AND (path = ?4 OR EXISTS (
                        SELECT 1
                          FROM json_each(json_extract(scope_json, '$.paths')) je
                         WHERE je.value = ?4
                      ))
                      AND tombstoned_at IS NULL
                    ORDER BY released_at DESC
                    LIMIT 1`
                )
                .get(
                  ...(currentSprintId === null
                    ? [
                        input.space_id,
                        requestedRepoId,
                        requestedBranch,
                        requestedPath,
                        requestedTargetPrincipal
                      ]
                    : [
                        input.space_id,
                        requestedRepoId,
                        requestedBranch,
                        requestedPath,
                        requestedTargetPrincipal,
                        currentSprintId
                      ])
                )
        ) as {
          claim_id: string;
          principal: string;
          sprint_id: string | null;
        } | null;

        if (recentlyReleased) {
          return {
            ok: true as const,
            data: {
              released: true,
              claim_id: recentlyReleased.claim_id,
              original_holder: recentlyReleased.principal,
              sprint_id: recentlyReleased.sprint_id,
              context: recentlyReleased.sprint_id === null ? 'space' : 'sprint',
              idempotent: true
            }
          };
        }

        return ctx.toolError(
          'claim_not_found',
          byClaimId
            ? `No active or paused claim ${claimId}`
            : `No active or paused claim held by ${requestedTargetPrincipal} on ${requestedPath} (branch=${requestedBranch})`
        );
      }

      const now = new Date().toISOString();
      const eventId = ctx.newEventId();
      const idempotencyKey = `force-release-${claim.claim_id}-${input.principal}`;
      let fallbackPath = claim.path;
      try {
        const parsed = JSON.parse(claim.scope_json) as TeamemEvent['scope'];
        fallbackPath =
          fallbackPath ||
          (Array.isArray(parsed.paths) && typeof parsed.paths[0] === 'string'
            ? parsed.paths[0]
            : '');
      } catch {
        // Keep the projection-owned path if legacy scope_json is malformed.
      }
      const releasedPath = byClaimId
        ? fallbackPath
        : (input.path ?? fallbackPath);
      const releasedRepoId = byClaimId
        ? claim.repo_id
        : (input.repo_id ?? claim.repo_id);
      const releasedBranch = byClaimId
        ? claim.branch
        : (input.branch ?? claim.branch);

      const event: TeamemEvent = {
        schema_version: '1.0',
        event_id: eventId,
        idempotency_key: idempotencyKey,
        space_id: input.space_id,
        timestamp: now,
        principal: input.principal,
        actor: input.actor,
        delegation: input.delegation,
        event_type: 'claim_force_released',
        sprint_id: claim.sprint_id,
        delivery_scope: 'direct',
        recipient_principals: [claim.principal],
        scope: releasedPath ? { paths: [releasedPath] } : {},
        payload: {
          claim_id: claim.claim_id,
          repo_id: releasedRepoId,
          branch: releasedBranch,
          path: releasedPath,
          released_by: input.principal,
          original_holder: claim.principal,
          released_at: now
        }
      };

      ctx.store.appendInTx(event);

      ctx.db
        .prepare(
          `UPDATE claims SET status = 'released', released_at = ?1 WHERE claim_id = ?2`
        )
        .run(now, claim.claim_id);

      // Durable fallback: always enqueue the unread notification.
      // Cursor freshness alone is not a modeled live-delivery signal in
      // this server layer, so it must not suppress the offline queue.
      try {
        ctx.db
          .prepare(
            `INSERT OR IGNORE INTO unread_notifications
         (space_id, principal, event_id, event_type, payload_json, created_at, delivered_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL)`
          )
          .run(
            input.space_id,
            claim.principal,
            eventId,
            'claim_force_released',
            JSON.stringify(event.payload),
            now
          );
      } catch (err) {
        const e = err as { message?: string };
        if (!e?.message?.includes('no such table: unread_notifications'))
          throw err;
      }

      return {
        ok: true as const,
        data: {
          released: true,
          claim_id: claim.claim_id,
          original_holder: claim.principal,
          sprint_id: claim.sprint_id,
          context: claim.sprint_id === null ? 'space' : 'sprint'
        }
      };
    })
    .immediate() as ToolResponse<{
    released: boolean;
    claim_id: string;
    original_holder: string;
    sprint_id: string | null;
    context: 'space' | 'sprint';
    idempotent?: boolean;
  }>;
}

export function pauseClaimsForBranch(
  ctx: ToolContext,
  input: {
    space_id: string;
    principal: string;
    actor: string;
    delegation: string;
    repo_id: string;
    branch: string;
    reason: string;
  }
): ToolResponse<{ paused_count: number }> {
  if (!input.repo_id)
    return ctx.toolError('INVALID_PAYLOAD', 'repo_id is required', {});
  if (!input.branch)
    return ctx.toolError('INVALID_PAYLOAD', 'branch is required', {});

  // codex-review fix (task #3): wrap in `.immediate()` to acquire
  // SQLite's RESERVED lock at BEGIN. The previous fetch-then-iterate
  // approach inside a deferred tx allowed a concurrent claimScope to
  // slip a new active claim between the SELECT and the loop's
  // last iteration → the new claim escaped the pause.
  //
  // Fix: re-SELECT inside the locked tx (the lock blocks concurrent
  // writers), capture all matching claim_ids, then UPDATE them all
  // and emit one claim_paused event per affected row — all atomically.
  return ctx.db
    .transaction(() => {
      const now = new Date().toISOString();

      // Single SELECT inside the RESERVED-locked tx. Any concurrent
      // claimScope is now blocked until this tx commits, so no new
      // active claim can land on (repo_id, branch) for this principal
      // mid-flight.
      const claims = ctx.db
        .prepare(
          `SELECT claim_id, path FROM claims
        WHERE space_id = ?1
          AND principal = ?2
          AND repo_id = ?3
          AND branch = ?4
          AND status = 'active'
          AND paused_at IS NULL
          AND tombstoned_at IS NULL`
        )
        .all(
          input.space_id,
          input.principal,
          input.repo_id,
          input.branch
        ) as Array<{ claim_id: string; path: string }>;

      if (claims.length === 0)
        return { ok: true as const, data: { paused_count: 0 } };

      // Single bulk UPDATE under the same lock. The WHERE-guard
      // (status='active' AND paused_at IS NULL) defends against the
      // already-paused / already-released cases for defense-in-depth.
      const updateStmt = ctx.db.prepare(
        `UPDATE claims
         SET paused_at = ?1, paused_reason = ?2
       WHERE claim_id = ?3
         AND status = 'active'
         AND paused_at IS NULL
         AND tombstoned_at IS NULL`
      );
      for (const claim of claims) {
        updateStmt.run(now, input.reason, claim.claim_id);

        const event: TeamemEvent = {
          schema_version: '1.0',
          event_id: ctx.newEventId(),
          // Codex review (P1): include the transition timestamp so each
          // pause→resume→pause cycle gets a distinct key. With only
          // (claim_id, principal), the second pause after a resume would
          // collide with the first pause's key and crash the txn,
          // breaking branch-switch hooks after one cycle.
          idempotency_key: `pause-${claim.claim_id}-${input.principal}-${now}`,
          space_id: input.space_id,
          timestamp: now,
          principal: input.principal,
          actor: input.actor,
          delegation: input.delegation,
          event_type: 'claim_paused',
          ...ctx.routingMetadataForPrincipal(ctx.db, input, {
            delivery: 'broadcast'
          }),
          scope: { paths: [claim.path] },
          payload: {
            claim_id: claim.claim_id,
            repo_id: input.repo_id,
            branch: input.branch,
            paused_at: now,
            paused_reason: input.reason
          }
        };
        ctx.store.appendInTx(event);
      }

      return { ok: true, data: { paused_count: claims.length } };
    })
    .immediate() as ToolResponse<{ paused_count: number }>;
}

export function resumeClaimsForBranch(
  ctx: ToolContext,
  input: {
    space_id: string;
    principal: string;
    actor: string;
    delegation: string;
    repo_id: string;
    branch: string;
  }
): ToolResponse<{ resumed_count: number }> {
  if (!input.repo_id)
    return ctx.toolError('INVALID_PAYLOAD', 'repo_id is required', {});
  if (!input.branch)
    return ctx.toolError('INVALID_PAYLOAD', 'branch is required', {});

  return ctx.db
    .transaction(() => {
      const claims = ctx.db
        .prepare(
          `SELECT claim_id, path FROM claims
        WHERE space_id = ?1
          AND principal = ?2
          AND repo_id = ?3
          AND branch = ?4
          AND status = 'active'
          AND paused_at IS NOT NULL
          AND tombstoned_at IS NULL`
        )
        .all(
          input.space_id,
          input.principal,
          input.repo_id,
          input.branch
        ) as Array<{ claim_id: string; path: string }>;

      if (claims.length === 0)
        return { ok: true as const, data: { resumed_count: 0 } };

      const now = new Date().toISOString();
      for (const claim of claims) {
        ctx.db
          .prepare(
            `UPDATE claims SET paused_at = NULL, paused_reason = NULL WHERE claim_id = ?1`
          )
          .run(claim.claim_id);

        const event: TeamemEvent = {
          schema_version: '1.0',
          event_id: ctx.newEventId(),
          // Codex review (P1): include the transition timestamp so each
          // resume→pause→resume cycle gets a distinct key. See the pause
          // tool above for the full rationale.
          idempotency_key: `resume-${claim.claim_id}-${input.principal}-${now}`,
          space_id: input.space_id,
          timestamp: now,
          principal: input.principal,
          actor: input.actor,
          delegation: input.delegation,
          event_type: 'claim_resumed',
          ...ctx.routingMetadataForPrincipal(ctx.db, input, {
            delivery: 'broadcast'
          }),
          scope: { paths: [claim.path] },
          payload: {
            claim_id: claim.claim_id,
            repo_id: input.repo_id,
            branch: input.branch,
            resumed_at: now
          }
        };
        ctx.store.appendInTx(event);
      }

      return { ok: true, data: { resumed_count: claims.length } };
    })
    .immediate() as ToolResponse<{ resumed_count: number }>;
}

export function fetchUnreadNotifications(
  ctx: ToolContext,
  input: {
    space_id: string;
    principal: string;
  }
): ToolResponse<{
  notifications: Array<{
    event_id: string;
    event_type: string;
    payload: Record<string, unknown>;
    created_at: string;
  }>;
}> {
  // Codex round-2 review fix (#16): wrap SELECT-then-UPDATE in
  // `ctx.db.transaction(...).immediate()` to acquire SQLite's RESERVED lock at
  // BEGIN. Two concurrent fetches by the same principal could both SELECT
  // identical undelivered rows before either UPDATE committed → the same
  // notification surfaced twice. Under .immediate(), the second tx blocks
  // until the first commits, then re-runs the SELECT and sees no
  // undelivered rows.
  try {
    return ctx.db
      .transaction(() => {
        const rows = ctx.db
          .prepare(
            `SELECT event_id, event_type, payload_json, created_at
           FROM unread_notifications
          WHERE space_id = ?1
            AND principal = ?2
            AND delivered_at IS NULL
          ORDER BY created_at ASC`
          )
          .all(input.space_id, input.principal) as Array<{
          event_id: string;
          event_type: string;
          payload_json: string;
          created_at: string;
        }>;

        if (rows.length > 0) {
          const deliveredAt = new Date().toISOString();
          const updateStmt = ctx.db.prepare(
            `UPDATE unread_notifications
              SET delivered_at = ?1
            WHERE event_id = ?2
              AND principal = ?3
              AND delivered_at IS NULL`
          );
          for (const row of rows) {
            updateStmt.run(deliveredAt, row.event_id, input.principal);
          }
        }

        return {
          ok: true as const,
          data: {
            notifications: rows.map((r) => ({
              event_id: r.event_id,
              event_type: r.event_type,
              payload: JSON.parse(r.payload_json) as Record<string, unknown>,
              created_at: r.created_at
            }))
          }
        };
      })
      .immediate() as ToolResponse<{
      notifications: Array<{
        event_id: string;
        event_type: string;
        payload: Record<string, unknown>;
        created_at: string;
      }>;
    }>;
  } catch (err) {
    const e = err as { message?: string };
    if (e?.message?.includes('no such table: unread_notifications')) {
      return { ok: true, data: { notifications: [] } };
    }
    throw err;
  }
}

export function listClaims(
  ctx: ToolContext,
  input: {
    space_id: string;
    principal: string;
    scope: 'self' | 'space';
    view?: 'current' | 'space' | 'outside_current_context';
  }
): ToolResponse<{
  claims: Array<{
    claim_id: string;
    principal: string;
    repo_id: string;
    branch: string;
    path: string;
    mode: string;
    status: string;
    paused_at: string | null;
    paused_reason: string | null;
    created_at: string;
    last_edit_at: string | null;
    expires_at: string | null;
    sprint_id: string | null;
    context: 'space' | 'sprint';
  }>;
}> {
  const validScopes = ['self', 'space'];
  if (!validScopes.includes(input.scope)) {
    return ctx.toolError(
      'INVALID_PAYLOAD',
      'scope must be "self" or "space"',
      {}
    );
  }
  const view = input.view ?? 'current';
  const validViews = ['current', 'space', 'outside_current_context'];
  if (!validViews.includes(view)) {
    return ctx.toolError(
      'INVALID_PAYLOAD',
      'view must be "current", "space", or "outside_current_context"',
      {}
    );
  }
  const currentSprintId = ctx.readCurrentSprintId(
    ctx.db,
    input.space_id,
    input.principal
  );
  if (view === 'outside_current_context' && currentSprintId === null) {
    return {
      ok: true,
      data: { claims: [] }
    };
  }
  const predicates: string[] = ['space_id = ?'];
  const params: string[] = [input.space_id];
  if (input.scope === 'self') {
    predicates.push('principal = ?');
    params.push(input.principal);
  }
  if (view === 'space') {
    predicates.push('sprint_id IS NULL');
  } else if (view === 'outside_current_context') {
    predicates.push('principal = ?');
    predicates.push('(sprint_id IS NULL OR sprint_id != ?)');
    params.push(input.principal, currentSprintId ?? '');
  } else if (currentSprintId === null) {
    predicates.push('sprint_id IS NULL');
  } else {
    predicates.push('sprint_id = ?');
    params.push(currentSprintId);
  }

  const rows = (
    input.scope === 'self'
      ? ctx.db
          .prepare(
            `SELECT claim_id, principal, repo_id, branch, path, auto_release_mode,
                status, paused_at, paused_reason, created_at, last_edit_at, expires_at, sprint_id
           FROM claims
          WHERE ${predicates.join(' AND ')}
            AND status IN ('active', 'paused')
            AND tombstoned_at IS NULL
          ORDER BY created_at ASC`
          )
          .all(...params)
      : ctx.db
          .prepare(
            `SELECT claim_id, principal, repo_id, branch, path, auto_release_mode,
                status, paused_at, paused_reason, created_at, last_edit_at, expires_at, sprint_id
           FROM claims
          WHERE ${predicates.join(' AND ')}
            AND status IN ('active', 'paused')
            AND tombstoned_at IS NULL
          ORDER BY principal ASC, created_at ASC`
          )
          .all(...params)
  ) as Array<{
    claim_id: string;
    principal: string;
    repo_id: string;
    branch: string;
    path: string;
    auto_release_mode: string;
    status: string;
    paused_at: string | null;
    paused_reason: string | null;
    created_at: string;
    last_edit_at: string | null;
    expires_at: string | null;
    sprint_id: string | null;
  }>;

  return {
    ok: true,
    data: {
      claims: rows.map((r) => ({
        claim_id: r.claim_id,
        principal: r.principal,
        repo_id: r.repo_id,
        branch: r.branch,
        path: r.path,
        mode: r.auto_release_mode,
        status: r.paused_at != null ? 'paused' : r.status,
        paused_at: r.paused_at ?? null,
        paused_reason: r.paused_reason ?? null,
        created_at: r.created_at,
        last_edit_at: r.last_edit_at ?? null,
        expires_at: r.expires_at ?? null,
        sprint_id: r.sprint_id ?? null,
        context: r.sprint_id === null ? 'space' : 'sprint'
      }))
    }
  };
}
