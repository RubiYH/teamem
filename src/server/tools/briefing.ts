import type { Database } from 'bun:sqlite';
import type { BriefingResponse } from './briefing-schema.js';
import { loadBlockingPreviews } from '../../domain/conflicts/pending-edits.js';
import { loadRecentFocus } from '../../domain/focus/index.js';
import { normalizeCoordPref } from '../../domain/conflicts/coord-pref.js';

type BriefingInput = {
  space_id: string;
  principal: string;
  token_budget?: number;
};

type DecisionRow = {
  decision_id: string;
  title: string;
  summary: string | null;
  kind: string;
  status: string;
  version: number;
  latest_event_type: string;
  superseded_by_decision_id: string | null;
  decided_by: string;
  updated_at: string;
  source_event_id: string;
};

type ClaimRow = {
  claim_id: string;
  principal: string;
  scope_json: string;
  intent: string | null;
  created_at: string;
  expires_at: string | null;
};

type BlockerRow = {
  blocker_id: string;
  summary: string | null;
  owner_principal: string | null;
  updated_at: string;
};

type ConflictEventRow = {
  event_id: string;
  payload_json: string;
  timestamp: string;
};

type RecentJoinRow = {
  name: string;
  joined_at: string;
  is_creator: number;
  coord_pref: string | null;
};

function tokenEstimate(obj: unknown): number {
  return Math.ceil(JSON.stringify(obj).length / 4);
}

function parseJsonStringArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

