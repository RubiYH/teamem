import { nanoid } from 'nanoid';
import type { TeamemEvent } from '../../domain/events/types.js';
import { validateEvent } from '../../domain/events/validate.js';
import { evaluateRelease } from '../../domain/git-evidence.js';
import { transition as claimTransition } from '../../domain/claim-lifecycle.js';
import { applyProjectionUpdate } from '../../infra/projections/apply-event.js';
import type { SqliteEventStore } from '../../infra/db/sqlite-event-store.js';
import type { Database } from 'bun:sqlite';
import { toolError, ScopeConflictError } from '../errors.js';
import { metrics } from '../metrics.js';
import type { ToolResponse } from '../types.js';
import {
  findOverlappingActiveClaims,
  normalizePathPattern,
  type ActiveClaimRow,
  type OverlapHit
} from '../../domain/conflicts/index.js';
import {
  newEventId,
  newClaimId,
  newIdempotencyKey,
  deterministicClaimIdempotencyKey,
  deterministicReleaseIdempotencyKey,
  deterministicMessageIdempotencyKey
} from '../../domain/ids.js';
import {
  DEFAULT_DISPUTE_CONFIG,
  applyMove,
  checkTermination,
  initialState,
  validateMove,
  validateTerminationsEnabled,
  type DisputeConfig,
  type DisputeState,
  type MoveType,
  type Side,
  type TerminationCondition
} from '../../domain/disputes/state-machine.js';
import { ulid } from 'ulidx';
import { buildBriefing } from './briefing.js';
import {
  buildSpaceRulesSnapshot,
  canonicalRulesBody,
  stableRulesHash,
  type SpaceRulesSnapshotResponse
} from './space-rules.js';
import {
  isCoordPref,
  normalizeCoordPref,
  type CoordPref
} from '../../domain/conflicts/coord-pref.js';
import { findResolvableByRelease } from '../../domain/conflicts/pending-edits.js';
import { kickMember, leaveSpace, rotateRoomCode } from '../spaces.js';
import {
  canonicalScopePaths,
  computeScopeHash
} from '../../domain/focus/scope-hash.js';
import {
  narrowClaimPaths,
  hasOverlap
} from '../../domain/conflicts/narrow-claim.js';
/**
 * Issue #11 legacy/internal permission primitive — in-process waker registry.
 * The `requestEditPermission` long-poll registers a waker keyed on `req_id`;
 * `respondPermissionRequest` (or the 60s timeout) fires it. The request
 * path also polls the durable `permission_requests` projection so grants
 * handled by another Bun process still wake the blocked edit hook.
 */
export type PermissionResolution =
  | { action: 'allow'; claim_id: string; expires_at: string }
  | { action: 'skip'; reason: 'denied_by_incumbent' | 'timeout' };

const permissionWakers = new Map<string, (r: PermissionResolution) => void>();
export const DEFAULT_PERMISSION_REQUEST_TIMEOUT_MS = 60_000;

export type ToolDeps = {
  store: SqliteEventStore;
  db: Database;
};

type SpaceRulesProjectionRow = {
  rules_markdown: string;
  rules_version: number;
  source_event_id: string | null;
  updated_at: string;
  updated_by: string | null;
  is_disabled: number;
};

type CurrentSpaceRulesState = {
  body: string;
  version: number;
  hash: string;
  hasServerRules: boolean;
  sourceEventId: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
};

type DecisionReplayNotification = {
  event_id: string;
  event_type: 'decision_published' | 'decision_amended' | 'decision_superseded';
  principal: string;
  created_at: string;
  payload: {
    decision_id: string;
    title: string;
    summary: string;
    body: string;
    kind: string;
    version: number;
    superseded_by_decision_id?: string | null;
    predecessor_decision_id?: string | null;
  };
};

export type SessionSyncResponse = {
  space_rules_snapshot: SpaceRulesSnapshotResponse;
  decisions: DecisionReplayNotification[];
  decision_replays: DecisionReplayNotification[];
  gotcha_notices: GotchaNotice[];
};

export type GotchaNotice = {
  event_id: string;
  event_type: 'gotcha_notice';
  payload: {
    finding_id: string;
    version: number;
    summary: string;
    severity: 'info' | 'warning' | 'urgent';
    paths: string[];
    tags: string[];
    recipient_mode: 'broadcast' | 'direct';
    recipient_principals: string[];
    relevance: 'direct_target' | 'urgent' | 'path_overlap' | 'tag_overlap';
  };
  created_at: string;
};

export type DiscussionThreadMetadata = {
  thread_id: string;
  space_id: string;
  visibility_mode: 'broadcast' | 'direct';
  participant_principals: string[];
};

/**
 * Test-only synchronous seam used by AC-NEW-2 to prove SELECT-then-INSERT
 * atomicity. Fires *inside* the gate transaction, AFTER the SELECT and
 * BEFORE any INSERT. Production callers MUST NOT pass this.
 *
 * MUST be sync — `bun:sqlite`'s `db.transaction(fn)` callback is sync;
 * awaiting a Promise here lets the tx commit before the seam runs and
 * defeats the AC.
 */
export type ClaimScopeTestHooks = {
  afterSelectHook?: () => void;
};

/**
 * Sorted+deduplicated normalized form of `scope.paths`. Used for the
 * deterministic idempotency-key derivation (F-NEW-3) and the self-superset
 * idempotency comparison.
 */
function normalizeScopePaths(paths: readonly string[] | undefined): string[] {
  if (!paths || paths.length === 0) return [];
  const set = new Set<string>();
  for (const p of paths) set.add(normalizePathPattern(p));
  return Array.from(set).sort();
}

function dedupeSorted(values: readonly string[]): string[] {
  return Array.from(new Set(values)).sort();
}

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function parseFindingRefs(input: unknown): {
  paths?: string[];
  modules?: string[];
} {
  if (!input || typeof input !== 'object') return {};
  const refs = input as { paths?: unknown; modules?: unknown };
  const paths = parseStringArray(refs.paths);
  const modules = parseStringArray(refs.modules);
  return {
    ...(paths.length > 0 ? { paths } : {}),
    ...(modules.length > 0 ? { modules } : {})
  };
}

function parseFindingPaths(
  directPaths: unknown,
  refs: { paths?: string[] }
): string[] {
  const direct = parseStringArray(directPaths);
  if (direct.length > 0) return Array.from(new Set(direct));
  if (refs.paths && refs.paths.length > 0)
    return Array.from(new Set(refs.paths));
  return [];
}

