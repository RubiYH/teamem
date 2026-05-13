import { describe, expect, it } from 'bun:test';
import { TOOL_BINDINGS } from '../../../src/bridge/tool-bindings.js';

describe('decision tool bindings', () => {
  it('exposes explicit lifecycle tools and documents their response shape', () => {
    for (const name of [
      'teamem.publish_decision',
      'teamem.amend_decision',
      'teamem.supersede_decision',
      'teamem.record_decision'
    ] as const) {
      const binding = TOOL_BINDINGS[name];
      expect(binding).toBeDefined();
      const schema = binding.responseSchema;
      expect(schema).toBeDefined();
      const parsed = schema?.safeParse({
        ok: true,
        data: {
          event_id: '01JDECISIONLIFECYCLE0000000',
          decision_id: 'dec-1',
          lifecycle_event:
            name === 'teamem.supersede_decision'
              ? 'decision_superseded'
              : 'decision_published',
          version: 1,
          kind: 'architectural',
          status: name === 'teamem.supersede_decision' ? 'superseded' : 'open',
          superseded_by_decision_id:
            name === 'teamem.supersede_decision' ? 'dec-2' : null
        }
      });
      expect(parsed?.success).toBe(true);
    }
  });

  it('documents body support on publish/record and successor linkage on publish/supersede', () => {
    const publish = TOOL_BINDINGS['teamem.publish_decision'];
    const amend = TOOL_BINDINGS['teamem.amend_decision'];
    const supersede = TOOL_BINDINGS['teamem.supersede_decision'];
    const record = TOOL_BINDINGS['teamem.record_decision'];

    expect(
      publish.inputSchema.safeParse({ decision_id: 'd', title: 't' }).success
    ).toBe(true);
    expect(
      publish.inputSchema.safeParse({
        decision_id: 'd',
        title: 't',
        body: 'full text',
        supersedes_decision_id: 'd-0'
      }).success
    ).toBe(true);
    expect(
      amend.inputSchema.safeParse({
        decision_id: 'd',
        body: 'updated full text'
      }).success
    ).toBe(true);
    expect(
      supersede.inputSchema.safeParse({
        decision_id: 'd',
        superseded_by_decision_id: 'd-2'
      }).success
    ).toBe(true);
    expect(
      record.inputSchema.safeParse({
        decision_id: 'd',
        title: 't',
        body: 'compat body'
      }).success
    ).toBe(true);
  });

  it('documents session_sync decision replay payloads with full text', () => {
    const binding = TOOL_BINDINGS['teamem.session_sync'];
    expect(binding).toBeDefined();

    const parsed = binding.responseSchema?.safeParse({
      ok: true,
      data: {
        space_rules_snapshot: {
          has_server_rules: false,
          rendered_rules_body: '',
          metadata: {
            format_version: 1,
            source: 'none',
            managed_begin: '<!-- BEGIN TEAMEM SPACE RULES -->',
            managed_end: '<!-- END TEAMEM SPACE RULES -->',
            rules_version: 0,
            rules_hash: 'hash',
            generated_at: '2026-05-10T01:02:03.000Z',
            space_id: 'teamem-poc',
            space_label: 'Teamem',
            source_event_id: null,
            snapshot_updated_at: null,
            snapshot_updated_by: null
          }
        },
        decisions: [
          {
            event_id: '01JDECISIONSYNC000000000000',
            event_type: 'decision_amended',
            principal: 'bob',
            created_at: '2026-05-10T01:02:03.000Z',
            payload: {
              decision_id: 'dec-1',
              title: 'Keep full text',
              summary: 'Replay should include summary and body.',
              body: 'Full decision body.',
              kind: 'architectural',
              version: 2,
              superseded_by_decision_id: null
            }
          }
        ],
        decision_replays: [],
        gotcha_notices: []
      }
    });

    expect(parsed?.success).toBe(true);
  });
});
