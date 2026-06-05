import { describe, expect, it } from 'bun:test';
import {
  EMPTY_CHANNEL_CURSOR,
  pollChannelOnce
} from '../../../src/channel/index.js';
import type { BridgeHttpClient } from '../../../src/bridge/http-client.js';
import { TOOL_BINDINGS } from '../../../src/bridge/tool-bindings.js';
import type {
  ClaudeChannelNotification,
  TeamemChannelEvent
} from '../../../src/channel/payload.js';

describe('channel runtime integration', () => {
  it('polls updates and emits only recipient-visible discussion notifications for the local principal', async () => {
    const emitted: ClaudeChannelNotification[] = [];
    const persistedCursors: string[] = [];

    const realGetUpdates = TOOL_BINDINGS['teamem.get_updates'];
    expect(realGetUpdates).toBeDefined();

    const events: TeamemChannelEvent[] = [
      {
        event_id: 'evt-bob-alice',
        event_type: 'discussion_posted',
        principal: 'bob',
        payload: {
          message_id: 'msg-bob-alice',
          thread_id: 'thr-bob-alice',
          recipient_principal: 'alice',
          body: 'Can you see this over the Teamem channel?'
        }
      },
      {
        event_id: 'evt-alice-bob',
        event_type: 'discussion_posted',
        principal: 'alice',
        payload: {
          message_id: 'msg-alice-bob',
          thread_id: 'thr-alice-bob',
          recipient_principal: 'bob',
          body: 'This is my own message.'
        }
      },
      {
        event_id: 'evt-bob-carol',
        event_type: 'discussion_posted',
        principal: 'bob',
        payload: {
          message_id: 'msg-bob-carol',
          thread_id: 'thr-bob-carol',
          recipient_principal: 'carol',
          body: 'Alice should not see this.'
        }
      },
      {
        event_id: 'evt-bob-space',
        event_type: 'discussion_posted',
        principal: 'bob',
        payload: {
          message_id: 'msg-bob-space',
          thread_id: 'thr-bob-space',
          recipient_principal: null,
          body: 'Broadcast to the space.'
        }
      }
    ];

    const client: BridgeHttpClient = {
      async post<T = unknown>(path: string, body: unknown) {
        expect(path).toBe('/tools/teamem.get_updates');
        expect(body).toEqual({ since: 'evt-before', limit: 50 });
        return {
          ok: true,
          data: {
            ok: true,
            data: { events }
          } as T
        };
      }
    };

    const nextCursor = await pollChannelOnce({
      server: {
        async notification(notification) {
          emitted.push(notification);
        }
      },
      entry: {
        space_id: 'space-1',
        label: 'local-dev',
        member_name: 'alice',
        jwt: 'test-jwt',
        jwt_exp: Date.now() + 60_000,
        server_url: 'http://127.0.0.1:3000'
      },
      cursor: 'evt-before',
      isActive: () => true,
      rateOk: () => true,
      client,
      getUpdates: async (args, client) =>
        (await realGetUpdates.handler(args, client)) as {
          ok?: boolean;
          data?: { events?: TeamemChannelEvent[] };
        },
      onPersistCursor: (cursor) => {
        persistedCursors.push(cursor);
      }
    });

    expect(emitted).toHaveLength(2);
    expect(
      emitted.every((n) => n.method === 'notifications/claude/channel')
    ).toBe(true);

    const envelopes = emitted.map((n) => JSON.parse(n.params.content));
    expect(envelopes.map((e) => e.event_id)).toEqual([
      'evt-bob-alice',
      'evt-bob-space'
    ]);
    expect(envelopes.every((e) => e.event_type === 'discussion_posted')).toBe(
      true
    );
    expect(envelopes[0]!.payload.recipient_principal).toBe('alice');
    expect(envelopes[1]!.payload.recipient_principal).toBeNull();
    expect(nextCursor).toBe('evt-bob-space');
    expect(persistedCursors).toEqual(['evt-bob-space']);
  });

  it('emits directed discussions plus incumbent-targeted permission requests, bypassing ordinary chatter rate limiting', async () => {
    const emitted: ClaudeChannelNotification[] = [];
    const persistedCursors: string[] = [];
    let rateCalls = 0;

    const realGetUpdates = TOOL_BINDINGS['teamem.get_updates'];
    expect(realGetUpdates).toBeDefined();

    const events: TeamemChannelEvent[] = [
      {
        event_id: 'evt-discuss-alice',
        event_type: 'discussion_posted',
        principal: 'bob',
        payload: {
          message_id: 'msg-discuss-alice',
          thread_id: 'thr-discuss-alice',
          recipient_principal: 'alice',
          body: 'Discussion for Alice.'
        }
      },
      {
        event_id: 'evt-perm-alice',
        event_type: 'permission_requested',
        principal: 'bob',
        scope: { paths: ['src/foo.ts', 'src/bar.ts'] },
        payload: {
          req_id: 'req-123',
          incumbent_principal: 'alice',
          blocking_claim_id: 'claim-9',
          intent: 'land the auth fix'
        }
      },
      {
        event_id: 'evt-perm-carol',
        event_type: 'permission_requested',
        principal: 'bob',
        scope: { paths: ['src/baz.ts'] },
        payload: {
          req_id: 'req-999',
          incumbent_principal: 'carol',
          blocking_claim_id: 'claim-10',
          intent: 'not for alice'
        }
      },
      {
        event_id: 'evt-ordinary',
        event_type: 'scope_claimed',
        principal: 'bob',
        scope: { paths: ['src/skip.ts'] }
      }
    ];

    const client: BridgeHttpClient = {
      async post<T = unknown>(path: string, body: unknown) {
        expect(path).toBe('/tools/teamem.get_updates');
        expect(body).toEqual({ since: 'evt-before', limit: 50 });
        return {
          ok: true,
          data: {
            ok: true,
            data: { events }
          } as T
        };
      }
    };

    const nextCursor = await pollChannelOnce({
      server: {
        async notification(notification) {
          emitted.push(notification);
        }
      },
      entry: {
        space_id: 'space-1',
        label: 'local-dev',
        member_name: 'alice',
        jwt: 'test-jwt',
        jwt_exp: Date.now() + 60_000,
        server_url: 'http://127.0.0.1:3000'
      },
      cursor: 'evt-before',
      isActive: () => true,
      rateOk: () => {
        rateCalls += 1;
        return false;
      },
      client,
      getUpdates: async (args, client) =>
        (await realGetUpdates.handler(args, client)) as {
          ok?: boolean;
          data?: { events?: TeamemChannelEvent[] };
        },
      onPersistCursor: (cursor) => {
        persistedCursors.push(cursor);
      }
    });

    expect(rateCalls).toBe(1);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.params.meta).toEqual({
      req_id: 'req-123',
      blocking_claim_id: 'claim-9',
      incumbent_principal: 'alice',
      event_id: 'evt-perm-alice',
      event_type: 'permission_requested',
      principal: 'bob'
    });

    const envelope = JSON.parse(emitted[0]!.params.content) as {
      event_id: string;
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
    expect(envelope.event_id).toBe('evt-perm-alice');
    expect(envelope.scope.paths).toEqual(['src/foo.ts', 'src/bar.ts']);
    expect(envelope.payload).toEqual({
      req_id: 'req-123',
      incumbent_principal: 'alice',
      blocking_claim_id: 'claim-9',
      intent: 'land the auth fix'
    });
    expect(envelope.summary).toContain('/teamem-grant req-123');
    expect(envelope.summary).toContain('/teamem-deny req-123');
    expect(envelope.instructions).toContain('/teamem-grant req-123');
    expect(nextCursor).toBe('evt-ordinary');
    expect(persistedCursors).toEqual(['evt-ordinary']);
  });

  it('persists get_updates.next_cursor when the filtered event page is empty', async () => {
    const emitted: ClaudeChannelNotification[] = [];
    const persistedCursors: string[] = [];

    const realGetUpdates = TOOL_BINDINGS['teamem.get_updates'];
    expect(realGetUpdates).toBeDefined();

    const client: BridgeHttpClient = {
      async post<T = unknown>(path: string, body: unknown) {
        expect(path).toBe('/tools/teamem.get_updates');
        expect(body).toEqual({ since: 'evt-before', limit: 50 });
        return {
          ok: true,
          data: {
            ok: true,
            data: { events: [], next_cursor: 'evt-hidden-page-end' }
          } as T
        };
      }
    };

    const nextCursor = await pollChannelOnce({
      server: {
        async notification(notification) {
          emitted.push(notification);
        }
      },
      entry: {
        space_id: 'space-1',
        label: 'local-dev',
        member_name: 'alice',
        jwt: 'test-jwt',
        jwt_exp: Date.now() + 60_000,
        server_url: 'http://127.0.0.1:3000'
      },
      cursor: 'evt-before',
      isActive: () => true,
      rateOk: () => true,
      client,
      getUpdates: async (args, client) =>
        (await realGetUpdates.handler(args, client)) as {
          ok?: boolean;
          data?: { events?: TeamemChannelEvent[]; next_cursor?: string | null };
        },
      onPersistCursor: (cursor) => {
        persistedCursors.push(cursor);
      }
    });

    expect(emitted).toHaveLength(0);
    expect(nextCursor).toBe('evt-hidden-page-end');
    expect(persistedCursors).toEqual(['evt-hidden-page-end']);
  });

  it('emits the local discussion target and incumbent permission request from a mixed event stream', async () => {
    const emitted: ClaudeChannelNotification[] = [];
    const persistedCursors: string[] = [];

    const realGetUpdates = TOOL_BINDINGS['teamem.get_updates'];
    expect(realGetUpdates).toBeDefined();

    const events: TeamemChannelEvent[] = [
      {
        event_id: 'evt-discuss-alice',
        event_type: 'discussion_posted',
        principal: 'bob',
        payload: {
          message_id: 'msg-discuss-alice',
          thread_id: 'thr-discuss-alice',
          recipient_principal: 'alice',
          body: 'Discussion for Alice.'
        }
      },
      {
        event_id: 'evt-perm-alice',
        event_type: 'permission_requested',
        principal: 'bob',
        scope: { paths: ['src/foo.ts', 'src/bar.ts'] },
        payload: {
          req_id: 'req-123',
          incumbent_principal: 'alice',
          blocking_claim_id: 'claim-9',
          intent: 'land the auth fix'
        }
      },
      {
        event_id: 'evt-perm-carol',
        event_type: 'permission_requested',
        principal: 'bob',
        scope: { paths: ['src/baz.ts'] },
        payload: {
          req_id: 'req-999',
          incumbent_principal: 'carol',
          blocking_claim_id: 'claim-10',
          intent: 'not for alice'
        }
      },
      {
        event_id: 'evt-ordinary',
        event_type: 'scope_claimed',
        principal: 'bob',
        scope: { paths: ['src/skip.ts'] }
      }
    ];

    const client: BridgeHttpClient = {
      async post<T = unknown>(path: string, body: unknown) {
        expect(path).toBe('/tools/teamem.get_updates');
        expect(body).toEqual({ since: 'evt-before', limit: 50 });
        return {
          ok: true,
          data: {
            ok: true,
            data: { events }
          } as T
        };
      }
    };

    const nextCursor = await pollChannelOnce({
      server: {
        async notification(notification) {
          emitted.push(notification);
        }
      },
      entry: {
        space_id: 'space-1',
        label: 'local-dev',
        member_name: 'alice',
        jwt: 'test-jwt',
        jwt_exp: Date.now() + 60_000,
        server_url: 'http://127.0.0.1:3000'
      },
      cursor: 'evt-before',
      isActive: () => true,
      rateOk: () => true,
      client,
      getUpdates: async (args, client) =>
        (await realGetUpdates.handler(args, client)) as {
          ok?: boolean;
          data?: { events?: TeamemChannelEvent[] };
        },
      onPersistCursor: (cursor) => {
        persistedCursors.push(cursor);
      }
    });

    expect(emitted).toHaveLength(2);
    const envelopes = emitted.map((notification) =>
      JSON.parse(notification.params.content)
    ) as Array<{
      event_id: string;
      event_type: string;
      scope?: { paths?: string[] };
      payload?: {
        req_id?: string;
        incumbent_principal?: string;
        blocking_claim_id?: string;
        intent?: string;
      };
    }>;
    expect(envelopes.map((envelope) => envelope.event_id)).toEqual([
      'evt-discuss-alice',
      'evt-perm-alice'
    ]);
    expect(emitted[1]!.params.meta).toEqual({
      req_id: 'req-123',
      blocking_claim_id: 'claim-9',
      incumbent_principal: 'alice',
      event_id: 'evt-perm-alice',
      event_type: 'permission_requested',
      principal: 'bob'
    });
    expect(envelopes[1]!.scope?.paths).toEqual(['src/foo.ts', 'src/bar.ts']);
    expect(envelopes[1]!.payload).toEqual({
      req_id: 'req-123',
      incumbent_principal: 'alice',
      blocking_claim_id: 'claim-9',
      intent: 'land the auth fix'
    });
    expect(nextCursor).toBe('evt-ordinary');
    expect(persistedCursors).toEqual(['evt-ordinary']);
  });

  it('primes an empty channel cursor to the latest event without replaying old notifications', async () => {
    const emitted: ClaudeChannelNotification[] = [];
    const persistedCursors: string[] = [];

    const realGetUpdates = TOOL_BINDINGS['teamem.get_updates'];
    expect(realGetUpdates).toBeDefined();

    const events: TeamemChannelEvent[] = [
      {
        event_id: 'evt-old-1',
        event_type: 'discussion_posted',
        principal: 'bob',
        payload: {
          message_id: 'msg-old-1',
          thread_id: 'thr-old-1',
          recipient_principal: 'alice',
          body: 'Old message should not replay on channel startup.'
        }
      },
      {
        event_id: 'evt-old-2',
        event_type: 'discussion_posted',
        principal: 'bob',
        payload: {
          message_id: 'msg-old-2',
          thread_id: 'thr-old-2',
          recipient_principal: 'alice',
          body: 'Another old message.'
        }
      }
    ];

    const client: BridgeHttpClient = {
      async post<T = unknown>(path: string, body: unknown) {
        expect(path).toBe('/tools/teamem.get_updates');
        expect(body).toEqual({ limit: 100 });
        return {
          ok: true,
          data: {
            ok: true,
            data: { events }
          } as T
        };
      }
    };

    const nextCursor = await pollChannelOnce({
      server: {
        async notification(notification) {
          emitted.push(notification);
        }
      },
      entry: {
        space_id: 'space-1',
        label: 'local-dev',
        member_name: 'alice',
        jwt: 'test-jwt',
        jwt_exp: Date.now() + 60_000,
        server_url: 'http://127.0.0.1:3000'
      },
      cursor: null,
      isActive: () => true,
      rateOk: () => true,
      client,
      getUpdates: async (args, client) =>
        (await realGetUpdates.handler(args, client)) as {
          ok?: boolean;
          data?: { events?: TeamemChannelEvent[] };
        },
      onPersistCursor: (cursor) => {
        persistedCursors.push(cursor);
      }
    });

    expect(emitted).toHaveLength(0);
    expect(nextCursor).toBe('evt-old-2');
    expect(persistedCursors).toEqual(['evt-old-2']);
  });

  it('primes through more than 25 full pages of old history before emitting live events', async () => {
    const emitted: ClaudeChannelNotification[] = [];
    const persistedCursors: string[] = [];
    let calls = 0;

    const realGetUpdates = TOOL_BINDINGS['teamem.get_updates'];
    expect(realGetUpdates).toBeDefined();

    function oldEvent(index: number): TeamemChannelEvent {
      const id = `evt-old-${String(index).padStart(4, '0')}`;
      return {
        event_id: id,
        event_type: 'discussion_posted',
        principal: 'bob',
        payload: {
          message_id: `msg-old-${index}`,
          thread_id: `thr-old-${index}`,
          recipient_principal: 'alice',
          body: 'Old message should not replay on channel startup.'
        }
      };
    }

    const client: BridgeHttpClient = {
      async post<T = unknown>(path: string, body: unknown) {
        expect(path).toBe('/tools/teamem.get_updates');
        const start = calls * 100;
        const events =
          calls < 26
            ? Array.from({ length: 100 }, (_, offset) =>
                oldEvent(start + offset)
              )
            : [oldEvent(start)];
        const expectedBody =
          calls === 0
            ? { limit: 100 }
            : {
                since: `evt-old-${String(start - 1).padStart(4, '0')}`,
                limit: 100
              };
        calls += 1;
        expect(body).toEqual(expectedBody);
        return {
          ok: true,
          data: {
            ok: true,
            data: { events }
          } as T
        };
      }
    };

    const nextCursor = await pollChannelOnce({
      server: {
        async notification(notification) {
          emitted.push(notification);
        }
      },
      entry: {
        space_id: 'space-1',
        label: 'local-dev',
        member_name: 'alice',
        jwt: 'test-jwt',
        jwt_exp: Date.now() + 60_000,
        server_url: 'http://127.0.0.1:3000'
      },
      cursor: null,
      isActive: () => true,
      rateOk: () => true,
      client,
      getUpdates: async (args, client) =>
        (await realGetUpdates.handler(args, client)) as {
          ok?: boolean;
          data?: { events?: TeamemChannelEvent[] };
        },
      onPersistCursor: (cursor) => {
        persistedCursors.push(cursor);
      }
    });

    expect(calls).toBe(27);
    expect(emitted).toHaveLength(0);
    expect(nextCursor).toBe('evt-old-2600');
    expect(persistedCursors).toEqual(['evt-old-2600']);
  });

  it('remembers an empty startup as primed and emits the first later discussion event', async () => {
    const emitted: ClaudeChannelNotification[] = [];
    const persistedCursors: string[] = [];
    let calls = 0;

    const realGetUpdates = TOOL_BINDINGS['teamem.get_updates'];
    expect(realGetUpdates).toBeDefined();

    const liveEvent: TeamemChannelEvent = {
      event_id: 'evt-live-1',
      event_type: 'discussion_posted',
      principal: 'bob',
      payload: {
        message_id: 'msg-live-1',
        thread_id: 'thr-live-1',
        recipient_principal: 'alice',
        body: 'This should arrive after an empty startup.'
      }
    };

    const client: BridgeHttpClient = {
      async post<T = unknown>(path: string, body: unknown) {
        calls += 1;
        expect(path).toBe('/tools/teamem.get_updates');
        if (calls === 1) {
          expect(body).toEqual({ limit: 100 });
          return {
            ok: true,
            data: {
              ok: true,
              data: { events: [] }
            } as T
          };
        }
        expect(body).toEqual({ limit: 50 });
        return {
          ok: true,
          data: {
            ok: true,
            data: { events: [liveEvent] }
          } as T
        };
      }
    };

    const commonOptions = {
      server: {
        async notification(notification: ClaudeChannelNotification) {
          emitted.push(notification);
        }
      },
      entry: {
        space_id: 'space-1',
        label: 'local-dev',
        member_name: 'alice',
        jwt: 'test-jwt',
        jwt_exp: Date.now() + 60_000,
        server_url: 'http://127.0.0.1:3000'
      },
      isActive: () => true,
      rateOk: () => true,
      client,
      getUpdates: async (
        args: { since?: string; limit: number },
        client: BridgeHttpClient
      ) =>
        (await realGetUpdates.handler(args, client)) as {
          ok?: boolean;
          data?: { events?: TeamemChannelEvent[] };
        },
      onPersistCursor: (cursor: string) => {
        persistedCursors.push(cursor);
      }
    };

    const emptyCursor = await pollChannelOnce({
      ...commonOptions,
      cursor: null
    });
    expect(emptyCursor).toBe(EMPTY_CHANNEL_CURSOR);
    expect(emitted).toHaveLength(0);

    const nextCursor = await pollChannelOnce({
      ...commonOptions,
      cursor: emptyCursor
    });

    expect(nextCursor).toBe('evt-live-1');
    expect(emitted).toHaveLength(1);
    expect(JSON.parse(emitted[0]!.params.content).event_id).toBe('evt-live-1');
    expect(persistedCursors).toEqual([EMPTY_CHANNEL_CURSOR, 'evt-live-1']);
  });

  it('emits full decision payloads for online teammates from get_updates', async () => {
    const emitted: ClaudeChannelNotification[] = [];
    const realGetUpdates = TOOL_BINDINGS['teamem.get_updates'];
    expect(realGetUpdates).toBeDefined();

    const events: TeamemChannelEvent[] = [
      {
        event_id: 'evt-decision-1',
        event_type: 'decision_published',
        principal: 'bob',
        payload: {
          decision_id: 'dec-1',
          title: 'Online full-text delivery',
          summary: 'Channels should include the full decision body.',
          body: 'This is the full decision text that should be broadcast online.',
          kind: 'architectural',
          version: 1
        }
      }
    ];

    const client: BridgeHttpClient = {
      async post<T = unknown>(path: string, body: unknown) {
        expect(path).toBe('/tools/teamem.get_updates');
        expect(body).toEqual({ since: 'evt-before', limit: 50 });
        return {
          ok: true,
          data: {
            ok: true,
            data: { events }
          } as T
        };
      }
    };

    const nextCursor = await pollChannelOnce({
      server: {
        async notification(notification) {
          emitted.push(notification);
        }
      },
      entry: {
        space_id: 'space-1',
        label: 'local-dev',
        member_name: 'alice',
        jwt: 'test-jwt',
        jwt_exp: Date.now() + 60_000,
        server_url: 'http://127.0.0.1:3000'
      },
      cursor: 'evt-before',
      isActive: () => true,
      rateOk: () => true,
      client,
      getUpdates: async (args, boundClient) =>
        (await realGetUpdates.handler(args, boundClient)) as {
          ok?: boolean;
          data?: { events?: TeamemChannelEvent[] };
        }
    });

    expect(nextCursor).toBe('evt-decision-1');
    expect(emitted).toHaveLength(1);
    const envelope = JSON.parse(emitted[0]!.params.content) as {
      event_type: string;
      payload: { title: string; body: string };
    };
    expect(envelope.event_type).toBe('decision_published');
    expect(envelope.payload.title).toBe('Online full-text delivery');
    expect(envelope.payload.body).toBe(
      'This is the full decision text that should be broadcast online.'
    );
  });
});