function parseJsonStringArray(raw: string | null): string[] {
  if (!raw || raw.length === 0) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function parseNullableFindingRefs(
  raw: string | null
): { paths?: string[]; modules?: string[] } | null {
  if (!raw) return null;
  try {
    const refs = parseFindingRefs(JSON.parse(raw) as unknown);
    return Object.keys(refs).length > 0 ? refs : null;
  } catch {
    return null;
  }
}

function loadDiscussionThreadMetadata(
  db: Database,
  space_id: string,
  thread_id: string
): DiscussionThreadMetadata | null {
  try {
    const row = db
      .prepare(
        `SELECT thread_id, space_id, visibility_mode, participant_principals_json
           FROM discussion_threads
          WHERE space_id = ?1 AND thread_id = ?2
          LIMIT 1`
      )
      .get(space_id, thread_id) as {
      thread_id: string;
      space_id: string;
      visibility_mode: string;
      participant_principals_json: string;
    } | null;
    if (!row) return null;
    return {
      thread_id: row.thread_id,
      space_id: row.space_id,
      visibility_mode:
        row.visibility_mode === 'broadcast' ? 'broadcast' : 'direct',
      participant_principals: dedupeSorted(
        parseJsonStringArray(row.participant_principals_json)
      )
    };
  } catch (err) {
    const e = err as { message?: string };
    if (e?.message?.includes('no such table: discussion_threads')) {
      return deriveLegacyDiscussionThreadMetadata(db, space_id, thread_id);
    }
    throw err;
  }
}

function deriveLegacyDiscussionThreadMetadata(
  db: Database,
  space_id: string,
  thread_id: string
): DiscussionThreadMetadata | null {
  try {
    const rows = db
      .prepare(
        `SELECT sender_principal, recipient_principal
           FROM discussions
          WHERE space_id = ?1 AND thread_id = ?2 AND tombstoned_at IS NULL
          ORDER BY created_at ASC, message_id ASC`
      )
      .all(space_id, thread_id) as Array<{
      sender_principal: string;
      recipient_principal: string | null;
    }>;
    if (rows.length === 0) return null;
    const isBroadcast = rows.some((row) => row.recipient_principal == null);
    return {
      thread_id,
      space_id,
      visibility_mode: isBroadcast ? 'broadcast' : 'direct',
      participant_principals: isBroadcast
        ? []
        : dedupeSorted(
            rows.flatMap((row) =>
              [row.sender_principal, row.recipient_principal].filter(
                (value): value is string => !!value
              )
            )
          )
    };
  } catch (err) {
    const e = err as { message?: string };
    if (e?.message?.includes('no such table: discussions')) return null;
    throw err;
  }
}

function readDiscussionHelperPolicy(input: unknown):
  | {
      helper_policy: {
        decision: 'autonomous_safe' | 'human_approved';
        reason: string;
      };
    }
  | {} {
  if (!input || typeof input !== 'object') return {};
  const raw = input as {
    policy_decision?: unknown;
    policy_reason?: unknown;
  };
  if (
    (raw.policy_decision === 'autonomous_safe' ||
      raw.policy_decision === 'human_approved') &&
    typeof raw.policy_reason === 'string' &&
    raw.policy_reason.trim().length > 0
  ) {
    return {
      helper_policy: {
        decision: raw.policy_decision,
        reason: raw.policy_reason.trim()
      }
    };
  }
  return {};
}

function getSpaceMembershipStatus(
  db: Database,
  space_id: string,
  principal: string
): 'active' | 'inactive' | 'unknown' {
  try {
    const active = db
      .prepare(
        `SELECT 1
           FROM members
          WHERE space_id = ?1 AND name = ?2 AND left_at IS NULL
          LIMIT 1`
      )
      .get(space_id, principal);
    if (active) return 'active';

    const anyActiveMember = db
      .prepare(
        `SELECT 1
           FROM members
          WHERE space_id = ?1 AND left_at IS NULL
          LIMIT 1`
      )
      .get(space_id);
    return anyActiveMember ? 'inactive' : 'unknown';
  } catch (err) {
    const e = err as { message?: string };
    if (e?.message?.includes('no such table: members')) return 'unknown';
    throw err;
  }
}

export class SprintContextLookupError extends Error {
  readonly reason: string;

  constructor(error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    super('failed to read current Sprint membership');
    this.name = 'SprintContextLookupError';
    this.reason = reason;
  }
}

function isMissingSprintContextTableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.message.includes('no such table: sprint_memberships') ||
    error.message.includes('no such table: sprints')
  );
}

function readCurrentSprintId(
  db: Database,
  spaceId: string,
  principal: string
): string | null {
  try {
    const row = db
      .prepare(
        `SELECT sm.sprint_id
           FROM sprint_memberships sm
           JOIN sprints s ON s.sprint_id = sm.sprint_id
          WHERE sm.space_id = ?1
            AND sm.principal = ?2
            AND sm.sprint_id IS NOT NULL
            AND s.status = 'active'
          LIMIT 1`
      )
      .get(spaceId, principal) as { sprint_id: string } | null;
    return row?.sprint_id ?? null;
  } catch (error) {
    if (isMissingSprintContextTableError(error)) return null;
    throw error;
  }
}

function routingMetadataForPrincipal(
  db: Database,
  input: { space_id: string; principal: string },
  options:
    | { delivery: 'direct'; recipient_principals: string[] }
    | { delivery: 'broadcast' }
    | { delivery: 'space' }
): Pick<TeamemEvent, 'sprint_id' | 'delivery_scope' | 'recipient_principals'> {
  if (options.delivery === 'space') {
    return { sprint_id: null, delivery_scope: 'space' };
  }

  let sprintId: string | null;
  try {
    sprintId = readCurrentSprintId(db, input.space_id, input.principal);
  } catch (error) {
    throw new SprintContextLookupError(error);
  }
  if (options.delivery === 'direct') {
    return {
      sprint_id: sprintId,
      delivery_scope: 'direct',
      recipient_principals: dedupeSorted(options.recipient_principals)
    };
  }

  return sprintId
    ? { sprint_id: sprintId, delivery_scope: 'sprint' }
    : { sprint_id: null, delivery_scope: 'space' };
}

function authorizeDiscussionThreadAccess(
  db: Database,
  space_id: string,
  principal: string,
  thread: DiscussionThreadMetadata
): { allowed: boolean } {
  const membershipStatus = getSpaceMembershipStatus(db, space_id, principal);
  if (membershipStatus === 'inactive') return { allowed: false };
  if (thread.visibility_mode === 'broadcast') {
    return { allowed: true };
  }
  return {
    allowed: thread.participant_principals.includes(principal)
  };
}

function resolveDirectReplyRecipient(
  senderPrincipal: string,
  requestedRecipient: string | null | undefined,
  participantPrincipals: string[]
): string | Error {
  const otherParticipants = participantPrincipals.filter(
    (participant) => participant !== senderPrincipal
  );
  if (otherParticipants.length === 0) {
    return new Error('direct thread has no remaining recipient');
  }
  if (requestedRecipient == null) {
    if (otherParticipants.length === 1) return otherParticipants[0]!;
    return new Error(
      'recipient_principal is required when the direct thread has multiple recipients'
    );
  }
  if (!participantPrincipals.includes(requestedRecipient)) {
    return new Error(
      'recipient_principal must stay within the parent thread participants'
    );
  }
  if (requestedRecipient === senderPrincipal) {
    return new Error(
      'recipient_principal must target another participant in the thread'
    );
  }
  return requestedRecipient;
}

