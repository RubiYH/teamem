import { describe, expect, it } from 'bun:test';
import { TOOL_BINDINGS } from '../../../src/bridge/tool-bindings.js';

describe('sprint bridge tool bindings', () => {
  it('documents input and output schemas for Sprint lifecycle tools', () => {
    expect(
      TOOL_BINDINGS['teamem.create_sprint'].inputSchema.safeParse({
        display_name: 'MVP',
        goal: 'Build it'
      }).success
    ).toBe(true);
    expect(
      TOOL_BINDINGS['teamem.join_sprint'].inputSchema.safeParse({
        sprint: 'mvp'
      }).success
    ).toBe(true);
    expect(
      TOOL_BINDINGS['teamem.leave_sprint'].inputSchema.safeParse({}).success
    ).toBe(true);
    expect(
      TOOL_BINDINGS['teamem.get_current_sprint'].inputSchema.safeParse({})
        .success
    ).toBe(true);
    expect(
      TOOL_BINDINGS['teamem.list_sprints'].inputSchema.safeParse({}).success
    ).toBe(true);
    expect(
      TOOL_BINDINGS['teamem.archive_sprint'].inputSchema.safeParse({
        sprint: 'mvp'
      }).success
    ).toBe(true);
    expect(
      TOOL_BINDINGS['teamem.reopen_sprint'].inputSchema.safeParse({
        sprint: 'mvp'
      }).success
    ).toBe(true);
    expect(
      TOOL_BINDINGS['teamem.get_sprint_history'].inputSchema.safeParse({
        sprint: 'mvp',
        limit: 10
      }).success
    ).toBe(true);

    const response = {
      ok: true,
      data: {
        sprint: {
          sprint_id: 'sprint-1',
          slug: 'mvp',
          display_name: 'MVP',
          goal: 'Build it',
          status: 'active'
        },
        old_context: { mode: 'space', sprint: null },
        new_context: {
          mode: 'sprint',
          sprint: {
            sprint_id: 'sprint-1',
            slug: 'mvp',
            display_name: 'MVP',
            goal: 'Build it',
            status: 'active'
          }
        },
        event_ids: ['evt-1'],
        idempotent: false,
        message: 'Joined mvp.',
        warnings: []
      }
    };
    expect(
      TOOL_BINDINGS['teamem.create_sprint'].responseSchema?.safeParse(response)
        .success
    ).toBe(true);

    expect(
      TOOL_BINDINGS['teamem.list_sprints'].responseSchema?.safeParse({
        ok: true,
        data: {
          sprints: [
            {
              sprint_id: 'sprint-1',
              slug: 'mvp',
              display_name: 'MVP',
              goal: 'Build it',
              status: 'archived',
              current_members: [],
              last_activity_at: '2026-05-27T00:00:00.000Z'
            }
          ]
        }
      }).success
    ).toBe(true);
    expect(
      TOOL_BINDINGS['teamem.get_current_sprint'].responseSchema?.safeParse({
        ok: true,
        data: {
          context: response.data.new_context,
          sprint: response.data.sprint,
          current_members: ['alice', 'bob']
        }
      }).success
    ).toBe(true);
    expect(
      TOOL_BINDINGS['teamem.archive_sprint'].responseSchema?.safeParse({
        ok: true,
        data: {
          sprint: response.data.sprint,
          event_ids: ['evt-archive'],
          idempotent: false,
          released_claims: [
            {
              claim_id: 'claim-1',
              original_holder: 'alice',
              event_id: 'evt-release'
            }
          ],
          message: 'Archived mvp.'
        }
      }).success
    ).toBe(true);
    expect(
      TOOL_BINDINGS['teamem.get_sprint_history'].responseSchema?.safeParse({
        ok: true,
        data: {
          sprint: response.data.sprint,
          events: [
            {
              event_id: 'evt-archive',
              event_type: 'sprint_archived',
              timestamp: '2026-05-27T00:00:00.000Z',
              principal: 'alice',
              sprint_id: 'sprint-1',
              summary: 'archived mvp',
              payload: { sprint_id: 'sprint-1' }
            }
          ],
          limit: 25,
          truncated: false
        }
      }).success
    ).toBe(true);
  });

  it('documents Sprint-aware blocker tool schemas', () => {
    expect(
      TOOL_BINDINGS['teamem.raise_blocker'].inputSchema.safeParse({
        summary: 'Need review',
        scope: 'space'
      }).success
    ).toBe(true);
    expect(
      TOOL_BINDINGS['teamem.resolve_blocker'].inputSchema.safeParse({
        blocker_id: 'blocker-1',
        resolution: 'Review completed',
        scope: 'space'
      }).success
    ).toBe(true);

    const response = {
      ok: true,
      data: {
        blocker_id: 'blocker-1',
        event_id: 'evt-blocker-1',
        sprint_id: null,
        context: 'space',
        status: 'open'
      }
    };
    expect(
      TOOL_BINDINGS['teamem.raise_blocker'].responseSchema?.safeParse(response)
        .success
    ).toBe(true);
  });

  it('documents Sprint-aware get_briefing response fields', () => {
    const parsed = TOOL_BINDINGS[
      'teamem.get_briefing'
    ].responseSchema?.safeParse({
      ok: true,
      data: {
        current_context: {
          mode: 'sprint',
          sprint: {
            sprint_id: 'sprint-1',
            slug: 'plugin-release',
            display_name: 'Plugin Release',
            goal: 'Ship safely',
            status: 'active',
            current_members: ['alice', 'bob']
          },
          routing_reasons: [
            'current Sprint plugin-release',
            'direct-to-me messages'
          ]
        },
        current_plan: null,
        active_claims: [],
        recent_decisions: [],
        active_risks: { open_blockers: [], standing_conflicts: [] },
        recent_progress: [],
        recent_notifications: [
          {
            event_id: 'evt-direct',
            event_type: 'discussion_posted',
            principal: 'bob',
            summary: 'direct note',
            created_at: '2026-05-27T00:00:00.000Z',
            sprint_id: 'sprint-2',
            delivery_scope: 'direct',
            routing_reason: 'direct_to_me'
          }
        ],
        outside_current_context: {
          active_claims: [
            {
              principal: 'alice',
              scope: { paths: ['src/old.ts'] },
              intent: 'cleanup leftover',
              claimed_at: '2026-05-27T00:00:00.000Z'
            }
          ]
        },
        recent_joins: [],
        recent_findings: [],
        recent_artifacts: [],
        meta: {
          token_estimate: 1,
          cursor: null,
          lag_seconds: null,
          heuristic_trust: 'unverified',
          cross_context_overlap_awareness: { overlapping_claims: 1 }
        }
      }
    });
    expect(parsed?.success).toBe(true);
  });
});
