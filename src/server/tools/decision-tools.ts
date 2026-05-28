import type { ToolContext } from './context.js';
import type { DecisionKind, DecisionMutationData } from './context.js';
import type { ToolResponse } from '../types.js';

function decisionContextData(event: { sprint_id?: string | null }): {
  sprint_id: string | null;
  context: 'space' | 'sprint';
} {
  return {
    sprint_id: event.sprint_id ?? null,
    context: event.sprint_id == null ? 'space' : 'sprint'
  };
}

function targetDecisionSprintId(
  ctx: ToolContext,
  input: { space_id: string; principal: string; scope?: 'current' | 'space' }
): string | null {
  return input.scope === 'space'
    ? null
    : ctx.readCurrentSprintId(ctx.db, input.space_id, input.principal);
}

export function publishDecision(
  ctx: ToolContext,
  input: {
    space_id: string;
    principal: string;
    actor: string;
    delegation: string;
    decision_id: string;
    title: string;
    summary?: string;
    body?: string;
    kind?: DecisionKind;
    supersedes_decision_id?: string;
    scope?: 'current' | 'space';
  }
): ToolResponse<DecisionMutationData> {
  try {
    return ctx.db
      .transaction(() => {
        const targetSprintId = targetDecisionSprintId(ctx, input);
        if (
          ctx.readCurrentDecision(
            input.space_id,
            input.decision_id,
            targetSprintId
          )
        ) {
          return ctx.toolError(
            'decision_exists',
            `Decision ${input.decision_id} already exists; amend it instead`
          );
        }
        if (ctx.readCurrentDecision(input.space_id, input.decision_id)) {
          return ctx.toolError(
            'decision_exists',
            `Decision ${input.decision_id} exists outside the target context; use the matching scope to amend it`
          );
        }
        if (input.supersedes_decision_id) {
          const predecessor = ctx.readCurrentDecision(
            input.space_id,
            input.supersedes_decision_id,
            targetSprintId
          );
          if (!predecessor) {
            return ctx.toolError(
              'decision_not_found',
              `Unknown decision_id ${input.supersedes_decision_id}`
            );
          }
          if (predecessor.status === 'superseded') {
            return ctx.toolError(
              'decision_already_superseded',
              `Decision ${input.supersedes_decision_id} is already superseded`
            );
          }
        }

        const kind = input.kind ?? 'architectural';
        const event = ctx.decisionEvent(input, 'decision_published', {
          decision_id: input.decision_id,
          title: input.title,
          summary: input.summary ?? '',
          body: input.body ?? '',
          kind,
          version: 1,
          predecessor_decision_id: input.supersedes_decision_id ?? null
        });
        ctx.appendDecisionEventInTx(event);

        const affectedDecisionIds: string[] = [];
        const supersedeTargets = new Set<string>();
        if (input.supersedes_decision_id) {
          supersedeTargets.add(input.supersedes_decision_id);
        }
        if (kind === 'plan') {
          const priorPlans = ctx.db
            .prepare(
              `SELECT decision_id
               FROM decisions
              WHERE space_id = ?1
                AND kind = 'plan'
                AND ${
                  event.sprint_id == null
                    ? 'sprint_id IS NULL'
                    : 'sprint_id = ?3'
                }
                AND status != 'superseded'
                AND decision_id != ?2
                AND tombstoned_at IS NULL`
            )
            .all(
              ...(event.sprint_id == null
                ? [input.space_id, input.decision_id]
                : [input.space_id, input.decision_id, event.sprint_id])
            ) as Array<{
            decision_id: string;
          }>;
          for (const row of priorPlans) {
            supersedeTargets.add(row.decision_id);
          }
        }

        for (const targetDecisionId of supersedeTargets) {
          const superseded = ctx.supersedeDecisionInTx(
            input,
            targetDecisionId,
            input.decision_id
          );
          if (!superseded.ok) {
            throw new Error(superseded.error.message);
          }
          affectedDecisionIds.push(targetDecisionId);
        }

        return {
          ok: true,
          data: {
            event_id: event.event_id,
            decision_id: input.decision_id,
            ...decisionContextData(event),
            lifecycle_event: 'decision_published',
            version: 1,
            kind,
            status: 'open',
            superseded_by_decision_id: null,
            ...(affectedDecisionIds.length > 0
              ? { affected_decision_ids: affectedDecisionIds }
              : {})
          }
        };
      })
      .immediate() as ToolResponse<DecisionMutationData>;
  } catch (error) {
    return ctx.toolError(
      'decision_mutation_failed',
      'Failed to publish decision',
      { reason: (error as Error).message }
    );
  }
}

export function amendDecision(
  ctx: ToolContext,
  input: {
    space_id: string;
    principal: string;
    actor: string;
    delegation: string;
    decision_id: string;
    title?: string;
    summary?: string;
    body?: string;
    kind?: DecisionKind;
    scope?: 'current' | 'space';
  }
): ToolResponse<DecisionMutationData> {
  try {
    return ctx.db
      .transaction(() => {
        const current = ctx.readCurrentDecision(
          input.space_id,
          input.decision_id,
          targetDecisionSprintId(ctx, input)
        );
        if (!current) {
          return ctx.toolError(
            'decision_not_found',
            `Unknown decision_id ${input.decision_id}`
          );
        }
        if (current.status === 'superseded') {
          return ctx.toolError(
            'decision_already_superseded',
            `Decision ${input.decision_id} is already superseded`
          );
        }

        const nextVersion = current.version + 1;
        const event = ctx.decisionEvent(input, 'decision_amended', {
          decision_id: input.decision_id,
          title: input.title ?? current.title,
          summary: input.summary ?? current.summary ?? '',
          body: input.body ?? current.body ?? '',
          kind: input.kind ?? current.kind,
          version: nextVersion
        });
        ctx.appendDecisionEventInTx(event);
        return {
          ok: true,
          data: {
            event_id: event.event_id,
            decision_id: input.decision_id,
            ...decisionContextData(event),
            lifecycle_event: 'decision_amended',
            version: nextVersion,
            kind: String(event.payload.kind),
            status: 'open',
            superseded_by_decision_id: null
          }
        };
      })
      .immediate() as ToolResponse<DecisionMutationData>;
  } catch (error) {
    return ctx.toolError(
      'decision_mutation_failed',
      'Failed to amend decision',
      { reason: (error as Error).message }
    );
  }
}