/**
 * F-NEW-4 SELECT predicate: only `status='active'` rows in the target
 * space whose `released_at` is null/future AND `expires_at` is null/future
 * participate in the overlap gate.
 *
 * When repoId and branch are provided (slice #29), the query pre-filters to
 * only claims on the same (repo_id, branch). A claim on a different branch
 * is not a conflict. Legacy rows with empty repo_id/branch are always included
 * to preserve backward compat.
 */
function selectActiveClaimsForOverlap(
  db: Database,
  spaceId: string,
  sprintId: string | null,
  repoId?: string,
  branch?: string
): ActiveClaimRow[] {
  const useBranchFilter =
    repoId !== undefined &&
    branch !== undefined &&
    repoId !== '' &&
    branch !== '';
  let sql = `SELECT claim_id, principal, scope_json, expires_at
         FROM claims
        WHERE space_id = ?1
          AND status = 'active'
          AND tombstoned_at IS NULL
          AND (released_at IS NULL OR released_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
          AND (expires_at IS NULL OR expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;
  const params: Array<string> = [spaceId];
  if (sprintId === null) {
    sql += ' AND sprint_id IS NULL';
  } else {
    sql += ` AND sprint_id = ?${params.length + 1}`;
    params.push(sprintId);
  }
  if (useBranchFilter) {
    sql += ` AND (repo_id = '' OR repo_id = ?${params.length + 1})
             AND (branch = '' OR branch = ?${params.length + 2})`;
    params.push(repoId!, branch!);
  }
  const rows = db.query(sql).all(...params) as Array<{
    claim_id: string;
    principal: string;
    scope_json: string;
    expires_at: string | null;
  }>;
  return rows.map((r) => {
    const parsed = JSON.parse(r.scope_json) as TeamemEvent['scope'];
    return {
      claim_id: r.claim_id,
      principal: r.principal,
      scope_paths: parsed.paths ?? [],
      expires_at: r.expires_at ?? undefined
    };
  });
}

function getPausedAtForClaim(
  db: Database,
  claimId: string
): { paused_at: string | null; paused_reason: string | null } {
  const row = db
    .query('SELECT paused_at, paused_reason FROM claims WHERE claim_id = ?1')
    .get(claimId) as {
    paused_at: string | null;
    paused_reason: string | null;
  } | null;
  return row ?? { paused_at: null, paused_reason: null };
}

function readCurrentSpaceRulesState(
  db: Database,
  spaceId: string
): CurrentSpaceRulesState {
  const row = db
    .prepare(
      `SELECT srs.rules_markdown,
              srs.rules_version,
              srs.source_event_id,
              srs.updated_at,
              srs.is_disabled,
              m.name AS updated_by
         FROM space_rules_snapshots srs
         LEFT JOIN members m ON m.id = srs.updated_by_member_id
        WHERE srs.space_id = ?1
        LIMIT 1`
    )
    .get(spaceId) as SpaceRulesProjectionRow | null;

  const hasServerRules = row !== null && row.is_disabled !== 1;
  const body = hasServerRules ? (row?.rules_markdown ?? '') : '';

  return {
    body,
    version: row?.rules_version ?? 0,
    hash: stableRulesHash(body),
    hasServerRules,
    sourceEventId: row?.source_event_id ?? null,
    updatedAt: row?.updated_at ?? null,
    updatedBy: row?.updated_by ?? null
  };
}

function getMemberCoordPref(
  db: Database,
  spaceId: string,
  principal: string
): CoordPref | undefined {
  try {
    const row = db
      .query(
        `SELECT coord_pref FROM members
          WHERE space_id = ?1 AND name = ?2 AND left_at IS NULL`
      )
      .get(spaceId, principal) as { coord_pref: string | null } | null;
    return row ? normalizeCoordPref(row.coord_pref) : undefined;
  } catch {
    // Legacy fixtures may not have members.coord_pref. In that case callers
    // fall back to briefing-derived defaults for backward compatibility.
    return undefined;
  }
}

function readPermissionResolutionFromProjection(
  db: Database,
  spaceId: string,
  reqId: string
): PermissionResolution | null {
  const reqRow = db
    .prepare(
      `SELECT status
         FROM permission_requests
        WHERE req_id = ?1
          AND space_id = ?2
          AND tombstoned_at IS NULL`
    )
    .get(reqId, spaceId) as { status: string } | null;
  if (!reqRow || reqRow.status === 'open') return null;
  if (reqRow.status === 'denied') {
    return { action: 'skip', reason: 'denied_by_incumbent' };
  }
  if (reqRow.status === 'expired') {
    return { action: 'skip', reason: 'timeout' };
  }
  if (reqRow.status !== 'granted') return null;

  const grantRows = db
    .prepare(
      `SELECT payload_json
         FROM events
        WHERE space_id = ?1
          AND event_type = 'permission_granted'
        ORDER BY timestamp DESC`
    )
    .all(spaceId) as Array<{ payload_json: string }>;
  let newClaimId = '';
  for (const row of grantRows) {
    try {
      const payload = JSON.parse(row.payload_json) as {
        req_id?: unknown;
        new_claim_id?: unknown;
      };
      if (
        payload.req_id === reqId &&
        typeof payload.new_claim_id === 'string'
      ) {
        newClaimId = payload.new_claim_id;
        break;
      }
    } catch {
      // malformed historical event — keep scanning
    }
  }
  if (!newClaimId) return null;

  const claimRow = db
    .prepare(
      `SELECT expires_at
         FROM claims
        WHERE claim_id = ?1
          AND space_id = ?2
          AND tombstoned_at IS NULL`
    )
    .get(newClaimId, spaceId) as { expires_at: string | null } | null;
  return {
    action: 'allow',
    claim_id: newClaimId,
    expires_at: claimRow?.expires_at ?? ''
  };
}

function readPermissionRequestRow(
  db: Database,
  spaceId: string,
  reqId: string
): {
  req_id: string;
  requester_principal: string;
  status: string;
} | null {
  return db
    .prepare(
      `SELECT req_id, requester_principal, status
         FROM permission_requests
        WHERE req_id = ?1
          AND space_id = ?2
          AND tombstoned_at IS NULL`
    )
    .get(reqId, spaceId) as {
    req_id: string;
    requester_principal: string;
    status: string;
  } | null;
}

function permissionResolutionToResponseData(
  reqId: string,
  resolution: PermissionResolution
):
  | {
      req_id: string;
      action: 'allow';
      claim_id: string;
      expires_at: string;
    }
  | {
      req_id: string;
      action: 'skip';
      reason: 'denied_by_incumbent' | 'timeout';
    } {
  if (resolution.action === 'allow') {
    return {
      req_id: reqId,
      action: 'allow',
      claim_id: resolution.claim_id,
      expires_at: resolution.expires_at
    };
  }
  return {
    req_id: reqId,
    action: 'skip',
    reason: resolution.reason
  };
}

async function waitForPermissionResolution(opts: {
  db: Database;
  reqId: string;
  spaceId: string;
  timeoutMs: number;
  disableWaker?: boolean;
}): Promise<PermissionResolution> {
  const { db, reqId, spaceId, timeoutMs, disableWaker } = opts;
  return new Promise<PermissionResolution>((resolve) => {
    let settled = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let pollHandle: ReturnType<typeof setTimeout> | undefined;
    const settle = (r: PermissionResolution) => {
      if (settled) return;
      settled = true;
      permissionWakers.delete(reqId);
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (pollHandle) clearTimeout(pollHandle);
      resolve(r);
    };
    if (disableWaker !== true) {
      permissionWakers.set(reqId, settle);
    }
    if (timeoutMs > 0) {
      const pollProjection = () => {
        const projected = readPermissionResolutionFromProjection(
          db,
          spaceId,
          reqId
        );
        if (projected) {
          settle(projected);
          return;
        }
        pollHandle = setTimeout(pollProjection, 250);
        pollHandle.unref?.();
      };
      pollHandle = setTimeout(pollProjection, 250);
      pollHandle.unref?.();
      timeoutHandle = setTimeout(
        () => settle({ action: 'skip', reason: 'timeout' }),
        timeoutMs
      );
      timeoutHandle.unref?.();
    } else {
      timeoutHandle = setTimeout(
        () => settle({ action: 'skip', reason: 'timeout' }),
        0
      );
      timeoutHandle.unref?.();
    }
  });
}

/**
 * F-NEW-3 self-overlap idempotency picker. Among self-claims whose scope
 * is a superset of the requested paths under the matcher, pick the one
 * with the lexicographically-largest `claim_id` (ULIDs are monotonic —
 * latest creator wins deterministically). Returns `null` for the
 * self-widening case (caller surfaces 409 scope_conflict_self_widening).
 */
function pickSupersetSelfClaim(
  selfHits: OverlapHit[],
  selfClaims: ActiveClaimRow[],
  requestedNormalizedPaths: string[]
): { claim_id: string; expires_at: string } | null {
  const byId = new Map<string, ActiveClaimRow>();
  for (const c of selfClaims) byId.set(c.claim_id, c);

  const supersets: ActiveClaimRow[] = [];
  for (const hit of selfHits) {
    const claim = byId.get(hit.claim_id);
    if (!claim) continue;
    // A claim is a superset iff every requested normalized path overlapped
    // at least one of the claim's scope paths (i.e. matched_target_paths
    // covers all of requestedNormalizedPaths).
    const matchedSet = new Set(hit.matched_target_paths);
    const allCovered = requestedNormalizedPaths.every((rp) =>
      matchedSet.has(rp)
    );
    if (allCovered) supersets.push(claim);
  }
  if (supersets.length === 0) return null;
  supersets.sort((a, b) => (a.claim_id < b.claim_id ? 1 : -1));
  const winner = supersets[0]!;
  return {
    claim_id: winner.claim_id,
    expires_at: winner.expires_at ?? ''
  };
}

export type DecisionKind = 'plan' | 'architectural' | 'product' | 'process';

export type DecisionCurrentRow = {
  decision_id: string;
  title: string;
  summary: string | null;
  body: string | null;
  kind: string;
  status: string;
  version: number;
};

export type DecisionMutationData = {
  event_id: string;
  decision_id: string;
  sprint_id: string | null;
  context: 'space' | 'sprint';
  lifecycle_event:
    | 'decision_published'
    | 'decision_amended'
    | 'decision_superseded';
  version: number;
  kind: string;
  status: 'open' | 'superseded';
  superseded_by_decision_id: string | null;
  affected_decision_ids?: string[];
};

export type { MoveType, Side, TerminationCondition };

export function createToolContext({ store, db }: ToolDeps) {
  function readCurrentDecision(
    spaceId: string,
    decisionId: string,
    sprintId?: string | null
  ): DecisionCurrentRow | null {
    const contextPredicate =
      sprintId === undefined
        ? ''
        : sprintId === null
          ? 'AND sprint_id IS NULL'
          : 'AND sprint_id = ?3';
    try {
      return db
        .prepare(
          `SELECT decision_id, title, summary, body, kind, status, version
           FROM decisions
          WHERE space_id = ?1
            AND decision_id = ?2
            ${contextPredicate}
            AND tombstoned_at IS NULL`
        )
        .get(
          ...(sprintId === undefined
            ? [spaceId, decisionId]
            : sprintId === null
              ? [spaceId, decisionId]
              : [spaceId, decisionId, sprintId])
        ) as DecisionCurrentRow | null;
    } catch {
      const legacy = db
        .prepare(
          `SELECT decision_id, title, summary, kind, status
           FROM decisions
          WHERE space_id = ?1
            AND decision_id = ?2
            ${contextPredicate}`
        )
        .get(
          ...(sprintId === undefined
            ? [spaceId, decisionId]
            : sprintId === null
              ? [spaceId, decisionId]
              : [spaceId, decisionId, sprintId])
        ) as {
        decision_id: string;
        title: string;
        summary: string | null;
        kind: string;
        status: string;
      } | null;
      return legacy
        ? {
            ...legacy,
            body: null,
            version: 1
          }
        : null;
    }
  }

  function appendDecisionEventInTx(event: TeamemEvent): void {
    store.appendInTx(event);
    applyProjectionUpdate(db, event);
    enqueueDecisionReplayInTx(event);
  }

  function isDecisionLifecycleEventType(
    eventType: string
  ): eventType is
    | 'decision_published'
    | 'decision_amended'
    | 'decision_superseded' {
    return (
      eventType === 'decision_published' ||
      eventType === 'decision_amended' ||
      eventType === 'decision_superseded'
    );
  }

  function enqueueDecisionReplayInTx(event: TeamemEvent): void {
    if (!isDecisionLifecycleEventType(event.event_type)) return;

    const recipients = db
      .prepare(
        `SELECT name
         FROM members
        WHERE space_id = ?1
          AND left_at IS NULL
          AND name != ?2`
      )
      .all(event.space_id, event.principal) as Array<{ name: string }>;

    if (recipients.length === 0) return;

    try {
      const insertNotification = db.prepare(
        `INSERT OR IGNORE INTO unread_notifications
         (space_id, principal, event_id, event_type, payload_json, created_at, delivered_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL)`
      );
      const payloadJson = JSON.stringify(event.payload ?? {});
      for (const recipient of recipients) {
        insertNotification.run(
          event.space_id,
          recipient.name,
          event.event_id,
          event.event_type,
          payloadJson,
          event.timestamp
        );
      }
    } catch (err) {
      const e = err as { message?: string };
      if (!e?.message?.includes('no such table: unread_notifications')) {
        throw err;
      }
    }
  }

  function markDecisionNotificationsDelivered(
    spaceId: string,
    principal: string,
    eventIds: string[]
  ): void {
    if (eventIds.length === 0) return;
    const deliveredAt = new Date().toISOString();
    try {
      const update = db.prepare(
        `UPDATE unread_notifications
          SET delivered_at = ?1
        WHERE space_id = ?2
          AND principal = ?3
          AND event_id = ?4
          AND event_type IN ('decision_published', 'decision_amended', 'decision_superseded')
          AND delivered_at IS NULL`
      );
      for (const eventId of eventIds) {
        update.run(deliveredAt, spaceId, principal, eventId);
      }
    } catch (err) {
      const e = err as { message?: string };
      if (!e?.message?.includes('no such table: unread_notifications')) {
        throw err;
      }
    }
  }

  function drainDecisionReplayNotifications(
    spaceId: string,
    principal: string
  ): ToolResponse<{ decisions: DecisionReplayNotification[] }> {
    try {
      return db
        .transaction(() => {
          const rows = db
            .prepare(
              `SELECT event_id, event_type, payload_json, created_at
               FROM unread_notifications
              WHERE space_id = ?1
                AND principal = ?2
                AND event_type IN ('decision_published', 'decision_amended', 'decision_superseded')
                AND delivered_at IS NULL
              ORDER BY created_at ASC`
            )
            .all(spaceId, principal) as Array<{
            event_id: string;
            event_type:
              | 'decision_published'
              | 'decision_amended'
              | 'decision_superseded';
            payload_json: string;
            created_at: string;
          }>;

          if (rows.length > 0) {
            const deliveredAt = new Date().toISOString();
            const update = db.prepare(
              `UPDATE unread_notifications
                SET delivered_at = ?1
              WHERE event_id = ?2
                AND principal = ?3
                AND delivered_at IS NULL`
            );
            for (const row of rows) {
              update.run(deliveredAt, row.event_id, principal);
            }
          }

          return {
            ok: true as const,
            data: {
              decisions: rows.map((row) => ({
                event_id: row.event_id,
                event_type: row.event_type,
                principal,
                created_at: row.created_at,
                payload: JSON.parse(
                  row.payload_json
                ) as DecisionReplayNotification['payload']
              }))
            }
          };
        })
        .immediate() as ToolResponse<{
        decisions: DecisionReplayNotification[];
      }>;
    } catch (err) {
      const e = err as { message?: string };
      if (e?.message?.includes('no such table: unread_notifications')) {
        return { ok: true, data: { decisions: [] } };
      }
      throw err;
    }
  }

  function activePrincipalPaths(spaceId: string, principal: string): string[] {
    const paths = new Set<string>();
    const currentSprintId = readCurrentSprintId(db, spaceId, principal);
    try {
      const rows = db
        .prepare(
          `SELECT scope_json
           FROM claims
          WHERE space_id = ?1
            AND principal = ?2
            AND status = 'active'
            AND ${
              currentSprintId === null ? 'sprint_id IS NULL' : 'sprint_id = ?3'
            }
            AND released_at IS NULL`
        )
        .all(
          ...(currentSprintId === null
            ? [spaceId, principal]
            : [spaceId, principal, currentSprintId])
        ) as Array<{ scope_json: string }>;
      for (const row of rows) {
        try {
          const parsed = JSON.parse(row.scope_json) as { paths?: unknown };
          for (const path of parseStringArray(parsed.paths)) paths.add(path);
        } catch {
          // Ignore malformed legacy rows.
        }
      }
    } catch (err) {
      const e = err as { message?: string };
      if (!e?.message?.includes('no such table: claims')) throw err;
    }

    try {
      const focusRows = db
        .prepare(
          `SELECT scope_paths_json
           FROM focus
          WHERE space_id = ?1
            AND principal = ?2
            AND tombstoned_at IS NULL
          ORDER BY started_at DESC
          LIMIT 20`
        )
        .all(spaceId, principal) as Array<{ scope_paths_json: string }>;
      for (const row of focusRows) {
        try {
          const parsed = JSON.parse(row.scope_paths_json) as unknown;
          for (const path of parseStringArray(parsed)) paths.add(path);
        } catch {
          // Ignore malformed legacy rows.
        }
      }
    } catch (err) {
      const e = err as { message?: string };
      if (!e?.message?.includes('no such table: focus')) throw err;
    }

    return Array.from(paths);
  }

  function gotchaRelevance(input: {
    severity: 'info' | 'warning' | 'urgent';
    gotchaPaths: string[];
    gotchaTags: string[];
    principalPaths: string[];
  }): GotchaNotice['payload']['relevance'] | null {
    if (input.severity === 'urgent') return 'urgent';
    const pathSet = new Set(input.principalPaths);
    if (input.gotchaPaths.some((path) => pathSet.has(path))) {
      return 'path_overlap';
    }
    if (
      input.gotchaTags.some((tag) =>
        input.principalPaths.some((path) => path.includes(tag))
      )
    ) {
      return 'tag_overlap';
    }
    return null;
  }

  function listGotchaNotices(
    spaceId: string,
    principal: string
  ): GotchaNotice[] {
    const currentSprintId = readCurrentSprintId(db, spaceId, principal);
    try {
      const rows = db
        .prepare(
          `SELECT finding_id, version, principal, summary, paths_json, tags_json,
                recipient_principals_json, severity, created_at, source_event_id
           FROM findings
          WHERE space_id = ?1
            AND ${
              currentSprintId === null ? 'sprint_id IS NULL' : 'sprint_id = ?3'
            }
            AND kind = 'gotcha'
            AND status = 'active'
            AND tombstoned_at IS NULL
            AND NOT EXISTS (
              SELECT 1
                FROM finding_acknowledgements fa
               WHERE fa.space_id = findings.space_id
                 AND fa.finding_id = findings.finding_id
                 AND fa.version = findings.version
                 AND fa.principal = ?2
            )
          ORDER BY created_at ASC`
        )
        .all(
          ...(currentSprintId === null
            ? [spaceId, principal]
            : [spaceId, principal, currentSprintId])
        ) as Array<{
        finding_id: string;
        version: number;
        principal: string;
        summary: string;
        paths_json: string;
        tags_json: string;
        recipient_principals_json: string;
        severity: 'info' | 'warning' | 'urgent';
        created_at: string;
        source_event_id: string;
      }>;

      const principalPaths = activePrincipalPaths(spaceId, principal);
      const notices: GotchaNotice[] = [];
      for (const row of rows) {
        if (row.principal === principal) continue;

        const paths = parseJsonStringArray(row.paths_json);
        const tags = parseJsonStringArray(row.tags_json);
        const recipientPrincipals = parseJsonStringArray(
          row.recipient_principals_json
        );
        const isDirect = recipientPrincipals.length > 0;
        if (isDirect && !recipientPrincipals.includes(principal)) continue;

        const relevance = isDirect
          ? 'direct_target'
          : gotchaRelevance({
              severity: row.severity,
              gotchaPaths: paths,
              gotchaTags: tags,
              principalPaths
            });
        if (!relevance) continue;

        notices.push({
          event_id: row.source_event_id,
          event_type: 'gotcha_notice',
          payload: {
            finding_id: row.finding_id,
            version: row.version,
            summary: row.summary,
            severity: row.severity,
            paths,
            tags,
            recipient_mode: isDirect ? 'direct' : 'broadcast',
            recipient_principals: recipientPrincipals,
            relevance
          },
          created_at: row.created_at
        });
      }
      return notices;
    } catch (err) {
      const e = err as { message?: string };
      if (
        e?.message?.includes('no such table: findings') ||
        e?.message?.includes('no such table: finding_acknowledgements') ||
        e?.message?.includes('no such column: recipient_principals_json')
      ) {
        return [];
      }
      throw err;
    }
  }

  function decisionEvent(
    input: {
      space_id: string;
      principal: string;
      actor: string;
      delegation: string;
      scope?: 'current' | 'space';
    },
    eventType:
      | 'decision_published'
      | 'decision_amended'
      | 'decision_superseded',
    payload: Record<string, unknown>
  ): TeamemEvent {
    return {
      schema_version: '1.0',
      event_id: newEventId(),
      idempotency_key: newIdempotencyKey(),
      space_id: input.space_id,
      timestamp: new Date().toISOString(),
      principal: input.principal,
      actor: input.actor,
      delegation: input.delegation,
      event_type: eventType,
      ...routingMetadataForPrincipal(
        db,
        input,
        input.scope === 'space'
          ? { delivery: 'space' }
          : { delivery: 'broadcast' }
      ),
      scope: {},
      payload
    };
  }

  function supersedeDecisionInTx(
    input: {
      space_id: string;
      principal: string;
      actor: string;
      delegation: string;
      scope?: 'current' | 'space';
    },
    decisionId: string,
    supersededByDecisionId: string | null
  ): ToolResponse<DecisionMutationData> {
    const sprintId =
      input.scope === 'space'
        ? null
        : readCurrentSprintId(db, input.space_id, input.principal);
    const current = readCurrentDecision(input.space_id, decisionId, sprintId);
    if (!current) {
      return toolError(
        'decision_not_found',
        `Unknown decision_id ${decisionId}`
      );
    }
    if (current.status === 'superseded') {
      return toolError(
        'decision_already_superseded',
        `Decision ${decisionId} is already superseded`
      );
    }

    const event = decisionEvent(input, 'decision_superseded', {
      decision_id: current.decision_id,
      title: current.title,
      summary: current.summary ?? '',
      body: current.body ?? '',
      kind: current.kind,
      version: current.version + 1,
      superseded_by_decision_id: supersededByDecisionId
    });
    appendDecisionEventInTx(event);
    return {
      ok: true,
      data: {
        event_id: event.event_id,
        decision_id: current.decision_id,
        sprint_id: event.sprint_id ?? null,
        context: event.sprint_id == null ? 'space' : 'sprint',
        lifecycle_event: 'decision_superseded',
        version: current.version + 1,
        kind: current.kind,
        status: 'superseded',
        superseded_by_decision_id: supersededByDecisionId
      }
    };
  }

  return {
    store,
    db,
    validateEvent,
    evaluateRelease,
    claimTransition,
    applyProjectionUpdate,
    toolError,
    ScopeConflictError,
    metrics,
    findOverlappingActiveClaims,
    normalizePathPattern,
    newEventId,
    newClaimId,
    newIdempotencyKey,
    deterministicClaimIdempotencyKey,
    deterministicReleaseIdempotencyKey,
    deterministicMessageIdempotencyKey,
    applyMove,
    checkTermination,
    initialState,
    validateMove,
    validateTerminationsEnabled,
    ulid,
    buildBriefing,
    buildSpaceRulesSnapshot,
    canonicalRulesBody,
    stableRulesHash,
    isCoordPref,
    normalizeCoordPref,
    findResolvableByRelease,
    kickMember,
    leaveSpace,
    rotateRoomCode,
    canonicalScopePaths,
    computeScopeHash,
    narrowClaimPaths,
    hasOverlap,
    nanoid,
    DEFAULT_PERMISSION_REQUEST_TIMEOUT_MS,
    permissionWakers,
    normalizeScopePaths,
    dedupeSorted,
    parseStringArray,
    parseFindingRefs,
    parseFindingPaths,
    parseJsonStringArray,
    parseNullableFindingRefs,
    loadDiscussionThreadMetadata,
    deriveLegacyDiscussionThreadMetadata,
    readDiscussionHelperPolicy,
    getSpaceMembershipStatus,
    readCurrentSprintId,
    routingMetadataForPrincipal,
    authorizeDiscussionThreadAccess,
    resolveDirectReplyRecipient,
    selectActiveClaimsForOverlap,
    getPausedAtForClaim,
    readCurrentSpaceRulesState,
    getMemberCoordPref,
    readPermissionResolutionFromProjection,
    readPermissionRequestRow,
    permissionResolutionToResponseData,
    waitForPermissionResolution,
    pickSupersetSelfClaim,
    readCurrentDecision,
    appendDecisionEventInTx,
    isDecisionLifecycleEventType,
    enqueueDecisionReplayInTx,
    markDecisionNotificationsDelivered,
    drainDecisionReplayNotifications,
    activePrincipalPaths,
    gotchaRelevance,
    listGotchaNotices,
    decisionEvent,
    supersedeDecisionInTx,
    loadDispute,
    loadDisputeConfig,
    replayDisputeMoves,
    bothStillAutoDiscuss,
    finalizeTermination,
    applyAcceptOutcome
  };
}

export type ToolContext = ReturnType<typeof createToolContext>;

// ---------------------------------------------------------------------------
// Slice #12 — dispute helpers (server-side state machine glue).
// ---------------------------------------------------------------------------

type DisputeRow = {
  thread_id: string;
  space_id: string;
  opened_by: string;
  target_principal: string;
  blocking_claim_id: string;
  paths_json: string;
  intent: string | null;
  status: 'open' | 'resolved' | 'terminated';
  opened_at: string;
  source_event_id: string;
};

function loadDispute(
  db: Database,
  space_id: string,
  thread_id: string
): { row: DisputeRow; config: DisputeConfig } | null {
  const row = db
    .prepare(
      `SELECT thread_id, space_id, opened_by, target_principal,
              blocking_claim_id, paths_json, intent, status,
              opened_at, source_event_id
         FROM disputes
        WHERE space_id = ?1 AND thread_id = ?2 AND tombstoned_at IS NULL`
    )
    .get(space_id, thread_id) as DisputeRow | null;
  if (!row) return null;
  return { row, config: loadDisputeConfig(db, space_id) };
}

function loadDisputeConfig(db: Database, space_id: string): DisputeConfig {
  try {
    const sp = db
      .prepare(
        'SELECT dispute_terminations_json FROM spaces WHERE id = ?1 LIMIT 1'
      )
      .get(space_id) as { dispute_terminations_json: string | null } | null;
    if (!sp?.dispute_terminations_json) return DEFAULT_DISPUTE_CONFIG;
    const parsed = JSON.parse(sp.dispute_terminations_json) as unknown;
    if (!Array.isArray(parsed)) return DEFAULT_DISPUTE_CONFIG;
    const enabled = new Set<TerminationCondition>(
      parsed.filter(
        (v): v is TerminationCondition =>
          typeof v === 'string' &&
          [
            'user_override',
            'explicit',
            'turns',
            'wallclock',
            'pref_changed'
          ].includes(v)
      )
    );
    return { ...DEFAULT_DISPUTE_CONFIG, terminations_enabled: enabled };
  } catch {
    return DEFAULT_DISPUTE_CONFIG;
  }
}

/**
 * Replay every `discussion_posted` event in this dispute's thread that
 * carries a `dispute_move` payload, in timestamp order. The state machine
 * applies them sequentially to reconstruct turn_count / last_side / open
 * proposals.
 */
function replayDisputeMoves(
  db: Database,
  space_id: string,
  thread_id: string,
  opened_at: string
): DisputeState {
  let state = initialState(opened_at);
  // Order by ROWID (sqlite's implicit insertion order) rather than
  // event_id. ULIDs are only monotonic-within-millisecond inside a
  // single `ulidx` process when the `monotonicFactory` is used; the
  // default `ulid()` can produce non-monotonic ids when two events are
  // generated in the same ms (rare but observed under fast unit tests).
  // ROWID is always monotonic-on-insert, so it preserves causal order.
  const rows = db
    .query(
      `SELECT event_id, payload_json, principal
         FROM events
        WHERE space_id = ?1
          AND event_type = 'discussion_posted'
        ORDER BY ROWID ASC`
    )
    .all(space_id) as Array<{
    event_id: string;
    payload_json: string;
    principal: string;
  }>;
  for (const r of rows) {
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(r.payload_json) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (payload.thread_id !== thread_id) continue;
    const move = payload.dispute_move as
      | {
          move_type: MoveType;
          side: Side;
          payload: Record<string, unknown>;
          target_proposal_id?: string;
        }
      | undefined;
    if (!move) continue;
    state = applyMove(state, {
      move_type: move.move_type,
      side: move.side,
      payload: move.payload,
      move_id:
        typeof payload.message_id === 'string'
          ? payload.message_id
          : r.event_id,
      target_proposal_id: move.target_proposal_id
    });
  }
  return state;
}

function bothStillAutoDiscuss(
  db: Database,
  space_id: string,
  opener: string,
  target: string
): boolean {
  try {
    const rows = db
      .query(
        `SELECT name, coord_pref FROM members
          WHERE space_id = ?1 AND name IN (?2, ?3) AND left_at IS NULL`
      )
      .all(space_id, opener, target) as Array<{
      name: string;
      coord_pref: string | null;
    }>;
    if (rows.length < 2) return false;
    return rows.every((r) => r.coord_pref === 'auto-discuss');
  } catch {
    // members.coord_pref column missing — treat as still auto-discuss
    // (fail-open, the migration 011 backfill should run before any
    // dispute can possibly open).
    return true;
  }
}

type FinalizeArgs = {
  space_id: string;
  thread_id: string;
  reason: TerminationCondition;
  outcome: 'accept' | 'deny' | 'skip';
  principal: string;
  actor: string;
  delegation: string;
};

function finalizeTermination(
  db: Database,
  store: SqliteEventStore,
  args: FinalizeArgs
): ToolResponse<{ outcome: string }> {
  const timestamp = new Date().toISOString();
  const evt: TeamemEvent = {
    schema_version: '1.0',
    event_id: newEventId(),
    idempotency_key: `idem-dispterm-${args.thread_id}-${timestamp}`,
    space_id: args.space_id,
    timestamp,
    principal: args.principal,
    actor: args.actor,
    delegation: args.delegation,
    event_type: 'dispute_terminated',
    ...routingMetadataForPrincipal(
      db,
      {
        space_id: args.space_id,
        principal: args.principal
      },
      { delivery: 'broadcast' }
    ),
    scope: {},
    payload: {
      thread_id: args.thread_id,
      reason: args.reason,
      outcome: args.outcome
    }
  };
  store.appendInTx(evt);
  db.prepare(
    `UPDATE disputes SET status = 'terminated', resolved_at = ?1,
                         termination_reason = ?2, termination_outcome = ?3
      WHERE thread_id = ?4 AND status = 'open'`
  ).run(timestamp, args.reason, args.outcome, args.thread_id);
  return { ok: true, data: { outcome: args.outcome } };
}

type AcceptArgs = {
  space_id: string;
  thread_id: string;
  dispute: DisputeRow;
  proposal: {
    move_type: MoveType;
    side: Side;
    payload: Record<string, unknown>;
    move_id: string;
  };
  acceptor: string;
  actor: string;
  delegation: string;
};

/**
 * Atomic resolution of an accepted proposal. Replays the same shape as
 * Legacy/internal grant path: scope_released for incumbent (narrowed), fresh
 * scope_claimed for latter on the agreed paths, dispute_resolved marker.
 *
 * - propose_release_full   → release entire incumbent claim, latter claims requested paths.
 * - propose_release_subset → narrowClaimPaths(incumbent_paths, proposal.paths), latter claims proposal.paths.
 * - propose_release_after_task → no immediate scope change; resolve still requires the actual `release_scope` event later. Returns outcome 'wait'.
 * - propose_swap          → both sides release listed paths; both sides re-claim swapped paths.
 */
function applyAcceptOutcome(
  db: Database,
  store: SqliteEventStore,
  args: AcceptArgs
): ToolResponse<{ outcome: string }> {
  const timestamp = new Date().toISOString();

  // Identify opener (latter / requester) and target (incumbent).
  const opener = args.dispute.opened_by;
  const target = args.dispute.target_principal;

  if (args.proposal.move_type === 'propose_release_after_task') {
    // Informational — no scope change. Just emit dispute_resolved with
    // outcome=wait so audit shows the agreement.
    const evt: TeamemEvent = {
      schema_version: '1.0',
      event_id: newEventId(),
      idempotency_key: `idem-dispresolve-${args.thread_id}-wait-${timestamp}`,
      space_id: args.space_id,
      timestamp,
      principal: args.acceptor,
      actor: args.actor,
      delegation: args.delegation,
      event_type: 'dispute_resolved',
      ...routingMetadataForPrincipal(
        db,
        {
          space_id: args.space_id,
          principal: args.acceptor
        },
        { delivery: 'broadcast' }
      ),
      scope: {},
      payload: {
        thread_id: args.thread_id,
        outcome: 'wait',
        wait_seconds: args.proposal.payload.wait_seconds
      }
    };
    store.appendInTx(evt);
    return { ok: true, data: { outcome: 'wait' } };
  }

  // Fetch incumbent's current claim scope.
  const claim = db
    .query(
      `SELECT scope_json, principal FROM claims
        WHERE claim_id = ?1 AND space_id = ?2 AND tombstoned_at IS NULL`
    )
    .get(args.dispute.blocking_claim_id, args.space_id) as {
    scope_json: string;
    principal: string;
  } | null;
  if (!claim) {
    return toolError('claim_not_found', 'incumbent claim no longer exists');
  }
  if (claim.principal !== target) {
    return toolError(
      'claim_owner_changed',
      'incumbent claim has been transferred since the dispute opened'
    );
  }
  let incumbentPaths: string[] = [];
  try {
    const parsed = JSON.parse(claim.scope_json) as TeamemEvent['scope'];
    incumbentPaths = Array.isArray(parsed.paths) ? parsed.paths : [];
  } catch {
    incumbentPaths = [];
  }

  let releasedPaths: string[] = [];
  let keptPaths: string[] = [];
  let claimedPaths: string[] = [];
  let outcomeKind: 'release_full' | 'release_subset' | 'swap';

  if (args.proposal.move_type === 'propose_release_full') {
    releasedPaths = incumbentPaths.slice();
    keptPaths = [];
    claimedPaths = JSON.parse(args.dispute.paths_json) as string[];
    outcomeKind = 'release_full';
  } else if (args.proposal.move_type === 'propose_release_subset') {
    const proposalPaths = (args.proposal.payload.paths as string[]) ?? [];
    const r = narrowClaimPaths(incumbentPaths, proposalPaths);
    keptPaths = r.kept;
    releasedPaths = r.released;
    claimedPaths = proposalPaths;
    outcomeKind = 'release_subset';
  } else if (args.proposal.move_type === 'propose_swap') {
    const iRelease = (args.proposal.payload.i_release as string[]) ?? [];
    const youRelease = (args.proposal.payload.you_release as string[]) ?? [];
    // The proposer says "I release i_release; you release you_release".
    // From the incumbent's perspective: incumbent releases `you_release`,
    // opener releases `i_release` (if they hold it elsewhere — out of
    // scope of this dispute's incumbent claim). We narrow incumbent's
    // claim by `you_release`; opener gets a fresh claim on `you_release`.
    const r = narrowClaimPaths(incumbentPaths, youRelease);
    keptPaths = r.kept;
    releasedPaths = r.released;
    claimedPaths = youRelease;
    // Also release any opener-held paths that match i_release (best-effort
    // — only applies if opener actually holds claims on those paths).
    if (iRelease.length > 0) {
      const openerClaims = db
        .query(
          `SELECT claim_id, scope_json FROM claims
            WHERE space_id = ?1 AND principal = ?2 AND status = 'active'
              AND tombstoned_at IS NULL`
        )
        .all(args.space_id, opener) as Array<{
        claim_id: string;
        scope_json: string;
      }>;
      for (const oc of openerClaims) {
        let ocPaths: string[] = [];
        try {
          const parsed = JSON.parse(oc.scope_json) as TeamemEvent['scope'];
          ocPaths = Array.isArray(parsed.paths) ? parsed.paths : [];
        } catch {
          continue;
        }
        const sub = narrowClaimPaths(ocPaths, iRelease);
        if (sub.released.length === 0) continue;
        const relEvt: TeamemEvent = {
          schema_version: '1.0',
          event_id: newEventId(),
          idempotency_key: `idem-dispswapopen-${oc.claim_id}-${timestamp}`,
          space_id: args.space_id,
          timestamp,
          principal: opener,
          actor: opener,
          delegation: `${opener}->${opener}`,
          event_type: 'scope_released',
          ...routingMetadataForPrincipal(
            db,
            {
              space_id: args.space_id,
              principal: opener
            },
            { delivery: 'broadcast' }
          ),
          scope: { paths: sub.released },
          payload: {
            claim_id: oc.claim_id,
            released_paths: sub.released,
            narrowed: true
          }
        };
        store.appendInTx(relEvt);
        if (sub.kept.length === 0) {
          db.prepare(
            `UPDATE claims SET status = 'released', released_at = ?1,
                                scope_json = ?2 WHERE claim_id = ?3`
          ).run(timestamp, JSON.stringify({ paths: sub.kept }), oc.claim_id);
        } else {
          db.prepare(
            `UPDATE claims SET scope_json = ?1 WHERE claim_id = ?2`
          ).run(JSON.stringify({ paths: sub.kept }), oc.claim_id);
        }
      }
    }
    outcomeKind = 'swap';
  } else {
    return toolError(
      'invalid_proposal_type',
      `cannot accept ${args.proposal.move_type}`
    );
  }

  // 1. scope_released for incumbent (narrowed or full).
  if (releasedPaths.length > 0) {
    const releaseEvt: TeamemEvent = {
      schema_version: '1.0',
      event_id: newEventId(),
      idempotency_key: `idem-disprel-${args.thread_id}-${timestamp}`,
      space_id: args.space_id,
      timestamp,
      principal: target,
      actor: target,
      delegation: `${target}->${target}`,
      event_type: 'scope_released',
      ...routingMetadataForPrincipal(
        db,
        {
          space_id: args.space_id,
          principal: target
        },
        { delivery: 'broadcast' }
      ),
      scope: { paths: releasedPaths },
      payload: {
        claim_id: args.dispute.blocking_claim_id,
        released_paths: releasedPaths,
        narrowed: keptPaths.length > 0
      }
    };
    store.appendInTx(releaseEvt);
    if (keptPaths.length === 0) {
      db.prepare(
        `UPDATE claims SET status = 'released', released_at = ?1,
                            scope_json = ?2 WHERE claim_id = ?3`
      ).run(
        timestamp,
        JSON.stringify({ paths: keptPaths }),
        args.dispute.blocking_claim_id
      );
    } else {
      db.prepare(`UPDATE claims SET scope_json = ?1 WHERE claim_id = ?2`).run(
        JSON.stringify({ paths: keptPaths }),
        args.dispute.blocking_claim_id
      );
    }
  }

  // 2. fresh scope_claimed for opener.
  let grantedClaimId: string | null = null;
  if (claimedPaths.length > 0) {
    grantedClaimId = newClaimId();
    const expiresAt = new Date(
      Date.parse(timestamp) + 60 * 60 * 1000
    ).toISOString();
    const claimEvt: TeamemEvent = {
      schema_version: '1.0',
      event_id: newEventId(),
      idempotency_key: `idem-dispclaim-${args.thread_id}-${timestamp}`,
      space_id: args.space_id,
      timestamp,
      principal: opener,
      actor: opener,
      delegation: `${opener}->${opener}`,
      event_type: 'scope_claimed',
      ...routingMetadataForPrincipal(
        db,
        {
          space_id: args.space_id,
          principal: opener
        },
        { delivery: 'broadcast' }
      ),
      scope: { paths: claimedPaths },
      payload: {
        claim_id: grantedClaimId,
        intent: 'granted via dispute resolution',
        expires_at: expiresAt
      }
    };
    store.appendInTx(claimEvt);
    applyProjectionUpdate(db, claimEvt);
  }

  // 3. dispute_resolved marker.
  const resolveEvt: TeamemEvent = {
    schema_version: '1.0',
    event_id: newEventId(),
    idempotency_key: `idem-dispres-${args.thread_id}-${timestamp}`,
    space_id: args.space_id,
    timestamp,
    principal: args.acceptor,
    actor: args.actor,
    delegation: args.delegation,
    event_type: 'dispute_resolved',
    ...routingMetadataForPrincipal(
      db,
      {
        space_id: args.space_id,
        principal: args.acceptor
      },
      { delivery: 'broadcast' }
    ),
    scope: { paths: claimedPaths },
    payload: {
      thread_id: args.thread_id,
      outcome: outcomeKind,
      released_paths: releasedPaths,
      kept_paths: keptPaths,
      claimed_paths: claimedPaths,
      new_claim_id: grantedClaimId
    }
  };
  store.appendInTx(resolveEvt);

  return { ok: true, data: { outcome: outcomeKind } };
}
