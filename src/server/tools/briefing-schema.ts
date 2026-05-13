import { z } from 'zod';

export const CurrentPlanSchema = z
  .object({
    title: z.string(),
    summary: z.string(),
    last_updated: z.string(),
    source_decision_id: z.string()
  })
  .nullable();

export const ActiveClaimSchema = z.object({
  principal: z.string(),
  scope: z.record(z.unknown()),
  intent: z.string(),
  claimed_at: z.string(),
  expires_at: z.string().optional(),
  // Issue #10 / CONTEXT.md "Queue visibility": principals waiting on this
  // claim. Visible to every space member so the incumbent gets a social
  // signal to release sooner. Empty when nothing is queued behind this
  // claim. Each entry includes the queued paths for surface-level context.
  blocking_principals: z
    .array(
      z.object({
        principal: z.string(),
        paths: z.array(z.string())
      })
    )
    .optional()
});

export const RecentDecisionSchema = z.object({
  id: z.string(),
  title: z.string(),
  summary: z.string(),
  kind: z.string(),
  status: z.string(),
  version: z.number(),
  latest_event_type: z.string(),
  superseded_by_decision_id: z.string().nullable(),
  decided_by: z.string(),
  at: z.string()
});

export const ActiveRisksSchema = z.object({
  open_blockers: z.array(
    z.object({
      blocker_id: z.string(),
      summary: z.string(),
      owner_principal: z.string(),
      updated_at: z.string()
    })
  ),
  standing_conflicts: z.array(
    z.object({
      event_id: z.string(),
      conflict_id: z.string().optional(),
      summary: z.string().optional(),
      at: z.string()
    })
  )
});

export const RecentProgressSchema = z.object({
  principal: z.string(),
  task_id: z.string(),
  what: z.string(),
  at: z.string()
});

export const BriefingMetaSchema = z.object({
  token_estimate: z.number(),
  cursor: z.string().nullable(),
  lag_seconds: z.number().nullable(),
  heuristic_trust: z.enum(['unverified', 'observed']),
  over_budget: z.boolean().optional()
});

export const RecentJoinSchema = z.object({
  member_name: z.string(),
  joined_at: z.string(),
  is_creator: z.boolean(),
  // issue #9 — coordination preference is part of the member's public-facing
  // identity in the briefing; latter-side agents see what mode each
  // teammate prefers when planning around active claims.
  coord_pref: z.enum(['auto-skip', 'auto-discuss'])
});

export const RecentFindingSchema = z.object({
  finding_id: z.string(),
  kind: z.enum(['finding', 'gotcha']),
  lifecycle: z.enum(['ttl', 'persistent']),
  status: z.enum(['active', 'resolved', 'archived']),
  version: z.number().int().positive(),
  principal: z.string(),
  summary: z.string(),
  body: z.string().optional(),
  paths: z.array(z.string()),
  tags: z.array(z.string()),
  severity: z.enum(['info', 'warning', 'urgent']),
  created_at: z.string(),
  expires_at: z.string().nullable()
});

export const RecentArtifactSchema = z.object({
  artifact_id: z.string(),
  principal: z.string(),
  kind: z.enum(['spec', 'fixture', 'doc', 'snippet']),
  uri: z.string(),
  title: z.string(),
  summary: z.string().optional(),
  created_at: z.string()
});

export const BriefingResponseSchema = z.object({
  current_plan: CurrentPlanSchema,
  active_claims: z.array(ActiveClaimSchema),
  recent_decisions: z.array(RecentDecisionSchema),
  active_risks: ActiveRisksSchema,
  recent_progress: z.array(RecentProgressSchema),
  recent_joins: z.array(RecentJoinSchema),
  recent_findings: z.array(RecentFindingSchema),
  recent_artifacts: z.array(RecentArtifactSchema),
  meta: BriefingMetaSchema
});

export type BriefingResponse = z.infer<typeof BriefingResponseSchema>;