export function supersedeDecision(
  ctx: ToolContext,
  input: {
    space_id: string;
    principal: string;
    actor: string;
    delegation: string;
    decision_id: string;
    superseded_by_decision_id?: string;
    scope?: 'current' | 'space';
  }
): ToolResponse<DecisionMutationData> {
  try {
    return ctx.db
      .transaction(() =>
        ctx.supersedeDecisionInTx(
          input,
          input.decision_id,
          input.superseded_by_decision_id ?? null
        )
      )
      .immediate() as ToolResponse<DecisionMutationData>;
  } catch (error) {
    return ctx.toolError(
      'decision_mutation_failed',
      'Failed to supersede decision',
      { reason: (error as Error).message }
    );
  }
}

export function recordDecision(
  ctx: ToolContext,
  input: {
    space_id: string;
    principal: string;
    actor: string;
    delegation: string;
    decision_id: string;
    title: string;
    summary?: string;
    body?: string;
    kind?: DecisionKind;
    scope?: 'current' | 'space';
  }
): ToolResponse<DecisionMutationData> {
  const targetSprintId = targetDecisionSprintId(ctx, input);
  const current = ctx.readCurrentDecision(
    input.space_id,
    input.decision_id,
    targetSprintId
  );
  if (!current) {
    if (ctx.readCurrentDecision(input.space_id, input.decision_id)) {
      return ctx.toolError(
        'decision_exists',
        `Decision ${input.decision_id} exists outside the target context; use the matching scope to amend it`
      );
    }
    try {
      return ctx.db
        .transaction(() => {
          const kind = input.kind ?? 'architectural';
          const event = ctx.decisionEvent(input, 'decision_published', {
            decision_id: input.decision_id,
            title: input.title,
            summary: input.summary ?? '',
            body: input.body ?? '',
            kind,
            version: 1,
            predecessor_decision_id: null
          });
          ctx.appendDecisionEventInTx(event);

          const affectedDecisionIds: string[] = [];
          if (kind === 'plan') {
            const priorPlans = ctx.db
              .prepare(
                `SELECT decision_id
                 FROM decisions
                WHERE space_id = ?1
                  AND kind = 'plan'
                  AND ${
                    event.sprint_id == null
                      ? 'sprint_id IS NULL'
                      : 'sprint_id = ?3'
                  }
                  AND status != 'superseded'
                  AND decision_id != ?2
                  AND tombstoned_at IS NULL`
              )
              .all(
                ...(event.sprint_id == null
                  ? [input.space_id, input.decision_id]
                  : [input.space_id, input.decision_id, event.sprint_id])
              ) as Array<{
              decision_id: string;
            }>;
            for (const row of priorPlans) {
              const superseded = ctx.supersedeDecisionInTx(
                input,
                row.decision_id,
                input.decision_id
              );
              if (!superseded.ok) {
                throw new Error(superseded.error.message);
              }
              affectedDecisionIds.push(row.decision_id);
            }
          }

          return {
            ok: true,
            data: {
              event_id: event.event_id,
              decision_id: input.decision_id,
              ...decisionContextData(event),
              lifecycle_event: 'decision_published' as const,
              version: 1,
              kind,
              status: 'open' as const,
              superseded_by_decision_id: null,
              ...(affectedDecisionIds.length > 0
                ? { affected_decision_ids: affectedDecisionIds }
                : {})
            }
          };
        })
        .immediate() as ToolResponse<DecisionMutationData>;
    } catch (error) {
      return ctx.toolError(
        'decision_mutation_failed',
        'Failed to record decision',
        { reason: (error as Error).message }
      );
    }
  }
  try {
    return ctx.db
      .transaction(() => {
        if (current.status === 'superseded') {
          return ctx.toolError(
            'decision_already_superseded',
            `Decision ${input.decision_id} is already superseded`
          );
        }
        const nextVersion = current.version + 1;
        const event = ctx.decisionEvent(input, 'decision_amended', {
          decision_id: input.decision_id,
          title: input.title,
          summary: input.summary ?? current.summary ?? '',
          body: input.body ?? current.body ?? '',
          kind: input.kind ?? current.kind,
          version: nextVersion
        });
        ctx.appendDecisionEventInTx(event);
        return {
          ok: true,
          data: {
            event_id: event.event_id,
            decision_id: input.decision_id,
            ...decisionContextData(event),
            lifecycle_event: 'decision_amended' as const,
            version: nextVersion,
            kind: String(event.payload.kind),
            status: 'open' as const,
            superseded_by_decision_id: null
          }
        };
      })
      .immediate() as ToolResponse<DecisionMutationData>;
  } catch (error) {
    return ctx.toolError(
      'decision_mutation_failed',
      'Failed to record decision',
      { reason: (error as Error).message }
    );
  }
}
