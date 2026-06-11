import { z } from 'zod';
import type { BridgeHttpClient } from './http-client.js';

/**
 * Unwrap one level of envelope: client.post returns
 *   { ok: true, data: <server-response> } | { ok: false, status, error, body }
 * where <server-response> is itself the tool's `{ ok, data }` shape.
 *
 * MCP/argv consumers want the server's `{ ok, data }` directly, not double-wrapped.
 * On transport error, return the error envelope unchanged so callers can inspect it.
 */
async function callServer(
  client: BridgeHttpClient,
  path: string,
  input: unknown
): Promise<unknown> {
  const res = await client.post(path, input);
  return res.ok ? res.data : res;
}

const ScopeSchema = z.object({
  paths: z.array(z.string()).optional(),
  modules: z.array(z.string()).optional(),
  contracts: z.array(z.string()).optional()
});
const FlexibleScopeSchema = z.preprocess((value) => {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}, ScopeSchema);
const PositiveIntSchema = z.coerce.number().int().positive();
const DecisionMutationResponseSchema = z.object({
  ok: z.literal(true),
  data: z.object({
    event_id: z.string(),
    decision_id: z.string(),
    sprint_id: z.string().nullable(),
    context: z.enum(['space', 'sprint']),
    lifecycle_event: z.enum([
      'decision_published',
      'decision_amended',
      'decision_superseded'
    ]),
    version: z.number().int().positive(),
    kind: z.string(),
    status: z.enum(['open', 'superseded']),
    superseded_by_decision_id: z.string().nullable(),
    affected_decision_ids: z.array(z.string()).optional()
  })
});
const BlockerMutationResponseSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    data: z.object({
      blocker_id: z.string(),
      event_id: z.string(),
      sprint_id: z.string().nullable(),
      context: z.enum(['space', 'sprint']),
      status: z.enum(['open', 'resolved'])
    })
  }),
  z.object({
    ok: z.literal(false),
    error: z.object({
      code: z.enum([
        'invalid_summary',
        'invalid_blocker_id',
        'blocker_not_found',
        'sprint_context_unavailable'
      ]),
      message: z.string(),
      details: z.unknown().optional()
    })
  })
]);
const SprintSummarySchema = z.object({
  sprint_id: z.string(),
  slug: z.string(),
  display_name: z.string(),
  goal: z.string(),
  status: z.enum(['active', 'archived'])
});
const SprintContextSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('space'), sprint: z.null() }),
  z.object({ mode: z.literal('sprint'), sprint: SprintSummarySchema })
]);
const SprintLifecycleResponseSchema = z.object({
  ok: z.literal(true),
  data: z.object({
    sprint: SprintSummarySchema.nullable(),
    old_context: SprintContextSchema,
    new_context: SprintContextSchema,
    event_ids: z.array(z.string()),
    idempotent: z.boolean(),
    message: z.string(),
    warnings: z.array(z.string())
  })
});
const SprintInventoryItemSchema = SprintSummarySchema.extend({
  current_members: z.array(z.string()),
  last_activity_at: z.string().nullable()
});
const SprintArchiveResponseSchema = z.object({
  ok: z.literal(true),
  data: z.object({
    sprint: SprintSummarySchema,
    event_ids: z.array(z.string()),
    idempotent: z.boolean(),
    released_claims: z.array(
      z.object({
        claim_id: z.string(),
        original_holder: z.string(),
        event_id: z.string()
      })
    ),
    message: z.string()
  })
});
const SprintHistoryResponseSchema = z.object({
  ok: z.literal(true),
  data: z.object({
    sprint: SprintSummarySchema,
    events: z.array(
      z.object({
        event_id: z.string(),
        event_type: z.string(),
        timestamp: z.string(),
        principal: z.string(),
        sprint_id: z.string(),
        summary: z.string(),
        payload: z.record(z.unknown())
      })
    ),
    limit: z.number().int().positive(),
    truncated: z.boolean()
  })
});
const ActiveClaimResponseSchema = z.object({
  principal: z.string(),
  scope: z.record(z.unknown()),
  intent: z.string(),
  claimed_at: z.string(),
  expires_at: z.string().optional(),
  blocking_principals: z
    .array(
      z.object({
        principal: z.string(),
        paths: z.array(z.string())
      })
    )
    .optional()
});
const BriefingContextResponseSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('space'),
    sprint: z.null(),
    routing_reasons: z.array(z.string())
  }),
  z.object({
    mode: z.literal('sprint'),
    sprint: SprintSummarySchema.extend({
      current_members: z.array(z.string())
    }),
    routing_reasons: z.array(z.string())
  })
]);
const BriefingResponseSchema = z.object({
  ok: z.literal(true),
  data: z.object({
    current_context: BriefingContextResponseSchema,
    current_plan: z
      .object({
        title: z.string(),
        summary: z.string(),
        last_updated: z.string(),
        source_decision_id: z.string()
      })
      .nullable(),
    active_claims: z.array(ActiveClaimResponseSchema),
    recent_decisions: z.array(
      z.object({
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
      })
    ),
    active_risks: z.object({
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
    }),
    recent_progress: z.array(
      z.object({
        principal: z.string(),
        task_id: z.string(),
        what: z.string(),
        at: z.string()
      })
    ),
    recent_notifications: z.array(
      z.object({
        event_id: z.string(),
        event_type: z.string(),
        principal: z.string(),
        summary: z.string(),
        created_at: z.string(),
        sprint_id: z.string().nullable(),
        delivery_scope: z.enum(['direct', 'sprint', 'space']),
        routing_reason: z.enum([
          'current_sprint',
          'direct_to_me',
          'space_wide_announcement',
          'space_mode'
        ])
      })
    ),
    outside_current_context: z.object({
      active_claims: z.array(ActiveClaimResponseSchema)
    }),
    recent_joins: z.array(
      z.object({
        member_name: z.string(),
        joined_at: z.string(),
        is_creator: z.boolean(),
        coord_pref: z.enum(['auto-skip', 'auto-discuss'])
      })
    ),
    recent_findings: z.array(
      z.object({
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
      })
    ),
    recent_artifacts: z.array(
      z.object({
        artifact_id: z.string(),
        principal: z.string(),
        kind: z.enum(['spec', 'fixture', 'doc', 'snippet']),
        uri: z.string(),
        title: z.string(),
        summary: z.string().optional(),
        created_at: z.string()
      })
    ),
    meta: z.object({
      token_estimate: z.number(),
      cursor: z.string().nullable(),
      lag_seconds: z.number().nullable(),
      heuristic_trust: z.enum(['unverified', 'observed']),
      over_budget: z.boolean().optional(),
      cross_context_overlap_awareness: z
        .object({
          overlapping_claims: z.number().int().nonnegative()
        })
        .optional()
    })
  })
});
const DeliveryScopeSchema = z.enum(['direct', 'sprint', 'space']);
const EventEnvelopeResponseSchema = z
  .object({
    schema_version: z.literal('1.0'),
    event_id: z.string(),
    idempotency_key: z.string(),
    space_id: z.string(),
    timestamp: z.string(),
    principal: z.string(),
    actor: z.string(),
    delegation: z.string(),
    event_type: z.string(),
    sprint_id: z.string().nullable(),
    delivery_scope: DeliveryScopeSchema,
    recipient_principals: z.array(z.string()).optional(),
    scope: ScopeSchema,
    payload: z.record(z.unknown()),
    refs: z
      .object({
        branch: z.string().optional(),
        commit: z.string().optional(),
        pr: z.string().optional()
      })
      .optional(),
    confidence: z.number().optional()
  })
  .passthrough();

