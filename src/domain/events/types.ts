export const EVENT_TYPES = [
  'scope_claimed',
  'scope_released',
  'task_started',
  'task_progressed',
  'task_completed',
  'decision_published',
  'decision_amended',
  'decision_superseded',
  'decision_recorded',
  'contract_changed',
  'blocker_raised',
  'blocker_resolved',
  'conflict_detected',
  'conflict_queued',
  'conflict_resolved',
  'acknowledgment_recorded',
  'discussion_posted',
  'space_wiped',
  'space_unwiped',
  'finding_shared',
  'artifact_shared',
  'permission_requested',
  'permission_granted',
  'permission_denied',
  'permission_expired',
  'agent_focus_changed',
  'dispute_opened',
  // Codex F21 — `dispute_move_posted` was reserved for an alternate move
  // emission path that was never wired. The server emits each move as
  // `discussion_posted` with `payload.dispute_move` (see
  // `src/server/tools/index.ts` `disputePostMove`). Removed to keep the
  // enum honest; no production code path emitted it.
  'dispute_resolved',
  'dispute_terminated',
  'scope_released_via_git',
  'claim_force_released',
  'claim_paused',
  'claim_resumed',
  'claim_expired',
  'space_rule_added',
  'space_rule_amended',
  'space_rule_disabled'
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export type EventScope = {
  paths?: string[];
  modules?: string[];
  contracts?: string[];
};

export type EventRefs = {
  branch?: string;
  commit?: string;
  pr?: string;
};

export type BaseEventPayload = Record<string, unknown>;

export type TeamemEvent = {
  schema_version: '1.0';
  event_id: string;
  idempotency_key: string;
  space_id: string;
  timestamp: string;
  principal: string;
  actor: string;
  delegation: string;
  event_type: EventType;
  scope: EventScope;
  payload: BaseEventPayload;
  refs?: EventRefs;
  confidence?: number;
};
