import { describe, expect, it } from 'bun:test';
import { shouldEmitTeamemChannelEvent } from '../../../src/channel/runtime.js';

describe('channel runtime filtering', () => {
  it('emits directed discussion messages only to the recipient', () => {
    const bobToAlice = {
      event_id: 'evt-1',
      event_type: 'discussion_posted',
      principal: 'bob',
      payload: {
        message_id: 'msg-1',
        thread_id: 'thr-1',
        recipient_principal: 'alice',
        body: 'Can you see this over the Teamem channel?'
      }
    };

    expect(
      shouldEmitTeamemChannelEvent(bobToAlice, { myPrincipal: 'alice' })
    ).toBe(true);
    expect(
      shouldEmitTeamemChannelEvent(bobToAlice, { myPrincipal: 'carol' })
    ).toBe(false);
  });

  it('can restrict delivery to an explicit trusted sender allowlist', () => {
    const bobToAlice = {
      event_id: 'evt-1',
      event_type: 'discussion_posted',
      principal: 'bob',
      payload: {
        message_id: 'msg-1',
        thread_id: 'thr-1',
        recipient_principal: 'alice',
        body: 'Allowed sender.'
      }
    };

    expect(
      shouldEmitTeamemChannelEvent(bobToAlice, {
        myPrincipal: 'alice',
        allowedSenders: new Set(['bob'])
      })
    ).toBe(true);
    expect(
      shouldEmitTeamemChannelEvent(bobToAlice, {
        myPrincipal: 'alice',
        allowedSenders: new Set(['carol'])
      })
    ).toBe(false);
  });

  it('emits permission requests only to the incumbent', () => {
    const request = {
      event_id: 'evt-req-1',
      event_type: 'permission_requested',
      principal: 'bob',
      scope: { paths: ['src/foo.ts'] },
      payload: {
        req_id: 'req-123',
        incumbent_principal: 'alice',
        blocking_claim_id: 'claim-1'
      }
    };

    expect(
      shouldEmitTeamemChannelEvent(request, { myPrincipal: 'alice' })
    ).toBe(true);
    expect(shouldEmitTeamemChannelEvent(request, { myPrincipal: 'bob' })).toBe(
      false
    );
    expect(
      shouldEmitTeamemChannelEvent(request, { myPrincipal: 'carol' })
    ).toBe(false);
    expect(
      shouldEmitTeamemChannelEvent(request, {
        myPrincipal: 'alice',
        allowedSenders: new Set(['bob'])
      })
    ).toBe(true);
    expect(
      shouldEmitTeamemChannelEvent(request, {
        myPrincipal: 'alice',
        allowedSenders: new Set(['carol'])
      })
    ).toBe(false);
  });

  it('emits broadcast discussion messages to non-senders only', () => {
    const broadcast = {
      event_id: 'evt-1',
      event_type: 'discussion_posted',
      principal: 'bob',
      payload: {
        message_id: 'msg-1',
        thread_id: 'thr-1',
        recipient_principal: null,
        body: 'Heads up: auth tests are flaky right now.'
      }
    };

    expect(
      shouldEmitTeamemChannelEvent(broadcast, { myPrincipal: 'alice' })
    ).toBe(true);
    expect(
      shouldEmitTeamemChannelEvent(broadcast, { myPrincipal: 'bob' })
    ).toBe(false);
  });

  it('emits decision lifecycle broadcasts to every non-sender teammate', () => {
    const published = {
      event_id: 'evt-decision-1',
      event_type: 'decision_published',
      principal: 'bob',
      payload: {
        decision_id: 'dec-1',
        title: 'Adopt the bridge',
        summary: 'Use the stdio bridge.',
        body: 'Full decision text should reach online teammates.',
        kind: 'architectural',
        version: 1
      }
    };

    expect(
      shouldEmitTeamemChannelEvent(published, { myPrincipal: 'alice' })
    ).toBe(true);
    expect(
      shouldEmitTeamemChannelEvent(published, { myPrincipal: 'bob' })
    ).toBe(false);
    expect(
      shouldEmitTeamemChannelEvent(published, {
        myPrincipal: 'alice',
        allowedSenders: new Set(['bob'])
      })
    ).toBe(true);
  });

  it('emits short gotcha broadcasts and direct gotchas only to recipients', () => {
    const broadcastGotcha = {
      event_id: 'evt-gotcha-1',
      event_type: 'finding_shared',
      principal: 'bob',
      payload: {
        finding_id: 'finding-1',
        kind: 'gotcha',
        summary: 'Do not edit TEAMEM.md outside the managed block.',
        recipient_principals: []
      }
    };
    const directGotcha = {
      ...broadcastGotcha,
      event_id: 'evt-gotcha-2',
      payload: {
        ...broadcastGotcha.payload,
        recipient_principals: ['alice']
      }
    };

    expect(
      shouldEmitTeamemChannelEvent(broadcastGotcha, { myPrincipal: 'alice' })
    ).toBe(true);
    expect(
      shouldEmitTeamemChannelEvent(broadcastGotcha, { myPrincipal: 'bob' })
    ).toBe(false);
    expect(
      shouldEmitTeamemChannelEvent(directGotcha, { myPrincipal: 'alice' })
    ).toBe(true);
    expect(
      shouldEmitTeamemChannelEvent(directGotcha, { myPrincipal: 'carol' })
    ).toBe(false);
  });

  it('suppresses self, dispute, noise, and non-discussion events', () => {
    expect(
      shouldEmitTeamemChannelEvent(
        {
          event_id: 'evt-1',
          event_type: 'discussion_posted',
          principal: 'alice',
          payload: {
            recipient_principal: 'bob',
            body: 'self-authored'
          }
        },
        { myPrincipal: 'alice' }
      )
    ).toBe(false);

    expect(
      shouldEmitTeamemChannelEvent(
        {
          event_id: 'evt-2',
          event_type: 'discussion_posted',
          principal: 'bob',
          payload: {
            recipient_principal: 'alice',
            body: 'move',
            dispute_move: { move_type: 'propose_release_full' }
          }
        },
        { myPrincipal: 'alice' }
      )
    ).toBe(false);

    expect(
      shouldEmitTeamemChannelEvent(
        {
          event_id: 'evt-3',
          event_type: 'task_started',
          principal: 'bob',
          payload: { task_id: 'session-123' }
        },
        { myPrincipal: 'alice' }
      )
    ).toBe(false);

    expect(
      shouldEmitTeamemChannelEvent(
        {
          event_id: 'evt-4',
          event_type: 'scope_claimed',
          principal: 'bob',
          scope: { paths: ['src/server/routes.ts'] }
        },
        { myPrincipal: 'alice' }
      )
    ).toBe(false);
  });
});