export type ToolBinding = {
  description: string;
  inputSchema: z.ZodTypeAny;
  responseSchema?: z.ZodTypeAny;
  handler: (input: unknown, client: BridgeHttpClient) => Promise<unknown>;
};

export const TOOL_BINDINGS: Record<string, ToolBinding> = {
  'teamem.get_updates': {
    description:
      'Fetch recent events from the team event log. Pass a cursor to get only events since your last call.',
    inputSchema: z
      .object({
        since: z.string().optional(),
        limit: PositiveIntSchema.max(500).optional()
      })
      .passthrough(),
    responseSchema: z.object({
      ok: z.literal(true),
      data: z
        .object({
          events: z.array(EventEnvelopeResponseSchema),
          next_cursor: z.string().nullable()
        })
        .passthrough()
    }),
    handler: async (input, client) =>
      callServer(client, '/tools/teamem.get_updates', input)
  },

  'teamem.claim_scope': {
    description:
      'Reserve a code area you are about to edit so teammates agents can see your in-flight work and avoid overlapping changes. On overlap with another principal, returns a typed `{ok:false, error:{code:"scope_conflict", conflicting_claim_id, conflicting_principal, colliding_paths, requester_coord_pref, incumbent_coord_pref, message}}` — never a thrown exception.',
    inputSchema: z
      .object({
        scope: FlexibleScopeSchema,
        intent: z.string().optional()
      })
      .passthrough(),
    // AC-NEW-7: discriminated union of success + scope_conflict shapes.
    // Bridge returns ok:false verbatim — it does NOT throw on conflict.
    responseSchema: z.discriminatedUnion('ok', [
      z.object({
        ok: z.literal(true),
        data: z.object({
          claim_id: z.string(),
          // PRD §150: on_commit and manual_only claims have NULL expires_at;
          // only ttl mode produces a timestamp.
          expires_at: z.string().nullable()
        })
      }),
      z.object({
        ok: z.literal(false),
        error: z.object({
          code: z.union([
            z.literal('scope_conflict'),
            z.literal('scope_conflict_self_widening'),
            z.literal('claim_paused_by_peer')
          ]),
          message: z.string(),
          conflicting_claim_id: z.string(),
          conflicting_principal: z.string(),
          colliding_paths: z.array(z.string()),
          requester_coord_pref: z
            .enum(['auto-skip', 'auto-discuss'])
            .optional(),
          incumbent_coord_pref: z
            .enum(['auto-skip', 'auto-discuss'])
            .optional(),
          // claim_paused_by_peer carries pause annotations so the agent can
          // surface a precise message (which peer, which branch, since when).
          paused_at: z.string().optional(),
          paused_reason: z.string().optional()
        })
      })
    ]),
    handler: async (input, client) =>
      callServer(client, '/tools/teamem.claim_scope', input)
  },

  'teamem.release_scope': {
    description:
      'Release a previously claimed scope after your edit is complete or abandoned.',
    inputSchema: z
      .object({
        claim_id: z.string()
      })
      .passthrough(),
    handler: async (input, client) =>
      callServer(client, '/tools/teamem.release_scope', input)
  },

  'teamem.release_scope_via_git': {
    description:
      'Called by the post-commit git hook to release claims for committed paths based on git evidence (HEAD advanced, working tree clean, branch matches).',
    inputSchema: z
      .object({
        repo_id: z.string(),
        branch: z.string(),
        paths_with_status: z.array(
          z.object({
            status: z.enum(['M', 'A', 'D', 'R']),
            path: z.string(),
            old_path: z.string().optional()
          })
        ),
        current_head_sha: z.string(),
        porcelain_dirty_paths: z.array(z.string())
      })
      .passthrough(),
    handler: async (input, client) =>
      callServer(client, '/tools/teamem.release_scope_via_git', input)
  },

  'teamem.publish_decision': {
    description:
      'Publish a new durable team decision with explicit lifecycle state. Use supersedes_decision_id to mark an older decision as replaced without losing history.',
    inputSchema: z
      .object({
        decision_id: z.string(),
        title: z.string(),
        summary: z.string().optional(),
        body: z.string().optional(),
        kind: z
          .enum(['plan', 'architectural', 'product', 'process'])
          .optional(),
        supersedes_decision_id: z.string().optional(),
        scope: z.enum(['current', 'space']).optional()
      })
      .passthrough(),
    responseSchema: DecisionMutationResponseSchema,
    handler: async (input, client) =>
      callServer(client, '/tools/teamem.publish_decision', input)
  },

  'teamem.amend_decision': {
    description:
      'Append an explicit amendment to an existing decision. This preserves history and bumps the visible current version.',
    inputSchema: z
      .object({
        decision_id: z.string(),
        title: z.string().optional(),
        summary: z.string().optional(),
        body: z.string().optional(),
        kind: z
          .enum(['plan', 'architectural', 'product', 'process'])
          .optional(),
        scope: z.enum(['current', 'space']).optional()
      })
      .passthrough(),
    responseSchema: DecisionMutationResponseSchema,
    handler: async (input, client) =>
      callServer(client, '/tools/teamem.amend_decision', input)
  },

  'teamem.supersede_decision': {
    description:
      'Mark an existing decision as superseded without deleting its prior rationale. Optionally reference the successor decision id.',
    inputSchema: z
      .object({
        decision_id: z.string(),
        superseded_by_decision_id: z.string().optional(),
        scope: z.enum(['current', 'space']).optional()
      })
      .passthrough(),
    responseSchema: DecisionMutationResponseSchema,
    handler: async (input, client) =>
      callServer(client, '/tools/teamem.supersede_decision', input)
  },

  'teamem.record_decision': {
    description:
      'Backward-compatible wrapper over the explicit decision lifecycle. New ids publish a decision; reused ids append an explicit amendment instead of silently overwriting history.',
    inputSchema: z
      .object({
        decision_id: z.string(),
        title: z.string(),
        summary: z.string().optional(),
        body: z.string().optional(),
        kind: z.enum(['plan', 'architectural', 'product', 'process']).optional()
      })
      .passthrough(),
    responseSchema: DecisionMutationResponseSchema,
    handler: async (input, client) =>
      callServer(client, '/tools/teamem.record_decision', input)
  },

  'teamem.get_contract_state': {
    description:
      'Retrieve the current state of all contracts (API surfaces, schemas) for a repo.',
    inputSchema: z.object({}).passthrough(),
    handler: async (input, client) =>
      callServer(client, '/tools/teamem.get_contract_state', input)
  },

  'teamem.get_briefing': {
    description:
      'Call this once at session start/resume, when the human explicitly asks for a refresh, or when context is stale. Do not repeat a full briefing before every edit; edit-time coordination uses claim/conflict tools. Pass `token_budget` to constrain output size. Pass bridge-only `space` when a session-pinned space should override the bridge default.',
    inputSchema: z
      .object({
        principal: z.string().optional(),
        space: z.string().optional(),
        token_budget: PositiveIntSchema.optional()
      })
      .passthrough(),
    responseSchema: BriefingResponseSchema,
    handler: async (input, client) =>
      callServer(client, '/tools/teamem.get_briefing', input)
  },

  'teamem.export_space_rules_snapshot': {
    description:
      'Fetch the current server-authored Space Rules snapshot for the active space. Returns the rendered rules body plus exact managed-block metadata, including a deterministic hash that excludes generated_at.',
    inputSchema: z.object({}).passthrough(),
    responseSchema: z.object({
      ok: z.literal(true),
      data: z.object({
        has_server_rules: z.boolean(),
        rendered_rules_body: z.string(),
        metadata: z.object({
          format_version: z.literal(1),
          source: z.enum(['server', 'none']),
          managed_begin: z.string(),
          managed_end: z.string(),
          rules_version: z.number().int().nonnegative(),
          rules_hash: z.string(),
          generated_at: z.string(),
          space_id: z.string(),
          space_label: z.string(),
          source_event_id: z.string().nullable(),
          snapshot_updated_at: z.string().nullable(),
          snapshot_updated_by: z.string().nullable()
        })
      })
    }),
    handler: async (input, client) =>
      callServer(client, '/tools/teamem.export_space_rules_snapshot', input)
  },

  'teamem.update_space_rules': {
    description:
      'Publish creator-only Space Rules from a local TEAMEM.md draft using optimistic concurrency. Submit the local draft body plus base_version and base_hash from the managed-block metadata; success returns the regenerated server snapshot, stale drafts return a typed conflict.',
    inputSchema: z
      .object({
        rules_markdown: z.string(),
        base_version: z.number().int().nonnegative(),
        base_hash: z.string().min(1)
      })
      .passthrough(),
    responseSchema: z.discriminatedUnion('ok', [
      z.object({
        ok: z.literal(true),
        data: z.object({
          has_server_rules: z.boolean(),
          rendered_rules_body: z.string(),
          metadata: z.object({
            format_version: z.literal(1),
            source: z.enum(['server', 'none']),
            managed_begin: z.string(),
            managed_end: z.string(),
            rules_version: z.number().int().nonnegative(),
            rules_hash: z.string(),
            generated_at: z.string(),
            space_id: z.string(),
            space_label: z.string(),
            source_event_id: z.string().nullable(),
            snapshot_updated_at: z.string().nullable(),
            snapshot_updated_by: z.string().nullable()
          })
        })
      }),
      z.object({
        ok: z.literal(false),
        error: z.object({
          code: z.literal('space_rules_conflict'),
          message: z.string(),
          details: z.object({
            current_version: z.number().int().nonnegative(),
            current_hash: z.string(),
            current_source_event_id: z.string().nullable(),
            has_server_rules: z.boolean()
          })
        })
      })
    ]),
    handler: async (input, client) =>
      callServer(client, '/tools/teamem.update_space_rules', input)
  },

  'teamem.whoami': {
    description:
      "Return the caller's identity for the resolved space — `{ principal, space_id, label }`. Use this when you need to know who you are in the current space without depending on environment variables. The principal is taken from the verified JWT (server-authoritative); no client-supplied input is honored.",
    inputSchema: z.object({}).passthrough(),
    responseSchema: z.object({
      ok: z.literal(true),
      data: z.object({
        principal: z.string(),
        space_id: z.string(),
        label: z.string()
      })
    }),
    handler: async (input, client) =>
      callServer(client, '/tools/teamem.whoami', input)
  },

  'teamem.create_sprint': {
    description:
      'Create a Sprint in the current Space and join it. Display names and goals are trimmed; the immutable slug is derived from the display name. Duplicate names/slugs return a typed error with join/reopen hint.',
    inputSchema: z
      .object({
        display_name: z.string().min(1).max(80).optional(),
        name: z.string().min(1).max(80).optional(),
        goal: z.string().min(1).max(500)
      })
      .passthrough(),
    responseSchema: SprintLifecycleResponseSchema,
    handler: async (input, client) =>
      callServer(client, '/tools/teamem.create_sprint', input)
  },

  'teamem.join_sprint': {
    description:
      'Join an active Sprint by slug or sprint_id. Switching Sprints reports old and new context; joining the current Sprint is idempotent and emits no lifecycle event.',
    inputSchema: z
      .object({
        sprint: z.string().min(1)
      })
      .passthrough(),
    responseSchema: SprintLifecycleResponseSchema,
    handler: async (input, client) =>
      callServer(client, '/tools/teamem.join_sprint', input)
  },

  'teamem.leave_sprint': {
    description:
      'Leave the current Sprint and return to Space mode. Leaving while already in Space mode is idempotent and emits no lifecycle event.',
    inputSchema: z.object({}).passthrough(),
    responseSchema: SprintLifecycleResponseSchema,
    handler: async (input, client) =>
      callServer(client, '/tools/teamem.leave_sprint', input)
  },

  'teamem.get_current_sprint': {
    description:
      'Inspect the server-authoritative current Sprint for this principal in the current Space. Space mode means no Sprint.',
    inputSchema: z.object({}).passthrough(),
    responseSchema: z.object({
      ok: z.literal(true),
      data: z.object({
        context: SprintContextSchema,
        sprint: SprintSummarySchema.nullable(),
        current_members: z.array(z.string())
      })
    }),
    handler: async (input, client) =>
      callServer(client, '/tools/teamem.get_current_sprint', input)
  },

  'teamem.list_sprints': {
    description:
      'List active and archived Sprints in the current Space as compact inventory: slug, display name, state, goal, current members, and last activity.',
    inputSchema: z.object({}).passthrough(),
    responseSchema: z.object({
      ok: z.literal(true),
      data: z.object({
        sprints: z.array(SprintInventoryItemSchema)
      })
    }),
    handler: async (input, client) =>
      callServer(client, '/tools/teamem.list_sprints', input)
  },

  'teamem.archive_sprint': {
    description:
      'Archive an active Sprint after every member has left. Remaining active claims tied to that Sprint are force-released with direct owner notices only.',
    inputSchema: z
      .object({
        sprint: z.string().min(1)
      })
      .passthrough(),
    responseSchema: SprintArchiveResponseSchema,
    handler: async (input, client) =>
      callServer(client, '/tools/teamem.archive_sprint', input)
  },

  'teamem.reopen_sprint': {
    description:
      'Explicitly reopen an archived Sprint, auto-join the actor, and leave their previous Sprint if any. Active Sprints should be joined, not reopened.',
    inputSchema: z
      .object({
        sprint: z.string().min(1)
      })
      .passthrough(),
    responseSchema: SprintLifecycleResponseSchema,
    handler: async (input, client) =>
      callServer(client, '/tools/teamem.reopen_sprint', input)
  },

  'teamem.get_sprint_history': {
    description:
      'Read bounded lifecycle-focused history for a Sprint by slug or id. This is explicit, read-only, and non-live.',
    inputSchema: z
      .object({
        sprint: z.string().min(1),
        limit: PositiveIntSchema.max(100).optional()
      })
      .passthrough(),
    responseSchema: SprintHistoryResponseSchema,
    handler: async (input, client) =>
      callServer(client, '/tools/teamem.get_sprint_history', input)
  },

  'teamem.post_message': {
    description:
      'Post a discussion message to a teammate or broadcast. Null/omitted recipient_principal broadcasts to the current Sprint in Sprint mode and the Space in Space mode; "*" broadcasts to the current Sprint in Sprint mode and remains Space-wide in Space mode; "**" explicitly escalates Space-wide. Use to coordinate on claim conflicts, handoff requests, or share context. Omit thread_id to start a new thread.',
    inputSchema: z
      .object({
        body: z.string().min(1).max(65536),
        recipient_principal: z.string().nullable().optional(),
        thread_id: z.string().max(64).optional(),
        in_reply_to: z.string().max(64).optional(),
        request_id: z.string().optional()
      })
      .passthrough(),
    responseSchema: z.object({
      ok: z.literal(true),
      data: z.object({
        message_id: z.string(),
        thread_id: z.string(),
        event_id: z.string(),
        delivery_scope: DeliveryScopeSchema,
        sprint_id: z.string().nullable(),
        recipient_principals: z.array(z.string()),
        broadcast_hint: z.string().optional()
      })
    }),
    handler: async (input, client) =>
      callServer(client, '/tools/teamem.post_message', input)
  },

  'teamem.read_thread': {
    description:
      'Read discussion messages addressed to you (or that you sent), or the full message list of a specific thread. Pass thread_id to scope to one thread; pass since (ISO timestamp) for incremental polling.',
    inputSchema: z
      .object({
        thread_id: z.string().optional(),
        since: z.string().optional(),
        limit: PositiveIntSchema.max(200).optional()
      })
      .passthrough(),
    responseSchema: z.object({
      ok: z.literal(true),
      data: z.object({
        messages: z.array(
          z.object({
            message_id: z.string(),
            thread_id: z.string(),
            sender_principal: z.string(),
            recipient_principal: z.string().nullable(),
            body: z.string(),
            in_reply_to: z.string().nullable(),
            created_at: z.string()
          })
        )
      })
    }),
    handler: async (input, client) =>
      callServer(client, '/tools/teamem.read_thread', input)
  },

  'teamem.raise_blocker': {
    description:
      'Raise an open blocker in your current context. In Sprint mode this defaults to the current Sprint; pass scope="space" only for an explicit Space-wide escalation.',
    inputSchema: z
      .object({
        summary: z.string().min(1).max(1000),
        scope: z.enum(['current', 'space']).optional()
      })
      .passthrough(),
    responseSchema: BlockerMutationResponseSchema,
    handler: async (input, client) =>
      callServer(client, '/tools/teamem.raise_blocker', input)
  },

  'teamem.resolve_blocker': {
    description:
      'Resolve an open blocker in your current context. In Sprint mode this will not resolve Space blockers unless scope="space" is passed explicitly.',
    inputSchema: z
      .object({
        blocker_id: z.string().min(1),
        resolution: z.string().optional(),
        scope: z.enum(['current', 'space']).optional()
      })
      .passthrough(),
    responseSchema: BlockerMutationResponseSchema,
    handler: async (input, client) =>
      callServer(client, '/tools/teamem.resolve_blocker', input)
  },

  'teamem.update_coord_pref': {
    description:
      'Set your coordination preference for scope conflicts. The active plugin mode is `auto-skip` (queue and remind). `auto-discuss` remains accepted only for legacy/server compatibility while negotiator automation is postponed. Updates only your own member row.',
    inputSchema: z
      .object({
        value: z.enum(['auto-skip', 'auto-discuss'])
      })
      .passthrough(),
    responseSchema: z.object({
      ok: z.literal(true),
      data: z.object({
        coord_pref: z.enum(['auto-skip', 'auto-discuss'])
      })
    }),
    handler: async (input, client) =>
      callServer(client, '/tools/teamem.update_coord_pref', input)
  },

  'teamem.share_finding': {
    description:
      'Share either a TTL finding or a persistent gotcha with the team. Default `kind` is `finding` and auto-expires after 7 days. Set `kind: "gotcha"` for durable Space Memory with nullable `expires_at`, lifecycle/status metadata, structured paths, and version identity from v1. severity=urgent ALERTs every consumer; warning ALERTs only consumers whose recent claim/focus paths overlap a tag; info is silent unless tag overlap.',
    inputSchema: z
      .object({
        summary: z.string().min(1).max(280),
        body: z.string().optional(),
        kind: z.enum(['finding', 'gotcha']).optional(),
        status: z.enum(['active', 'resolved', 'archived']).optional(),
        paths: z.array(z.string()).optional(),
        tags: z.array(z.string()).max(32).optional(),
        recipient_principals: z.array(z.string()).optional(),
        severity: z.enum(['info', 'warning', 'urgent']).optional(),
        scope: z.enum(['current', 'space']).optional(),
        refs: z
          .object({
            paths: z.array(z.string()).optional(),
            modules: z.array(z.string()).optional()
          })
          .optional()
      })
      .passthrough(),
    responseSchema: z.object({
      ok: z.literal(true),
      data: z.object({
        finding_id: z.string(),
        event_id: z.string(),
        kind: z.enum(['finding', 'gotcha']),
        lifecycle: z.enum(['ttl', 'persistent']),
        status: z.enum(['active', 'resolved', 'archived']),
        version: z.number().int().positive(),
        expires_at: z.string().nullable(),
        sprint_id: z.string().nullable(),
        context: z.enum(['space', 'sprint'])
      })
    }),
    handler: async (input, client) =>
      callServer(client, '/tools/teamem.share_finding', input)
  },

  'teamem.get_finding': {
    description:
      'Fetch full finding or gotcha details by id. Use this to read the full durable gotcha body and metadata after a compact notice or briefing summary.',
    inputSchema: z
      .object({
        finding_id: z.string().min(1)
      })
      .passthrough(),
    responseSchema: z.discriminatedUnion('ok', [
      z.object({
        ok: z.literal(true),
        data: z.object({
          finding_id: z.string(),
          kind: z.enum(['finding', 'gotcha']),
          lifecycle: z.enum(['ttl', 'persistent']),
          status: z.enum(['active', 'resolved', 'archived']),
          version: z.number().int().positive(),
          principal: z.string(),
          summary: z.string(),
          body: z.string().nullable(),
          paths: z.array(z.string()),
          tags: z.array(z.string()),
          recipient_principals: z.array(z.string()),
          severity: z.enum(['info', 'warning', 'urgent']),
          refs: z
            .object({
              paths: z.array(z.string()).optional(),
              modules: z.array(z.string()).optional()
            })
            .nullable(),
          created_at: z.string(),
          expires_at: z.string().nullable(),
          source_event_id: z.string()
        })
      }),
      z.object({
        ok: z.literal(false),
        error: z.object({
          code: z.enum(['invalid_finding_id', 'finding_not_found']),
          message: z.string()
        })
      })
    ]),
    handler: async (input, client) =>
      callServer(client, '/tools/teamem.get_finding', input)
  },

  'teamem.acknowledge_finding': {
    description:
      'Record that you have seen a finding or gotcha version. Acknowledgements are per principal plus version, idempotent, and mean "seen" rather than "agreed".',
    inputSchema: z
      .object({
        finding_id: z.string().min(1),
        version: PositiveIntSchema.optional(),
        note: z.string().optional()
      })
      .passthrough(),
    responseSchema: z.discriminatedUnion('ok', [
      z.object({
        ok: z.literal(true),
        data: z.object({
          finding_id: z.string(),
          version: z.number().int().positive(),
          acknowledged_at: z.string(),
          already_acknowledged: z.boolean(),
          meaning: z.literal('seen')
        })
      }),
      z.object({
        ok: z.literal(false),
        error: z.object({
          code: z.enum([
            'invalid_finding_id',
            'finding_not_found',
            'invalid_version',
            'acknowledgements_unavailable'
          ]),
          message: z.string()
        })
      })
    ]),
    handler: async (input, client) =>
      callServer(client, '/tools/teamem.acknowledge_finding', input)
  },

  'teamem.share_artifact': {
    description:
      'Share a typed artifact reference with the team (issue #14). Persistent — no TTL, surfaces in the briefing under `recent_artifacts` until the space is wiped. Use for produced things teammates should be able to find later: a spec doc, a test fixture, a long-form doc, a code snippet. `kind` is one of spec | fixture | doc | snippet. Artifacts are pull-through briefing items, not interruptive alerts.',
    inputSchema: z
      .object({
        kind: z.enum(['spec', 'fixture', 'doc', 'snippet']),
        uri: z.string().min(1).max(1024),
        title: z.string().min(1).max(200),
        summary: z.string().optional()
      })
      .passthrough(),
    responseSchema: z.object({
      ok: z.literal(true),
      data: z.object({
        artifact_id: z.string(),
        event_id: z.string()
      })
    }),
    handler: async (input, client) =>
      callServer(client, '/tools/teamem.share_artifact', input)
  },

  'teamem.request_edit_permission': {
    description:
      'Legacy/internal primitive (issue #11). Request edit permission from the incumbent of a foreign claim. Preserved for future autonomous discussion flows, but not used as a selectable coordination mode. Server long-polls up to 60s by default; resolves with `action: "allow"` or `action: "skip"`. Per-space cap: max(20, 2 × active_members) outstanding requests; 21st returns `429 too_many_pending_requests`.',
    inputSchema: z
      .object({
        blocking_claim_id: z.string().min(1),
        paths: z.array(z.string()).min(1),
        intent: z.string().optional()
      })
      .passthrough(),
    responseSchema: z.object({
      ok: z.literal(true),
      data: z.object({
        req_id: z.string(),
        action: z.enum(['allow', 'skip', 'pending']),
        claim_id: z.string().optional(),
        expires_at: z.string().optional(),
        reason: z.enum(['denied_by_incumbent', 'timeout']).optional()
      })
    }),
    handler: async (input, client) =>
      callServer(client, '/tools/teamem.request_edit_permission', input)
  },

  'teamem.respond_permission_request': {
    description:
      "Legacy/internal primitive (issue #11). Incumbent responds to a pending permission request with `accept` or `deny`. On accept the server atomically narrows the incumbent's claim (releasing only the requested paths) and mints a fresh claim for the requester. Only the cited claim incumbent may respond (`403 not_incumbent` else); concurrent grants of the same `req_id` get `409 already_resolved`.",
    inputSchema: z
      .object({
        req_id: z.string().min(1),
        decision: z.enum(['accept', 'deny'])
      })
      .passthrough(),
    responseSchema: z.object({
      ok: z.literal(true),
      data: z.object({
        req_id: z.string(),
        status: z.enum(['granted', 'denied']),
        new_claim_id: z.string().optional(),
        kept_paths: z.array(z.string()).optional(),
        released_paths: z.array(z.string()).optional()
      })
    }),
    handler: async (input, client) =>
      callServer(client, '/tools/teamem.respond_permission_request', input)
  },

  'teamem.space_disband': {
    description:
      'Disband the current space (creator only). Soft-tombstones the space; data is retained for 7 days during which `teamem.space_restore` can undo. After grace expires, GC hard-deletes everything. All members are JWT-rejected with 410 immediately. Requires `label_confirmation` matching the space label exactly (defense against accidental disband).',
    inputSchema: z
      .object({
        label_confirmation: z.string().min(1)
      })
      .passthrough(),
    responseSchema: z.object({
      ok: z.literal(true),
      data: z.object({
        ok: z.literal(true)
      })
    }),
    handler: async (input, client) =>
      callServer(client, '/spaces/disband', input)
  },

  'teamem.space_restore': {
    description:
      'Restore a soft-disbanded space within its 7-day grace window (creator only). After grace expires, returns 410 grace_expired and the space is gone for good.',
    inputSchema: z.object({}).passthrough(),
    responseSchema: z.object({
      ok: z.literal(true),
      data: z.object({
        ok: z.literal(true)
      })
    }),
    handler: async (input, client) =>
      callServer(client, '/spaces/restore', input)
  },

  'teamem.space_wipe': {
    description:
      "Wipe the current space's projection state (creator only). Default soft mode tombstones every projection row and writes a `space_wiped` event — `teamem.space_unwipe` reverses it. Pass `hard: true` to delete events + projection rows irreversibly; hard mode requires `label_confirmation` matching the space label exactly. Wipe leaves space membership / room codes untouched (unlike disband, which 410s every JWT).",
    inputSchema: z
      .object({
        hard: z.boolean().optional(),
        label_confirmation: z.string().optional()
      })
      .passthrough(),
    responseSchema: z.object({
      ok: z.literal(true),
      data: z.object({
        ok: z.literal(true),
        wiped_at: z.string()
      })
    }),
    handler: async (input, client) => callServer(client, '/spaces/wipe', input)
  },

  'teamem.space_unwipe': {
    description:
      'Reverse the most recent soft-wipe (creator only). Clears tombstones whose timestamp matches the most recent `space_wiped` event and writes a `space_unwiped` event. Returns 409 not_wiped if there is nothing to reverse — including the case where the last operation was a hard-wipe (which left no events to anchor against).',
    inputSchema: z.object({}).passthrough(),
    responseSchema: z.object({
      ok: z.literal(true),
      data: z.object({
        ok: z.literal(true),
        unwiped_at: z.string()
      })
    }),
    handler: async (input, client) =>
      callServer(client, '/spaces/unwipe', input)
  },

  'teamem.space_leave': {
    description:
      'Leave the current space. Marks `members.left_at = now`; the next API call from this principal returns 401 `member_left`. Creators cannot leave — they must `/teamem:disband` instead (returns 409 `creator_must_disband`).',
    inputSchema: z.object({}).passthrough(),
    responseSchema: z.object({
      ok: z.literal(true),
      data: z.object({
        ok: z.literal(true)
      })
    }),
    handler: async (input, client) => callServer(client, '/spaces/leave', input)
  },

  'teamem.space_kick': {
    description:
      'Kick a member from the current space (creator only). Marks the target `members.left_at = now`; their next API call returns 401. Returns 403 `not_creator` if the caller is not the creator, 409 `cannot_self_kick` if the target is the caller, 404 `target_not_found` if the named member is absent or already left.',
    inputSchema: z
      .object({
        member_name: z.string().min(1)
      })
      .passthrough(),
    responseSchema: z.object({
      ok: z.literal(true),
      data: z.object({
        ok: z.literal(true)
      })
    }),
    handler: async (input, client) => callServer(client, '/spaces/kick', input)
  },

  'teamem.space_rotate_code': {
    description:
      "Rotate the current space's room code (any member). Issues a fresh 8-character code that expires in 30 days; the previous code is replaced atomically. Returns the new code in `data.room_code` — share via a SECURE channel only.",
    inputSchema: z.object({}).passthrough(),
    responseSchema: z.object({
      ok: z.literal(true),
      data: z.object({
        room_code: z.string(),
        rotated_at: z.string()
      })
    }),
    handler: async (input, client) =>
      callServer(client, '/spaces/rotate-code', input)
  },

  'teamem.queue_pending_edit': {
    description:
      "After your gate-claim hook resolves the conflict to `auto-skip`, queue a pending_edit so the server emits `conflict_resolved` to you when the incumbent releases. Pass the incumbent's `blocking_claim_id`, the paths you wanted to edit, and a short `intent`.",
    inputSchema: z
      .object({
        blocking_claim_id: z.string().min(1),
        paths: z.array(z.string()).min(1),
        intent: z.string().optional()
      })
      .passthrough(),
    responseSchema: z.object({
      ok: z.literal(true),
      data: z.object({
        pending_id: z.string(),
        event_id: z.string(),
        expires_at: z.string()
      })
    }),
    handler: async (input, client) =>
      callServer(client, '/tools/teamem.queue_pending_edit', input)
  },

  'teamem.clear_queue': {
    description:
      'Clear all your pending_edit rows in this space (the auto-skip waiting list). Cleared rows produce no peer event. Returns `cleared: <count>` of rows removed.',
    inputSchema: z.object({}).passthrough(),
    responseSchema: z.object({
      ok: z.literal(true),
      data: z.object({ cleared: z.number().int().nonnegative() })
    }),
    handler: async (input, client) =>
      callServer(client, '/tools/teamem.clear_queue', input)
  },

  'teamem.open_dispute': {
    description:
      "Legacy/roadmap dispute primitive. Open a Mode 6.C dispute thread only for direct tool compatibility or manual cleanup flows; the current plugin build does not auto-open disputes or run negotiator agents. Pass the incumbent's `blocking_claim_id`, the `paths` you wanted to claim, and a short `intent`. Server returns a `thread_id` usable with `dispute_post_move`.",
    inputSchema: z
      .object({
        blocking_claim_id: z.string().min(1),
        paths: z.array(z.string()).min(1),
        intent: z.string().optional(),
        target_principal: z.string().optional()
      })
      .passthrough(),
    responseSchema: z.object({
      ok: z.literal(true),
      data: z.object({ thread_id: z.string(), event_id: z.string() })
    }),
    handler: async (input, client) =>
      callServer(client, '/tools/teamem.open_dispute', input)
  },

  'teamem.dispute_post_move': {
    description:
      "Post a structured move into an open dispute thread. The 7 legal `move_type` values are: `propose_release_full`, `propose_release_subset` (payload: { paths }), `propose_release_after_task` (target only; payload: { wait_seconds, note? }; informational only), `propose_swap` (payload: { i_release, you_release }), `accept` (target_proposal_id required), `reject` (target_proposal_id, payload: { reason: 'busy'|'too_costly'|'wrong_paths' }), `concede_skip` (opener only). Server validates against the state machine and returns 409 invalid_move on illegal posts. On `accept` the agreed outcome is applied atomically.",
    inputSchema: z
      .object({
        thread_id: z.string().min(1),
        move_type: z.enum([
          'propose_release_full',
          'propose_release_subset',
          'propose_release_after_task',
          'propose_swap',
          'accept',
          'reject',
          'concede_skip'
        ]),
        payload: z.record(z.unknown()).optional(),
        target_proposal_id: z.string().optional()
      })
      .passthrough(),
    responseSchema: z.object({
      ok: z.literal(true),
      data: z.object({
        move_id: z.string(),
        event_id: z.string(),
        status: z.enum(['open', 'resolved', 'terminated']),
        outcome: z.string().optional()
      })
    }),
    handler: async (input, client) =>
      callServer(client, '/tools/teamem.dispute_post_move', input)
  },

  'teamem.end_dispute': {
    description:
      'User-override termination of an open dispute. `action: accept` applies the most-recent open proposal as if accepted; `deny` and `skip` close without applying. Either party (opener or target) may call this; non-parties are rejected with 403 not_dispute_party.',
    inputSchema: z
      .object({
        thread_id: z.string().min(1),
        action: z.enum(['accept', 'deny', 'skip'])
      })
      .passthrough(),
    responseSchema: z.object({
      ok: z.literal(true),
      data: z.object({
        status: z.enum(['terminated', 'resolved']),
        outcome: z.string()
      })
    }),
    handler: async (input, client) =>
      callServer(client, '/tools/teamem.end_dispute', input)
  },

  'teamem.update_dispute_terminations': {
    description:
      'Configure which of the 5 dispute termination conditions are enabled for this space (creator only). Pass `enabled` as a JSON array containing zero or more of: `user_override`, `explicit`, `turns`, `wallclock`, `pref_changed`. At least one MUST remain enabled — empty arrays are rejected with 400 invalid_enabled.',
    inputSchema: z
      .object({
        enabled: z.array(
          z.enum([
            'user_override',
            'explicit',
            'turns',
            'wallclock',
            'pref_changed'
          ])
        )
      })
      .passthrough(),
    responseSchema: z.object({
      ok: z.literal(true),
      data: z.object({
        enabled: z.array(z.string())
      })
    }),
    handler: async (input, client) =>
      callServer(client, '/tools/teamem.update_dispute_terminations', input)
  },

  'teamem.agent_focus_changed': {
    description:
      'Record an agent focus shift. Pass `scope.paths` for the area you are now working on and a short `intent`. The server collapses rapid same-scope claims within 60s into one focus row (audit log still records the event). Set `bypass_dedup: true` only when you must force a fresh row even within the dedup window — the gate-claim hook calls this automatically on successful claims; manual callers rarely need bypass.',
    inputSchema: z
      .object({
        scope: ScopeSchema,
        intent: z.string().optional(),
        bypass_dedup: z.boolean().optional()
      })
      .passthrough(),
    responseSchema: z.object({
      ok: z.literal(true),
      data: z.object({
        focus_id: z.string(),
        event_id: z.string(),
        scope_hash: z.string(),
        deduped: z.boolean()
      })
    }),
    handler: async (input, client) =>
      callServer(client, '/tools/teamem.agent_focus_changed', input)
  },

  'teamem.pause_claims_for_branch': {
    description:
      'Pause all active claims for the authenticated principal on a given repo+branch. Called by the post-checkout hook when the user switches away from a branch. Emits one claim_paused event per affected claim.',
    inputSchema: z
      .object({
        repo_id: z.string(),
        branch: z.string(),
        reason: z.string().optional()
      })
      .passthrough(),
    responseSchema: z.object({
      ok: z.literal(true),
      data: z.object({
        paused_count: z.number()
      })
    }),
    handler: async (input, client) =>
      callServer(client, '/tools/teamem.pause_claims_for_branch', input)
  },

  'teamem.resume_claims_for_branch': {
    description:
      'Resume all paused claims for the authenticated principal on a given repo+branch. Called by the post-checkout hook when the user switches back to a branch. Emits one claim_resumed event per affected claim.',
    inputSchema: z
      .object({
        repo_id: z.string(),
        branch: z.string()
      })
      .passthrough(),
    responseSchema: z.object({
      ok: z.literal(true),
      data: z.object({
        resumed_count: z.number()
      })
    }),
    handler: async (input, client) =>
      callServer(client, '/tools/teamem.resume_claims_for_branch', input)
  },

  'teamem.list_claims': {
    description:
      'List active and paused claims in the space. scope="self" returns only your claims; scope="space" returns every member\'s claims. Released claims are excluded.',
    inputSchema: z
      .object({
        scope: z.enum(['self', 'space']).default('self'),
        view: z
          .enum(['current', 'space', 'outside_current_context'])
          .default('current')
      })
      .passthrough(),
    responseSchema: z.object({
      ok: z.literal(true),
      data: z.object({
        claims: z.array(
          z.object({
            claim_id: z.string(),
            principal: z.string(),
            repo_id: z.string(),
            branch: z.string(),
            path: z.string(),
            mode: z.string(),
            status: z.string(),
            paused_at: z.string().nullable(),
            paused_reason: z.string().nullable(),
            created_at: z.string(),
            last_edit_at: z.string().nullable(),
            expires_at: z.string().nullable(),
            sprint_id: z.string().nullable(),
            context: z.enum(['space', 'sprint'])
          })
        )
      })
    }),
    handler: async (input, client) =>
      callServer(client, '/tools/teamem.list_claims', input)
  },

  'teamem.force_release': {
    description:
      "Force-release a peer's active or paused claim by claim_id, or by repo+branch+path+target_principal. Path targeting is scoped to your current context; exact claim_id can cross context and returns the claim context before release. The original holder receives a direct unread notification and may also see live channel delivery if online. Any space member can force-release any other member's claim — there is no privilege gate.",
    inputSchema: z
      .object({
        claim_id: z.string().min(1).optional(),
        repo_id: z.string().min(1).optional(),
        branch: z.string().min(1).optional(),
        path: z.string().min(1).optional(),
        target_principal: z.string().min(1).optional()
      })
      .passthrough()
      .superRefine((input, ctx) => {
        if (input.claim_id) return;
        for (const key of [
          'repo_id',
          'branch',
          'path',
          'target_principal'
        ] as const) {
          if (!input[key]) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [key],
              message: 'Required unless claim_id is provided for force_release'
            });
          }
        }
      }),
    responseSchema: z.object({
      ok: z.literal(true),
      data: z.object({
        released: z.boolean(),
        claim_id: z.string(),
        original_holder: z.string(),
        sprint_id: z.string().nullable(),
        context: z.enum(['space', 'sprint']),
        idempotent: z.boolean().optional()
      })
    }),
    handler: async (input, client) =>
      callServer(client, '/tools/teamem.force_release', input)
  },

  'teamem.fetch_unread_notifications': {
    description:
      'Return queued offline alerts for the authenticated principal, such as peer force-release while offline. Queued rows are marked delivered atomically. Space Memory catch-up for rules, decisions, and gotcha notices belongs to teamem.session_sync.',
    inputSchema: z.object({}).passthrough(),
    responseSchema: z.object({
      ok: z.literal(true),
      data: z.object({
        notifications: z.array(
          z.object({
            event_id: z.string(),
            event_type: z.string(),
            payload: z.record(z.unknown()),
            created_at: z.string()
          })
        )
      })
    }),
    handler: async (input, client) =>
      callServer(client, '/tools/teamem.fetch_unread_notifications', input)
  },

  'teamem.session_sync': {
    description:
      'Dedicated SessionStart correctness path for Space Memory. Returns the current Space Rules snapshot plus replay surfaces for decisions and gotcha notices. Do not infer rules state from briefing or Channels.',
    inputSchema: z.object({}).passthrough(),
    responseSchema: z.object({
      ok: z.literal(true),
      data: z.object({
        space_rules_snapshot: z.object({
          has_server_rules: z.boolean(),
          rendered_rules_body: z.string(),
          metadata: z.object({
            format_version: z.literal(1),
            source: z.enum(['server', 'none']),
            managed_begin: z.string(),
            managed_end: z.string(),
            rules_version: z.number().int().nonnegative(),
            rules_hash: z.string(),
            generated_at: z.string(),
            space_id: z.string(),
            space_label: z.string(),
            source_event_id: z.string().nullable(),
            snapshot_updated_at: z.string().nullable(),
            snapshot_updated_by: z.string().nullable()
          })
        }),
        decisions: z.array(
          z.object({
            event_id: z.string(),
            event_type: z.enum([
              'decision_published',
              'decision_amended',
              'decision_superseded'
            ]),
            principal: z.string(),
            created_at: z.string(),
            payload: z.object({
              decision_id: z.string(),
              title: z.string(),
              summary: z.string(),
              body: z.string(),
              kind: z.string(),
              version: z.number().int().positive(),
              superseded_by_decision_id: z.string().nullable().optional(),
              predecessor_decision_id: z.string().nullable().optional()
            })
          })
        ),
        decision_replays: z.array(
          z.object({
            event_id: z.string(),
            event_type: z.enum([
              'decision_published',
              'decision_amended',
              'decision_superseded'
            ]),
            principal: z.string(),
            created_at: z.string(),
            payload: z.object({
              decision_id: z.string(),
              title: z.string(),
              summary: z.string(),
              body: z.string(),
              kind: z.string(),
              version: z.number().int().positive(),
              superseded_by_decision_id: z.string().nullable().optional(),
              predecessor_decision_id: z.string().nullable().optional()
            })
          })
        ),
        gotcha_notices: z.array(
          z.object({
            event_id: z.string(),
            event_type: z.literal('gotcha_notice'),
            created_at: z.string(),
            payload: z.object({
              finding_id: z.string(),
              version: z.number().int().positive(),
              summary: z.string(),
              severity: z.enum(['info', 'warning', 'urgent']),
              paths: z.array(z.string()),
              tags: z.array(z.string()),
              recipient_mode: z.enum(['broadcast', 'direct']),
              recipient_principals: z.array(z.string()),
              relevance: z.enum([
                'direct_target',
                'urgent',
                'path_overlap',
                'tag_overlap'
              ])
            })
          })
        )
      })
    }),
    handler: async (input, client) =>
      callServer(client, '/tools/teamem.session_sync', input)
  }
};