export function buildBriefing(
  db: Database,
  { space_id, principal, token_budget = 4000 }: BriefingInput
): BriefingResponse {
  // 1. current_plan — most recent non-superseded plan-kind decision
  let currentPlan: BriefingResponse['current_plan'] = null;
  try {
    const planRow = db
      .prepare(
        `SELECT decision_id, title, summary, updated_at, source_event_id
         FROM decisions
         WHERE space_id = ?1 AND kind = 'plan' AND status != 'superseded' AND tombstoned_at IS NULL
         ORDER BY source_event_id DESC LIMIT 1`
      )
      .get(space_id) as DecisionRow | null;

    if (planRow) {
      currentPlan = {
        title: planRow.title,
        summary: planRow.summary ?? '',
        last_updated: planRow.updated_at,
        source_decision_id: planRow.decision_id
      };
    }
  } catch {
    // decisions table may lack kind column if migration 002 not run
  }

  // 2. active_claims
  let activeClaims: BriefingResponse['active_claims'] = [];
  try {
    const claimRows = db
      .prepare(
        `SELECT claim_id, principal, scope_json, intent, created_at, expires_at
         FROM claims WHERE space_id = ?1 AND status = 'active' AND tombstoned_at IS NULL
         ORDER BY created_at DESC`
      )
      .all(space_id) as ClaimRow[];

    // Issue #10 / CONTEXT.md "Queue visibility": single pass over
    // pending_edits keyed by blocking_claim_id; surfaces the latter list
    // alongside each incumbent claim so consumers see the whole queue.
    let blockingByClaim: ReturnType<typeof loadBlockingPreviews> = new Map();
    try {
      blockingByClaim = loadBlockingPreviews(db, space_id);
    } catch {
      // pending_edits table absent in legacy fixtures (pre-migration 006).
    }

    activeClaims = claimRows.map((r) => {
      const queued = blockingByClaim.get(r.claim_id) ?? [];
      const blockingPrincipals = queued.map((q) => ({
        principal: q.blocked_principal,
        paths: q.paths
      }));
      return {
        principal: r.principal,
        scope: JSON.parse(r.scope_json) as Record<string, unknown>,
        intent: r.intent ?? '',
        claimed_at: r.created_at,
        ...(r.expires_at ? { expires_at: r.expires_at } : {}),
        ...(blockingPrincipals.length > 0
          ? { blocking_principals: blockingPrincipals }
          : {})
      };
    });
  } catch {
    // ignore
  }

  // 3. recent_decisions (kind ∈ {plan, architectural, product, process})
  let recentDecisions: BriefingResponse['recent_decisions'] = [];
  try {
    const decisionRows = db
      .prepare(
        `SELECT decision_id, title, summary, kind, status, version, latest_event_type, superseded_by_decision_id, decided_by, updated_at
         FROM decisions
         WHERE space_id = ?1 AND kind IN ('plan','architectural','product','process') AND tombstoned_at IS NULL
         ORDER BY updated_at DESC LIMIT 50`
      )
      .all(space_id) as DecisionRow[];

    recentDecisions = decisionRows.map((r) => ({
      id: r.decision_id,
      title: r.title,
      summary: r.summary ?? '',
      kind: r.kind,
      status: r.status,
      version: r.version,
      latest_event_type: r.latest_event_type,
      superseded_by_decision_id: r.superseded_by_decision_id,
      decided_by: r.decided_by,
      at: r.updated_at
    }));
  } catch {
    // decisions table may not have kind column yet
    try {
      const decisionRows = db
        .prepare(
          `SELECT decision_id, title, summary, status, updated_at, source_event_id
           FROM decisions WHERE space_id = ?1 AND tombstoned_at IS NULL ORDER BY updated_at DESC LIMIT 50`
        )
        .all(space_id) as DecisionRow[];

      recentDecisions = decisionRows.map((r) => ({
        id: r.decision_id,
        title: r.title,
        summary: r.summary ?? '',
        kind: 'architectural',
        status: r.status,
        version: 1,
        latest_event_type: 'decision_recorded',
        superseded_by_decision_id: null,
        decided_by: r.decided_by ?? '',
        at: r.updated_at
      }));
    } catch {
      // ignore
    }
  }

  // 4. active_risks
  let openBlockers: BriefingResponse['active_risks']['open_blockers'] = [];
  try {
    const blockerRows = db
      .prepare(
        `SELECT blocker_id, summary, owner_principal, updated_at
         FROM blockers WHERE space_id = ?1 AND status = 'open' AND tombstoned_at IS NULL
         ORDER BY updated_at DESC`
      )
      .all(space_id) as BlockerRow[];

    openBlockers = blockerRows.map((r) => ({
      blocker_id: r.blocker_id,
      summary: r.summary ?? '',
      owner_principal: r.owner_principal ?? '',
      updated_at: r.updated_at
    }));
  } catch {
    // ignore
  }

  // Standing conflicts: recent conflict_detected events with no matching conflict_resolved
  let standingConflicts: BriefingResponse['active_risks']['standing_conflicts'] =
    [];
  try {
    const conflictEvents = db
      .prepare(
        `SELECT event_id, payload_json, timestamp FROM events
         WHERE space_id = ?1 AND event_type = 'conflict_detected'
         ORDER BY timestamp DESC LIMIT 20`
      )
      .all(space_id) as ConflictEventRow[];

    const resolvedIds = new Set<string>(
      (
        db
          .prepare(
            `SELECT payload_json FROM events
             WHERE space_id = ?1 AND event_type = 'conflict_resolved'`
          )
          .all(space_id) as ConflictEventRow[]
      )
        .map((r) => {
          try {
            return (
              (JSON.parse(r.payload_json) as { conflict_id?: string })
                .conflict_id ?? ''
            );
          } catch {
            return '';
          }
        })
        .filter(Boolean)
    );

    standingConflicts = conflictEvents
      .map((r) => {
        let payload: { conflict_id?: string; summary?: string } = {};
        try {
          payload = JSON.parse(r.payload_json) as typeof payload;
        } catch {
          // ignore
        }
        return {
          event_id: r.event_id,
          conflict_id: payload.conflict_id,
          summary: payload.summary,
          at: r.timestamp
        };
      })
      .filter((c) => !c.conflict_id || !resolvedIds.has(c.conflict_id));
  } catch {
    // ignore
  }

  // 5. recent_progress — focus events from issue #15. Replaces the legacy
  // task_started/task_completed projection (those event types still exist
  // in EVENT_TYPES for historical reads but no v1 code path generates
  // them). The query already dedupes to most-recent-per-(principal,
  // scope_hash); we map paths/intent into the existing wire shape so
  // downstream consumers don't need to re-render.
  let recentProgress: BriefingResponse['recent_progress'] = [];
  try {
    const focusRows = loadRecentFocus(db, space_id, 20);
    recentProgress = focusRows.map((f) => ({
      principal: f.principal,
      task_id: f.focus_id,
      what:
        f.intent && f.intent.length > 0 ? f.intent : f.scope_paths.join(', '),
      at: f.started_at
    }));
  } catch {
    // focus table may not exist in legacy fixtures (pre-migration 018)
  }

  // 6. recent_joins — top 5 active members ordered by joined_at DESC (PM1 / AC25)
  let recentJoins: BriefingResponse['recent_joins'] = [];
  try {
    const joinRows = db
      .prepare(
        `SELECT name, joined_at, is_creator, coord_pref FROM members
         WHERE space_id = ?1 AND left_at IS NULL
         ORDER BY joined_at DESC LIMIT 5`
      )
      .all(space_id) as RecentJoinRow[];

    recentJoins = joinRows.map((r) => ({
      member_name: r.name,
      joined_at: r.joined_at,
      is_creator: r.is_creator === 1,
      coord_pref: normalizeCoordPref(r.coord_pref)
    }));
  } catch {
    // members table may not exist in legacy fixtures (pre-migration 003)
  }

  // 7. recent_findings — non-tombstoned, non-expired findings ordered by
  // severity (urgent > warning > info) then created_at DESC. Capped at 20.
  let recentFindings: BriefingResponse['recent_findings'] = [];
  try {
    const findingRows = db
      .prepare(
        `SELECT finding_id, kind, lifecycle, status, version, principal,
                summary, body, paths_json, tags_json, recipient_principals_json, severity,
                created_at, expires_at
           FROM findings
          WHERE space_id = ?1
            AND tombstoned_at IS NULL
            AND status = 'active'
            AND (
              expires_at IS NULL
              OR expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')
            )
          ORDER BY CASE severity
                     WHEN 'urgent'  THEN 0
                     WHEN 'warning' THEN 1
                     ELSE 2
                   END,
                   created_at DESC
          LIMIT 20`
      )
      .all(space_id) as Array<{
      finding_id: string;
      kind: 'finding' | 'gotcha';
      lifecycle: 'ttl' | 'persistent';
      status: 'active' | 'resolved' | 'archived';
      version: number;
      principal: string;
      summary: string;
      body: string | null;
      paths_json: string;
      tags_json: string;
      recipient_principals_json: string;
      severity: 'info' | 'warning' | 'urgent';
      created_at: string;
      expires_at: string | null;
    }>;
    recentFindings = findingRows
      .map((r) => {
        const paths = parseJsonStringArray(r.paths_json);
        const tags = parseJsonStringArray(r.tags_json);
        const recipientPrincipals = parseJsonStringArray(
          r.recipient_principals_json
        );
        const isHiddenDirectGotcha =
          r.kind === 'gotcha' &&
          recipientPrincipals.length > 0 &&
          r.principal !== principal &&
          !recipientPrincipals.includes(principal);

        if (isHiddenDirectGotcha) return null;

        return {
          finding_id: r.finding_id,
          kind: r.kind,
          lifecycle: r.lifecycle,
          status: r.status,
          version: r.version,
          principal: r.principal,
          summary: r.summary,
          ...(r.kind !== 'gotcha' && r.body && r.body.length > 0
            ? { body: r.body }
            : {}),
          paths,
          tags,
          severity: r.severity,
          created_at: r.created_at,
          expires_at: r.expires_at
        };
      })
      .filter(
        (finding): finding is BriefingResponse['recent_findings'][number] =>
          finding !== null
      );
  } catch {
    // findings table may not exist (pre-migration 014 fixtures)
  }

  // 8. recent_artifacts — non-tombstoned artifacts ordered by created_at
  // DESC. No TTL filter (artifacts are persistent). Capped at 10.
  let recentArtifacts: BriefingResponse['recent_artifacts'] = [];
  try {
    const artifactRows = db
      .prepare(
        `SELECT artifact_id, principal, kind, uri, title, summary, created_at
           FROM artifacts
          WHERE space_id = ?1
            AND tombstoned_at IS NULL
          ORDER BY created_at DESC
          LIMIT 10`
      )
      .all(space_id) as Array<{
      artifact_id: string;
      principal: string;
      kind: 'spec' | 'fixture' | 'doc' | 'snippet';
      uri: string;
      title: string;
      summary: string | null;
      created_at: string;
    }>;
    recentArtifacts = artifactRows.map((r) => ({
      artifact_id: r.artifact_id,
      principal: r.principal,
      kind: r.kind,
      uri: r.uri,
      title: r.title,
      ...(r.summary && r.summary.length > 0 ? { summary: r.summary } : {}),
      created_at: r.created_at
    }));
  } catch {
    // artifacts table may not exist (pre-migration 015 fixtures)
  }

  // Build response before truncation
  const response: BriefingResponse = {
    current_plan: currentPlan,
    active_claims: activeClaims,
    recent_decisions: recentDecisions,
    active_risks: {
      open_blockers: openBlockers,
      standing_conflicts: standingConflicts
    },
    recent_progress: recentProgress,
    recent_joins: recentJoins,
    recent_findings: recentFindings,
    recent_artifacts: recentArtifacts,
    meta: {
      token_estimate: 0,
      cursor:
        recentProgress.length > 0 ? (recentProgress[0]?.at ?? null) : null,
      lag_seconds: null,
      heuristic_trust: 'unverified'
    }
  };

  // AC17 truncation: drop oldest recent_progress first, then oldest recent_decisions
  // (excluding kind='plan' + status='open' from decision drop set)
  const coreEstimate = tokenEstimate({
    current_plan: response.current_plan,
    active_claims: response.active_claims
  });

  if (coreEstimate > token_budget) {
    response.meta.over_budget = true;
  } else {
    // Trim recent_progress from oldest first
    while (
      response.recent_progress.length > 0 &&
      tokenEstimate(response) > token_budget
    ) {
      response.recent_progress.pop();
    }

    // Trim recent_decisions (oldest first, skip plan+open)
    while (
      response.recent_decisions.length > 0 &&
      tokenEstimate(response) > token_budget
    ) {
      const lastIdx = response.recent_decisions.length - 1;
      const last = response.recent_decisions[lastIdx];
      if (last && last.kind === 'plan' && last.status === 'open') break;
      response.recent_decisions.pop();
    }
  }

  response.meta.token_estimate = tokenEstimate(response);
  return response;
}
