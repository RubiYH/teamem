import { describe, expect, it } from 'bun:test';
import {
  classifyTeamemChannelRoute,
  createClaudeChannelNotification,
  createTeamemChannelEnvelope,
  isNoiseTeamemChannelEvent
} from '../../../src/channel/payload.js';

describe('channel payload', () => {
  it('routes plain discussion messages to the peer channel', () => {
    const event = {
      event_id: 'evt-1',
      event_type: 'discussion_posted',
      principal: 'bob',
      payload: {
        message_id: 'msg-1',
        thread_id: 'thr-1',
        recipient_principal: 'alice',
        body: 'Can you release src/server/routes.ts?'
      }
    };

    expect(classifyTeamemChannelRoute(event)).toBe('peer');
    const envelope = createTeamemChannelEnvelope(event);

    expect(envelope.name).toBe('teamem.peer_event');
    expect(envelope.summary).toContain('bob -> alice');
  });

  it('routes dispute openings and dispute moves to the dispute channel', () => {
    expect(
      classifyTeamemChannelRoute({
        event_id: 'evt-1',
        event_type: 'dispute_opened',
        principal: 'bob'
      })
    ).toBe('dispute');

    expect(
      classifyTeamemChannelRoute({
        event_id: 'evt-2',
        event_type: 'discussion_posted',
        principal: 'bob',
        payload: {
          dispute_move: { move_type: 'propose_release_full' }
        }
      })
    ).toBe('dispute');
  });

  it('emits Claude channel notifications with string-only routing metadata', () => {
    const notification = createClaudeChannelNotification({
      event_id: 'evt-1',
      event_type: 'discussion_posted',
      principal: 'bob',
      scope: { paths: ['src/server/routes.ts'] },
      payload: {
        message_id: 'msg-1',
        thread_id: 'thr-1',
        recipient_principal: 'alice',
        body: 'Can you release src/server/routes.ts?'
      }
    });

    expect(notification.method).toBe('notifications/claude/channel');
    expect(notification.params.meta).toEqual({
      route: 'peer',
      event_type: 'discussion_posted',
      event_id: 'evt-1',
      principal: 'bob',
      notification_name: 'teamem.peer_event',
      message_id: 'msg-1',
      thread_id: 'thr-1',
      recipient_principal: 'alice'
    });

    const envelope = JSON.parse(notification.params.content) as {
      event_id: string;
      payload: { body: string };
    };
    expect(envelope.event_id).toBe('evt-1');
    expect(envelope.payload.body).toContain('release');
  });

  it('labels Sprint-wide discussion notifications with Sprint scope', () => {
    const notification = createClaudeChannelNotification({
      event_id: 'evt-sprint-1',
      event_type: 'discussion_posted',
      principal: 'bob',
      sprint_id: 'sprint-plugin-release',
      delivery_scope: 'sprint',
      payload: {
        message_id: 'msg-sprint-1',
        thread_id: 'thr-sprint-1',
        body: 'Sprint only update.'
      }
    });

    expect(notification.params.meta).toEqual({
      route: 'peer',
      event_type: 'discussion_posted',
      event_id: 'evt-sprint-1',
      principal: 'bob',
      notification_name: 'teamem.peer_event',
      message_id: 'msg-sprint-1',
      thread_id: 'thr-sprint-1',
      recipient_principal: 'sprint:sprint-plugin-release',
      delivery_scope: 'sprint',
      sprint_id: 'sprint-plugin-release'
    });

    const envelope = JSON.parse(notification.params.content) as {
      summary: string;
    };
    expect(envelope.summary).toContain('bob -> sprint:sprint-plugin-release');
    expect(envelope.summary).not.toContain('bob -> space');
  });

  it('preserves direct and Space-wide discussion labels', () => {
    const direct = createTeamemChannelEnvelope({
      event_id: 'evt-direct-1',
      event_type: 'discussion_posted',
      principal: 'bob',
      sprint_id: 'sprint-plugin-release',
      delivery_scope: 'direct',
      recipient_principals: ['alice'],
      payload: {
        recipient_principal: 'alice',
        body: 'Direct still interrupts.'
      }
    });
    const space = createTeamemChannelEnvelope({
      event_id: 'evt-space-1',
      event_type: 'discussion_posted',
      principal: 'bob',
      sprint_id: null,
      delivery_scope: 'space',
      payload: {
        recipient_principal: null,
        body: 'Escalating to Space.'
      }
    });

    expect(direct.summary).toContain('bob -> alice');
    expect(space.summary).toContain('bob -> space');
  });

  it('builds urgent permission request notifications with exact contract metadata and full payload content', () => {
    const event = {
      event_id: 'evt-perm-1',
      event_type: 'permission_requested',
      principal: 'bob',
      scope: { paths: ['src/foo.ts', 'src/bar.ts'] },
      payload: {
        req_id: 'req-123',
        incumbent_principal: 'alice',
        blocking_claim_id: 'claim-9',
        intent: 'land the auth fix'
      }
    };

    expect(classifyTeamemChannelRoute(event)).toBe('peer');

    const notification = createClaudeChannelNotification(event);

    expect(notification.params.meta).toEqual({
      req_id: 'req-123',
      blocking_claim_id: 'claim-9',
      incumbent_principal: 'alice',
      event_id: 'evt-perm-1',
      event_type: 'permission_requested',
      principal: 'bob'
    });

    const envelope = JSON.parse(notification.params.content) as {
      scope: { paths: string[] };
      payload: {
        req_id: string;
        incumbent_principal: string;
        blocking_claim_id: string;
        intent: string;
      };
      summary: string;
      instructions?: string;
    };

    expect(envelope.scope.paths).toEqual(['src/foo.ts', 'src/bar.ts']);
    expect(envelope.payload).toEqual({
      req_id: 'req-123',
      incumbent_principal: 'alice',
      blocking_claim_id: 'claim-9',
      intent: 'land the auth fix'
    });
    expect(envelope.summary).toContain('bob requests permission from alice');
    expect(envelope.summary).toContain('src/foo.ts');
    expect(envelope.summary).toContain('req req-123');
    expect(envelope.summary).toContain('/teamem:grant req-123');
    expect(envelope.summary).toContain('/teamem:deny req-123');
    expect(envelope.instructions).toContain('/teamem:grant req-123');
    expect(envelope.instructions).toContain('/teamem:deny req-123');
  });

  it('keeps full decision text in channel payloads for online broadcast delivery', () => {
    const notification = createClaudeChannelNotification({
      event_id: 'evt-decision-1',
      event_type: 'decision_published',
      principal: 'bob',
      payload: {
        decision_id: 'dec-1',
        title: 'Ship with full text',
        summary: 'Decision summaries are not enough.',
        body: 'This full decision body should survive into the channel payload.',
        kind: 'process',
        version: 1
      }
    });

    expect(notification.params.meta).toEqual({
      route: 'peer',
      event_type: 'decision_published',
      event_id: 'evt-decision-1',
      principal: 'bob',
      notification_name: 'teamem.peer_event'
    });

    const envelope = JSON.parse(notification.params.content) as {
      event_type: string;
      payload: { title: string; body: string };
      summary: string;
    };
    expect(envelope.event_type).toBe('decision_published');
    expect(envelope.payload.title).toBe('Ship with full text');
    expect(envelope.payload.body).toBe(
      'This full decision body should survive into the channel payload.'
    );
    expect(envelope.summary).toContain('published decision');
  });

  it('keeps gotcha channel payloads short and excludes full body text', () => {
    const notification = createClaudeChannelNotification({
      event_id: 'evt-gotcha-1',
      event_type: 'finding_shared',
      principal: 'bob',
      payload: {
        finding_id: 'finding-1',
        kind: 'gotcha',
        version: 2,
        summary: 'Do not infer rules from briefing.',
        body: 'Long private gotcha body that should require get_finding.',
        severity: 'warning',
        paths: ['src/server/tools/briefing.ts'],
        tags: ['rules'],
        recipient_principals: ['alice']
      }
    });

    const envelope = JSON.parse(notification.params.content) as {
      payload: Record<string, unknown>;
      summary: string;
    };
    expect(envelope.summary).toContain('shared gotcha');
    expect(envelope.payload.finding_id).toBe('finding-1');
    expect(envelope.payload.summary).toBe('Do not infer rules from briefing.');
    expect(envelope.payload.body).toBeUndefined();
    expect(envelope.payload.action).toBe(
      'fetch_detail_with_teamem.get_finding'
    );
  });

  it('filters routine session-start beacons as noise', () => {
    expect(
      isNoiseTeamemChannelEvent({
        event_id: 'evt-1',
        event_type: 'task_started',
        principal: 'alice',
        payload: { task_id: 'session-abc' }
      })
    ).toBe(true);
  });
});
