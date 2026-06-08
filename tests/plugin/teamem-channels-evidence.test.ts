import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  McpTrace,
  McpTraceMessage
} from '../../plugin-e2e-module/src/index.js';
import { createClaudeChannelNotification } from '../../src/channel/payload.js';
import type { TeamemChannelEnvelope } from '../../src/channel/payload.js';
import {
  TeamemChannelsEvidenceError,
  assertTeamemChannelTransportEvidence,
  assertTeamemNegativeRecipientEvidence,
  assertTeamemNoChannelEvidenceForMarker,
  assertTeamemNoSenderEchoEvidence,
  assertTeamemNotificationLogEvidence,
  assertTeamemRenderedTranscriptEvidence,
  assertTeamemRecipientReceipt,
  createTeamemChannelsTranscriptCheckpoint,
  expectedTeamemChannelsDeliveryMatrix,
  expectedTeamemSprintChannelsDeliveryMatrix,
  findTeamemChannelTransportEvidence,
  findTeamemNotificationLogEvidence,
  findTeamemRenderedTranscriptEvidence,
  type TeamemChannelsEvidenceExpectation,
  type TeamemChannelsTranscriptCheckpoint
} from './teamem-channels-evidence.js';

describe('Teamem Channels evidence assertions', () => {
  it('matches channel notifications by ids, principals, scope, and marker', () => {
    const expected = expectation({
      caseName: 'direct',
      marker: markerFor('run-1', 'direct'),
      recipientPrincipal: 'bob',
      deliveryScope: 'direct'
    });
    const trace = fakeTrace([
      fakeChannelMessage({
        expected: {
          ...expected,
          eventId: 'evt-other',
          marker: markerFor('run-1', 'direct')
        },
        offsetMs: 200
      }),
      fakeChannelMessage({
        expected: {
          ...expected,
          recipientPrincipal: 'carol'
        },
        offsetMs: 250
      }),
      fakeChannelMessage({ expected, offsetMs: 275 })
    ]);

    const evidence = findTeamemChannelTransportEvidence({
      traces: [trace],
      expected
    });

    expect(evidence.message.offsetMs).toBe(275);
    expect(evidence.envelope.event_id).toBe('evt-direct-bob');
    expect(evidence.envelope.payload).toMatchObject({
      thread_id: 'thr-direct',
      message_id: 'msg-direct-bob',
      body: expect.stringContaining(markerFor('run-1', 'direct'))
    });
  });

  it('matches decision broadcasts by event metadata and required full payload text', () => {
    const expected = decisionExpectation({
      runId: 'run-1',
      marker: markerFor('run-1', 'decision-live', 'body'),
      recipientPrincipal: 'bob',
      title: 'Decision title marker-run-1-decision-live-title',
      body: 'Decision body marker-run-1-decision-live-body with full rationale'
    });
    const trace = fakeTrace([
      fakeDecisionChannelMessage({
        expected: { ...expected, eventId: 'evt-other-decision' },
        offsetMs: 100
      }),
      fakeDecisionChannelMessage({ expected, offsetMs: 125 })
    ]);
    const notificationEvidence = {
      lineIndex: 2,
      envelope: decisionChannelEnvelope(expected)
    };

    const transport = findTeamemChannelTransportEvidence({
      traces: [trace],
      expected
    });
    expect(transport.envelope.event_type).toBe('decision_published');
    expect(transport.envelope.payload).toMatchObject({
      decision_id: 'dec-marker-run-1-decision-live-body',
      title: 'Decision title marker-run-1-decision-live-title',
      body: 'Decision body marker-run-1-decision-live-body with full rationale',
      version: 1
    });

    expect(
      findTeamemNotificationLogEvidence({
        log: JSON.stringify(decisionChannelEnvelope(expected)),
        expected
      }).envelope.event_type
    ).toBe('decision_published');

    expect(
      findTeamemRenderedTranscriptEvidence({
        rawTranscript: [
          'ready',
          `teamem-channel:${JSON.stringify(decisionChannelEnvelope(expected))}`
        ].join('\n'),
        normalizedTranscript: 'ready',
        expected,
        checkpoint: {
          rawOffset: 'ready\n'.length,
          normalizedOffset: 'ready'.length
        },
        notificationEvidence
      })
    ).toMatchObject({ source: 'raw', renderKind: 'marker' });

    expect(
      findTeamemRenderedTranscriptEvidence({
        rawTranscript: [
          'ready',
          'teamem-channel:{"name":"teamem.peer_event","route":"peer","principal":"ali…'
        ].join('\n'),
        normalizedTranscript: 'ready',
        expected,
        checkpoint: {
          rawOffset: 'ready\n'.length,
          normalizedOffset: 'ready'.length
        },
        notificationEvidence
      })
    ).toMatchObject({ source: 'raw', renderKind: 'channel-source' });

    expect(
      findTeamemRenderedTranscriptEvidence({
        rawTranscript: [
          'ready',
          '←tame-channel:{"name":"teamem.peer_event","route":"peer","principal":"ali…'
        ].join('\n'),
        normalizedTranscript: 'ready',
        expected,
        checkpoint: {
          rawOffset: 'ready\n'.length,
          normalizedOffset: 'ready'.length
        },
        notificationEvidence
      })
    ).toMatchObject({ source: 'raw', renderKind: 'channel-source' });

    expect(
      findTeamemRenderedTranscriptEvidence({
        rawTranscript: 'ready',
        normalizedTranscript: [
          'ready',
          '←tamem-chanel:{"name":"teamem.peer_event","route":"peer","principal":"ali…'
        ].join('\n'),
        expected,
        checkpoint: {
          rawOffset: 'ready'.length,
          normalizedOffset: 'ready\n'.length
        },
        notificationEvidence
      })
    ).toMatchObject({ source: 'normalized', renderKind: 'channel-source' });

    expect(() =>
      findTeamemRenderedTranscriptEvidence({
        rawTranscript: [
          'ready',
          `teamem-channel:${JSON.stringify(
            decisionChannelEnvelope({ ...expected, body: 'truncated body' })
          )}`
        ].join('\n'),
        normalizedTranscript: 'ready',
        expected,
        checkpoint: {
          rawOffset: 'ready\n'.length,
          normalizedOffset: 'ready'.length
        },
        notificationEvidence
      })
    ).toThrow(/rendered transcript/);
  });

  it('matches compact gotcha notices and rejects full body leakage', () => {
    const expected = gotchaExpectation({
      runId: 'run-1',
      summaryMarker: markerFor('run-1', 'gotcha-live', 'summary'),
      bodyMarker: markerFor('run-1', 'gotcha-live', 'body'),
      recipientPrincipal: 'bob'
    });
    const trace = fakeTrace([
      fakeGotchaChannelMessage({ expected, offsetMs: 125 })
    ]);
    const notificationEvidence = {
      lineIndex: 2,
      envelope: gotchaChannelEnvelope(expected)
    };

    const transport = findTeamemChannelTransportEvidence({
      traces: [trace],
      expected
    });
    expect(transport.envelope.event_type).toBe('finding_shared');
    expect(transport.envelope.payload).toMatchObject({
      finding_id: 'finding-marker-run-1-gotcha-live-summary',
      kind: 'gotcha',
      version: 1,
      summary: expected.summary,
      severity: 'warning',
      tags: ['teamem-smoke', 'gotcha-live']
    });
    expect(JSON.stringify(transport.envelope)).not.toContain(
      expected.bodyMarker
    );

    expect(
      findTeamemNotificationLogEvidence({
        log: JSON.stringify(gotchaChannelEnvelope(expected)),
        expected
      }).envelope.payload
    ).toMatchObject({ summary: expected.summary });

    expect(
      findTeamemRenderedTranscriptEvidence({
        rawTranscript: [
          'ready',
          `teamem-channel:${JSON.stringify(gotchaChannelEnvelope(expected))}`
        ].join('\n'),
        normalizedTranscript: 'ready',
        expected,
        checkpoint: {
          rawOffset: 'ready\n'.length,
          normalizedOffset: 'ready'.length
        },
        notificationEvidence
      })
    ).toMatchObject({ source: 'raw', renderKind: 'marker' });

    const leakingEnvelope = gotchaChannelEnvelope({
      ...expected,
      includeBodyLeak: true
    });
    expectEvidenceLayer(
      () =>
        findTeamemChannelTransportEvidence({
          traces: [
            fakeTrace([
              fakeGotchaChannelMessage({
                expected: { ...expected, includeBodyLeak: true },
                offsetMs: 125
              })
            ])
          ],
          expected
        }),
      'body-leakage'
    );
    expectEvidenceLayer(
      () =>
        findTeamemNotificationLogEvidence({
          log: JSON.stringify(leakingEnvelope),
          expected
        }),
      'body-leakage'
    );
    expectEvidenceLayer(
      () =>
        findTeamemRenderedTranscriptEvidence({
          rawTranscript: [
            'ready',
            `teamem-channel:${JSON.stringify(leakingEnvelope)}`
          ].join('\n'),
          normalizedTranscript: 'ready',
          expected,
          checkpoint: {
            rawOffset: 'ready\n'.length,
            normalizedOffset: 'ready'.length
          },
          notificationEvidence: {
            lineIndex: 2,
            envelope: leakingEnvelope
          }
        }),
      'body-leakage'
    );
  });

  it('binds evidence to run and case through the marker instead of fake metadata', () => {
    const expected = expectation({
      runId: 'run-direct-1',
      caseName: 'direct',
      marker: markerFor('run-direct-1', 'direct'),
      recipientPrincipal: 'bob',
      deliveryScope: 'direct'
    });
    const wrongRunMarker = markerFor('run-star-1', 'star');
    const sameIdsWrongMarker = {
      ...expected,
      marker: wrongRunMarker
    };
    const trace = fakeTrace([
      fakeChannelMessage({
        expected: sameIdsWrongMarker,
        offsetMs: 100
      })
    ]);
    const log = JSON.stringify(channelEnvelope(sameIdsWrongMarker));

    expect(() =>
      findTeamemChannelTransportEvidence({
        traces: [trace],
        expected
      })
    ).toThrow(TeamemChannelsEvidenceError);

    expect(() =>
      findTeamemNotificationLogEvidence({
        log,
        expected
      })
    ).toThrow(TeamemChannelsEvidenceError);

    expect(() =>
      findTeamemChannelTransportEvidence({
        traces: [fakeTrace([fakeChannelMessage({ expected, offsetMs: 100 })])],
        expected: { ...expected, marker: 'marker-without-run-or-case' }
      })
    ).toThrow(/expected marker must include run id and case identity/);
  });

  it('classifies missing and unreadable trace artifacts as channel transport while same-id stale traces are stale evidence', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'teamem-evidence-trace-'));
    const expected = expectation({
      caseName: 'direct',
      marker: markerFor('run-1', 'direct', 'missing'),
      recipientPrincipal: 'bob',
      deliveryScope: 'direct'
    });
    const unreadablePath = join(tempRoot, 'bad-trace.json');
    const unmatchedPath = join(tempRoot, 'unmatched-trace.json');
    await writeFile(unreadablePath, '{not-json');
    await writeFile(
      unmatchedPath,
      JSON.stringify(
        fakeTrace([
          fakeChannelMessage({
            expected: {
              ...expected,
              marker: markerFor('run-1', 'direct', 'stale')
            },
            offsetMs: 5
          })
        ])
      )
    );

    try {
      await expect(
        assertTeamemChannelTransportEvidence({
          tracePath: join(tempRoot, 'missing-trace.json'),
          expected
        })
      ).rejects.toMatchObject({ layer: 'channel transport' });

      await expect(
        assertTeamemChannelTransportEvidence({
          tracePath: unreadablePath,
          expected
        })
      ).rejects.toMatchObject({ layer: 'channel transport' });

      await expect(
        assertTeamemChannelTransportEvidence({
          tracePath: unmatchedPath,
          expected
        })
      ).rejects.toMatchObject({ layer: 'stale evidence' });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('parses recipient notification logs without accepting older unrelated lines', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'teamem-evidence-log-'));
    const logPath = join(tempRoot, 'notifications.log');
    const oldExpected = expectation({
      caseName: 'direct',
      marker: markerFor('run-1', 'direct', 'log-new'),
      recipientPrincipal: 'bob',
      deliveryScope: 'direct'
    });
    const expected = {
      ...oldExpected,
      eventId: 'evt-new',
      messageId: 'msg-new'
    };
    await writeFile(
      logPath,
      [
        JSON.stringify(channelEnvelope(oldExpected)),
        JSON.stringify(
          channelEnvelope({ ...expected, marker: 'wrong-marker' })
        ),
        JSON.stringify(channelEnvelope(expected))
      ].join('\n')
    );

    try {
      const evidence = await assertTeamemNotificationLogEvidence({
        notificationLogPath: logPath,
        expected,
        checkpoint: { lineOffset: 1 }
      });
      expect(evidence.lineIndex).toBe(2);

      expect(() =>
        findTeamemNotificationLogEvidence({
          log: JSON.stringify(
            channelEnvelope({
              ...expected,
              recipientPrincipal: 'carol'
            })
          ),
          expected
        })
      ).toThrow(TeamemChannelsEvidenceError);

      expect(() =>
        findTeamemNotificationLogEvidence({
          log: JSON.stringify(channelEnvelope(expected)),
          expected,
          checkpoint: { lineOffset: 1 }
        })
      ).toThrow(TeamemChannelsEvidenceError);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('uses checkpointed transcript segments after notification evidence exists', () => {
    const expected = expectation({
      caseName: 'star',
      marker: markerFor('run-1', 'star', 'render'),
      recipientPrincipal: 'carol',
      deliveryScope: 'space'
    });
    const checkpoint = createTeamemChannelsTranscriptCheckpoint({
      rawTranscript: `old ${expected.marker}`,
      normalizedTranscript: `old ${expected.marker}`,
      traceOffsetMs: 400,
      notificationLineOffset: 3
    });
    const notificationEvidence = {
      lineIndex: 4,
      envelope: channelEnvelope(expected)
    };

    expect(
      findTeamemRenderedTranscriptEvidence({
        rawTranscript: `old ${expected.marker}\nnew ${expected.marker}`,
        normalizedTranscript: `old ${expected.marker}`,
        expected,
        checkpoint,
        notificationEvidence
      })
    ).toMatchObject({ source: 'raw', renderKind: 'marker' });

    expect(
      findTeamemRenderedTranscriptEvidence({
        rawTranscript: [
          `old ${expected.marker}`,
          'teamem-channel:{"name":"teamem.peer_event","route":"peer","principal":"alice"}'
        ].join('\n'),
        normalizedTranscript: `old ${expected.marker}`,
        expected,
        checkpoint,
        notificationEvidence
      })
    ).toMatchObject({ source: 'raw', renderKind: 'channel-source' });

    expect(() =>
      findTeamemRenderedTranscriptEvidence({
        rawTranscript: `old ${expected.marker}`,
        normalizedTranscript: `old ${expected.marker}`,
        expected,
        checkpoint,
        notificationEvidence
      })
    ).toThrow(/stale evidence/);

    expect(() =>
      findTeamemRenderedTranscriptEvidence({
        rawTranscript:
          'teamem-channel:{"name":"teamem.peer_event","route":"peer","principal":"alice"}',
        normalizedTranscript: '',
        expected,
        checkpoint: {
          rawOffset:
            'teamem-channel:{"name":"teamem.peer_event","route":"peer","principal":"alice"}'
              .length,
          normalizedOffset: 0
        },
        notificationEvidence
      })
    ).toThrow(/stale evidence/);

    expect(() =>
      findTeamemRenderedTranscriptEvidence({
        rawTranscript: `old ${expected.marker}\nnew ${expected.marker}`,
        normalizedTranscript: `old ${expected.marker}`,
        expected,
        checkpoint,
        notificationEvidence: {
          lineIndex: 4,
          envelope: channelEnvelope({ ...expected, eventId: 'evt-unrelated' })
        }
      })
    ).toThrow(/rendered transcript/);

    expect(() =>
      findTeamemRenderedTranscriptEvidence({
        rawTranscript: `old ${expected.marker}\nnew ${expected.marker}`,
        normalizedTranscript: `old ${expected.marker}`,
        expected,
        checkpoint,
        notificationEvidence: {
          lineIndex: 2,
          envelope: channelEnvelope(expected)
        }
      })
    ).toThrow(/stale evidence/);
  });

  it('rejects stale reuse evidence by trace offset, log line, and transcript checkpoint', () => {
    const expected = expectation({
      caseName: 'starstar',
      marker: markerFor('run-1', 'starstar', 'reuse'),
      recipientPrincipal: 'bob',
      deliveryScope: 'space'
    });
    const trace = fakeTrace([
      fakeChannelMessage({ expected, offsetMs: 100 }),
      fakeChannelMessage({ expected, offsetMs: 500 })
    ]);
    const transport = findTeamemChannelTransportEvidence({
      traces: [trace],
      expected,
      checkpoint: { offsetMs: 400 }
    });
    expect(transport.message.offsetMs).toBe(500);

    const log = [
      JSON.stringify(channelEnvelope(expected)),
      JSON.stringify(channelEnvelope({ ...expected, eventId: 'evt-later' }))
    ].join('\n');
    expect(
      findTeamemNotificationLogEvidence({
        log,
        expected: { ...expected, eventId: 'evt-later' },
        checkpoint: { lineOffset: 1 }
      }).lineIndex
    ).toBe(1);

    const checkpoint: TeamemChannelsTranscriptCheckpoint = {
      rawOffset: `old ${expected.marker}`.length,
      normalizedOffset: 0
    };
    const rendered = findTeamemRenderedTranscriptEvidence({
      rawTranscript: `old ${expected.marker}\nnew ${expected.marker}`,
      normalizedTranscript: '',
      expected,
      checkpoint,
      notificationEvidence: {
        lineIndex: 1,
        envelope: channelEnvelope(expected)
      }
    });
    expect(rendered.markerIndex).toBeGreaterThan(checkpoint.rawOffset);
  });

  it('classifies stale trace, log, and transcript candidates with artifact context', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'teamem-evidence-stale-'));
    const expected = expectation({
      caseName: 'direct',
      marker: markerFor('run-1', 'direct', 'stale-layer'),
      recipientPrincipal: 'bob',
      deliveryScope: 'direct'
    });
    const tracePath = join(tempRoot, 'trace.json');
    const logPath = join(tempRoot, 'notifications.log');
    const rawPath = join(tempRoot, 'raw.txt');
    const normalizedPath = join(tempRoot, 'normalized.txt');
    await writeFile(
      tracePath,
      JSON.stringify(
        fakeTrace([fakeChannelMessage({ expected, offsetMs: 100 })])
      )
    );
    await writeFile(logPath, `${JSON.stringify(channelEnvelope(expected))}\n`);
    await writeFile(rawPath, `before ${expected.marker}`);
    await writeFile(normalizedPath, 'before');

    try {
      await expect(
        assertTeamemChannelTransportEvidence({
          tracePath,
          expected,
          checkpoint: { offsetMs: 400 }
        })
      ).rejects.toMatchObject({ layer: 'stale evidence' });
      await expect(
        assertTeamemChannelTransportEvidence({
          tracePath,
          expected,
          checkpoint: { offsetMs: 400 }
        })
      ).rejects.toThrow(
        /stale evidence: channel trace offset 100 was before checkpoint offset 400.*channel trace=.*trace\.json.*checkpoint=/
      );

      await expect(
        assertTeamemNotificationLogEvidence({
          notificationLogPath: logPath,
          expected,
          checkpoint: { lineOffset: 1 }
        })
      ).rejects.toMatchObject({ layer: 'stale evidence' });
      await expect(
        assertTeamemNotificationLogEvidence({
          notificationLogPath: logPath,
          expected,
          checkpoint: { lineOffset: 1 }
        })
      ).rejects.toThrow(
        /stale evidence: notification log evidence line 0 was before checkpoint line 1.*notification log=.*notifications\.log.*checkpoint=/
      );

      await expect(
        assertTeamemRenderedTranscriptEvidence({
          rawTranscriptPath: rawPath,
          normalizedTranscriptPath: normalizedPath,
          expected,
          checkpoint: {
            rawOffset: `before ${expected.marker}`.length,
            normalizedOffset: 'before'.length,
            notificationLineOffset: 1
          },
          notificationEvidence: {
            lineIndex: 1,
            envelope: channelEnvelope(expected)
          },
          artifacts: {
            channelTracePath: tracePath,
            notificationLogPath: logPath
          }
        })
      ).rejects.toMatchObject({ layer: 'stale evidence' });
      await expect(
        assertTeamemRenderedTranscriptEvidence({
          rawTranscriptPath: rawPath,
          normalizedTranscriptPath: normalizedPath,
          expected,
          checkpoint: {
            rawOffset: `before ${expected.marker}`.length,
            normalizedOffset: 'before'.length,
            notificationLineOffset: 1
          },
          notificationEvidence: {
            lineIndex: 1,
            envelope: channelEnvelope(expected)
          },
          artifacts: {
            channelTracePath: tracePath,
            notificationLogPath: logPath
          }
        })
      ).rejects.toThrow(
        /stale evidence: rendered transcript marker existed only before checkpoint.*channel trace=.*trace\.json.*notification log=.*notifications\.log.*raw transcript=.*raw\.txt.*normalized transcript=.*normalized\.txt.*checkpoint=/
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('classifies same-id wrong-marker candidates as stale instead of missing', () => {
    const expected = expectation({
      runId: 'run-2',
      caseName: 'direct',
      marker: markerFor('run-2', 'direct', 'fresh'),
      recipientPrincipal: 'bob',
      deliveryScope: 'direct'
    });
    const staleExpected = {
      ...expected,
      marker: markerFor('run-1', 'direct', 'fresh')
    };

    expect(() =>
      findTeamemChannelTransportEvidence({
        traces: [
          fakeTrace([
            fakeChannelMessage({ expected: staleExpected, offsetMs: 25 })
          ])
        ],
        expected,
        artifacts: { channelTracePath: '/tmp/channel-trace.json' }
      })
    ).toThrow(/stale evidence: channel trace matched ids\/principals/);
    expect(() =>
      findTeamemNotificationLogEvidence({
        log: JSON.stringify(channelEnvelope(staleExpected)),
        expected,
        artifacts: { notificationLogPath: '/tmp/notifications.log' }
      })
    ).toThrow(/stale evidence: notification log matched ids\/principals/);
  });

  it('classifies negative routing and render failures with path-rich context', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'teamem-evidence-errors-'));
    const expected = expectation({
      caseName: 'direct',
      marker: markerFor('run-1', 'direct', 'error'),
      recipientPrincipal: 'alice',
      deliveryScope: 'direct'
    });
    const tracePath = join(tempRoot, 'trace.json');
    const logPath = join(tempRoot, 'notifications.log');
    const rawPath = join(tempRoot, 'raw.txt');
    const normalizedPath = join(tempRoot, 'normalized.txt');
    await writeFile(rawPath, 'no marker after checkpoint');
    await writeFile(normalizedPath, 'still no marker');

    try {
      expect(() =>
        assertTeamemNegativeRecipientEvidence({
          persona: 'alice',
          expected,
          traces: [fakeTrace([fakeChannelMessage({ expected, offsetMs: 5 })])],
          traceCheckpoint: { offsetMs: 0 },
          artifacts: { channelTracePath: tracePath }
        })
      ).toThrow(/negative-recipient filtering/);

      await expect(
        assertTeamemRenderedTranscriptEvidence({
          rawTranscriptPath: rawPath,
          normalizedTranscriptPath: normalizedPath,
          expected,
          checkpoint: {
            rawOffset: 0,
            normalizedOffset: 0,
            capturedAt: '2026-06-04T00:00:00.000Z',
            traceOffsetMs: 10,
            notificationLineOffset: 2
          },
          notificationEvidence: {
            lineIndex: 2,
            envelope: channelEnvelope(expected)
          },
          artifacts: {
            channelTracePath: tracePath,
            notificationLogPath: logPath
          }
        })
      ).rejects.toThrow(
        /run id=run-1.*case=direct.*persona=alice.*marker=marker-run-1-direct-error.*channel trace=.*trace\.json.*notification log=.*notifications\.log.*raw transcript=.*raw\.txt.*normalized transcript=.*normalized\.txt.*checkpoint=/
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('allows Alice prompt/body transcript echoes but rejects later rendered markers', () => {
    const expected = expectation({
      caseName: 'direct',
      marker: markerFor('run-1', 'direct', 'echo'),
      recipientPrincipal: 'bob',
      deliveryScope: 'direct'
    });
    const prefix = 'checkpointed transcript\n';
    const directPrompt = `/teamem:teamem-discuss bob -- human text ${expected.marker}`;
    const body = `human text ${expected.marker}`;
    const checkpoint: TeamemChannelsTranscriptCheckpoint = {
      rawOffset: prefix.length,
      normalizedOffset: prefix.length
    };

    expect(() =>
      assertTeamemNegativeRecipientEvidence({
        persona: 'alice',
        expected,
        rawTranscript: `${prefix}${directPrompt}`,
        normalizedTranscript: `${prefix}${body}`,
        transcriptCheckpoint: checkpoint,
        allowedTranscriptMarkerEchoes: [directPrompt, body]
      })
    ).not.toThrow();

    const wrappedPromptEcho = [
      `${prefix}> /teamem:teamem-discuss bob -- human text`,
      expected.marker,
      'Propagating...'
    ].join('\n');
    expect(() =>
      assertTeamemNegativeRecipientEvidence({
        persona: 'alice',
        expected,
        rawTranscript: wrappedPromptEcho,
        normalizedTranscript: wrappedPromptEcho,
        transcriptCheckpoint: checkpoint,
        allowedTranscriptMarkerEchoes: [directPrompt, body]
      })
    ).not.toThrow();

    const compactPromptEcho = [
      `${prefix}/teamem:teamem-discussbob--humantext`,
      expected.marker
    ].join('\n');
    expect(() =>
      assertTeamemNegativeRecipientEvidence({
        persona: 'alice',
        expected,
        rawTranscript: compactPromptEcho,
        normalizedTranscript: compactPromptEcho,
        transcriptCheckpoint: checkpoint,
        allowedTranscriptMarkerEchoes: [directPrompt, body]
      })
    ).not.toThrow();

    expect(() =>
      assertTeamemNegativeRecipientEvidence({
        persona: 'alice',
        expected,
        rawTranscript: [
          compactPromptEcho,
          `teamem-channel:${JSON.stringify(channelEnvelope(expected))}`
        ].join('\n'),
        normalizedTranscript: compactPromptEcho,
        transcriptCheckpoint: checkpoint,
        allowedTranscriptMarkerEchoes: [directPrompt, body]
      })
    ).toThrow(/negative-recipient filtering/);
  });

  it('classifies Alice sender-echo transport, log, and render failures as sender-echo', () => {
    const expected = decisionExpectation({
      runId: 'run-1',
      marker: markerFor('run-1', 'decision-live', 'sender-echo'),
      recipientPrincipal: 'alice',
      title: 'Decision title marker-run-1-decision-live-sender-echo',
      body: 'Decision body marker-run-1-decision-live-sender-echo'
    });
    const checkpoint: TeamemChannelsTranscriptCheckpoint = {
      rawOffset: 'ready\n'.length,
      normalizedOffset: 'ready\n'.length
    };

    expectEvidenceLayer(
      () =>
        assertTeamemNoSenderEchoEvidence({
          persona: 'alice',
          expected,
          traces: [
            fakeTrace([fakeDecisionChannelMessage({ expected, offsetMs: 25 })])
          ],
          traceCheckpoint: { offsetMs: 10 }
        }),
      'sender-echo'
    );

    expectEvidenceLayer(
      () =>
        assertTeamemNoSenderEchoEvidence({
          persona: 'alice',
          expected,
          notificationLog: JSON.stringify(decisionChannelEnvelope(expected)),
          notificationCheckpoint: { lineOffset: 0 }
        }),
      'sender-echo'
    );

    expectEvidenceLayer(
      () =>
        assertTeamemNoSenderEchoEvidence({
          persona: 'alice',
          expected,
          rawTranscript: [
            'ready',
            `teamem-channel:${JSON.stringify(decisionChannelEnvelope(expected))}`
          ].join('\n'),
          normalizedTranscript: 'ready\n',
          transcriptCheckpoint: checkpoint
        }),
      'sender-echo'
    );
  });

  it('allows Alice prompt/body echoes in sender-echo assertions', () => {
    const expected = decisionExpectation({
      runId: 'run-1',
      marker: markerFor('run-1', 'decision-live', 'allowed-echo'),
      recipientPrincipal: 'alice',
      title: 'Decision title marker-run-1-decision-live-allowed-echo',
      body: 'Decision body marker-run-1-decision-live-allowed-echo'
    });
    const prefix = 'ready\n';
    const prompt = `/teamem-decide ${expected.title} -- ${expected.body} --kind=process`;

    expect(() =>
      assertTeamemNoSenderEchoEvidence({
        persona: 'alice',
        expected,
        rawTranscript: `${prefix}${prompt}`,
        normalizedTranscript: `${prefix}${expected.body}`,
        transcriptCheckpoint: {
          rawOffset: prefix.length,
          normalizedOffset: prefix.length
        },
        allowedTranscriptMarkerEchoes: [prompt, expected.title, expected.body]
      })
    ).not.toThrow();

    const wrappedPrompt = [
      `${prefix}/teamem:teamem-decide ${expected.title}`,
      `-- ${expected.body}`,
      '--kind=process'
    ].join('\n');
    expect(() =>
      assertTeamemNoSenderEchoEvidence({
        persona: 'alice',
        expected,
        rawTranscript: wrappedPrompt,
        normalizedTranscript: wrappedPrompt,
        transcriptCheckpoint: {
          rawOffset: prefix.length,
          normalizedOffset: prefix.length
        },
        allowedTranscriptMarkerEchoes: [prompt, expected.title, expected.body]
      })
    ).not.toThrow();
  });

  it('rejects fresh non-discussion Channel transport/log/render evidence by marker', () => {
    const expected = negativeMarkerExpectation({
      runId: 'run-1',
      caseName: 'claim-conflict',
      marker: markerFor('run-1', 'claim-conflict', 'quiet'),
      eventTypes: ['scope_claimed', 'conflict_queued', 'permission_requested']
    });

    expect(() =>
      assertTeamemNoChannelEvidenceForMarker({
        persona: 'alice',
        expected,
        traces: [
          fakeTrace([
            fakeMarkerChannelMessage({
              expected,
              eventType: 'conflict_queued',
              offsetMs: 50
            })
          ])
        ],
        traceCheckpoint: { offsetMs: 10 },
        artifacts: { channelTracePath: '/tmp/trace.json' }
      })
    ).toThrow(/channel transport: unexpected fresh Channel MCP trace/);

    expect(() =>
      assertTeamemNoChannelEvidenceForMarker({
        persona: 'bob',
        expected,
        notificationLog: JSON.stringify(
          markerChannelEnvelope({
            expected,
            eventType: 'scope_claimed'
          })
        ),
        notificationCheckpoint: { lineOffset: 0 },
        artifacts: { notificationLogPath: '/tmp/notifications.log' }
      })
    ).toThrow(/notification log: unexpected fresh notification-log envelope/);

    expect(() =>
      assertTeamemNoChannelEvidenceForMarker({
        persona: 'carol',
        expected,
        rawTranscript: [
          'checkpoint',
          `teamem-channel:${JSON.stringify(
            markerChannelEnvelope({
              expected,
              eventType: 'permission_requested'
            })
          )}`
        ].join('\n'),
        normalizedTranscript: 'checkpoint',
        transcriptCheckpoint: {
          rawOffset: 'checkpoint\n'.length,
          normalizedOffset: 'checkpoint'.length
        },
        artifacts: { rawTranscriptPath: '/tmp/raw.txt' }
      })
    ).toThrow(/rendered transcript: unexpected fresh rendered Channel/);

    expect(() =>
      assertTeamemNoChannelEvidenceForMarker({
        persona: 'carol',
        expected,
        rawTranscript: 'checkpoint',
        normalizedTranscript: [
          'checkpoint',
          `←tamem-chanel:${JSON.stringify(
            markerChannelEnvelope({
              expected,
              eventType: 'permission_requested'
            })
          )}`
        ].join('\n'),
        transcriptCheckpoint: {
          rawOffset: 'checkpoint'.length,
          normalizedOffset: 'checkpoint\n'.length
        },
        artifacts: { normalizedTranscriptPath: '/tmp/normalized.txt' }
      })
    ).toThrow(/rendered transcript: unexpected fresh rendered Channel/);
  });

  it('classifies non-discussion marker evidence before checkpoints as stale', () => {
    const expected = negativeMarkerExpectation({
      runId: 'run-1',
      caseName: 'claim-conflict',
      marker: markerFor('run-1', 'claim-conflict', 'stale'),
      eventTypes: ['scope_claimed', 'conflict_queued']
    });
    const staleRender = `teamem-channel:${JSON.stringify(
      markerChannelEnvelope({ expected, eventType: 'conflict_queued' })
    )}`;

    expect(() =>
      assertTeamemNoChannelEvidenceForMarker({
        persona: 'alice',
        expected,
        traces: [
          fakeTrace([
            fakeMarkerChannelMessage({
              expected,
              eventType: 'scope_claimed',
              offsetMs: 5
            })
          ])
        ],
        traceCheckpoint: { offsetMs: 10 }
      })
    ).toThrow(/stale evidence: Channel MCP trace/);

    expect(() =>
      assertTeamemNoChannelEvidenceForMarker({
        persona: 'bob',
        expected,
        notificationLog: `${JSON.stringify(
          markerChannelEnvelope({ expected, eventType: 'conflict_queued' })
        )}\n`,
        notificationCheckpoint: { lineOffset: 1 }
      })
    ).toThrow(/stale evidence: notification-log envelope/);

    expect(() =>
      assertTeamemNoChannelEvidenceForMarker({
        persona: 'carol',
        expected,
        rawTranscript: staleRender,
        normalizedTranscript: '',
        transcriptCheckpoint: {
          rawOffset: staleRender.length,
          normalizedOffset: 0
        }
      })
    ).toThrow(/stale evidence: rendered transcript/);
  });

  it('allows one prompt echo for conflict markers but rejects a second rendered occurrence', () => {
    const expected = negativeMarkerExpectation({
      runId: 'run-1',
      caseName: 'claim-conflict',
      marker: markerFor('run-1', 'claim-conflict', 'echo'),
      eventTypes: ['conflict_queued']
    });
    const checkpoint = 'ready\n';
    const prompt = `Attempt to edit src/features/${expected.marker}.ts`;

    expect(() =>
      assertTeamemNoChannelEvidenceForMarker({
        persona: 'bob',
        expected,
        rawTranscript: `${checkpoint}${prompt}`,
        normalizedTranscript: `${checkpoint}${prompt}`,
        transcriptCheckpoint: {
          rawOffset: checkpoint.length,
          normalizedOffset: checkpoint.length
        },
        allowedTranscriptMarkerEchoes: [prompt]
      })
    ).not.toThrow();

    const renderedChannel = `teamem-channel:${JSON.stringify(
      markerChannelEnvelope({ expected, eventType: 'conflict_queued' })
    )}`;
    expect(() =>
      assertTeamemNoChannelEvidenceForMarker({
        persona: 'bob',
        expected,
        rawTranscript: `${checkpoint}${prompt}\n${renderedChannel}`,
        normalizedTranscript: `${checkpoint}${prompt}\n${renderedChannel}`,
        transcriptCheckpoint: {
          rawOffset: checkpoint.length,
          normalizedOffset: checkpoint.length
        },
        allowedTranscriptMarkerEchoes: [prompt]
      })
    ).toThrow(/rendered transcript/);
  });

  it('asserts full recipient receipt from fake artifacts', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'teamem-evidence-full-'));
    const expected = expectation({
      caseName: 'star',
      marker: markerFor('run-1', 'star', 'full'),
      recipientPrincipal: 'bob',
      deliveryScope: 'space'
    });
    const tracePath = join(tempRoot, 'trace.json');
    const logPath = join(tempRoot, 'notifications.log');
    const rawPath = join(tempRoot, 'raw.txt');
    const normalizedPath = join(tempRoot, 'normalized.txt');
    await writeFile(
      tracePath,
      JSON.stringify(
        fakeTrace([fakeChannelMessage({ expected, offsetMs: 25 })])
      )
    );
    await writeFile(logPath, `${JSON.stringify(channelEnvelope(expected))}\n`);
    await writeFile(rawPath, `before\nrendered ${expected.marker}`);
    await writeFile(normalizedPath, 'before');

    try {
      const evidence = await assertTeamemRecipientReceipt({
        persona: 'bob',
        expected,
        tracePath,
        notificationLogPath: logPath,
        rawTranscriptPath: rawPath,
        normalizedTranscriptPath: normalizedPath,
        traceCheckpoint: { offsetMs: 10 },
        notificationCheckpoint: { lineOffset: 0 },
        transcriptCheckpoint: {
          rawOffset: 'before\n'.length,
          normalizedOffset: 'before'.length
        }
      });

      expect(evidence.transport.message.offsetMs).toBe(25);
      expect(evidence.notificationLog.lineIndex).toBe(0);
      expect(evidence.renderedTranscript.source).toBe('raw');
      expect(evidence.renderedTranscript.renderKind).toBe('marker');

      await expect(
        assertTeamemRecipientReceipt({
          persona: 'carol',
          expected,
          tracePath,
          notificationLogPath: logPath,
          rawTranscriptPath: rawPath,
          normalizedTranscriptPath: normalizedPath,
          transcriptCheckpoint: {
            rawOffset: 'before\n'.length,
            normalizedOffset: 'before'.length
          }
        })
      ).rejects.toMatchObject({ layer: 'launch/readiness' });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('encodes the no-Sprint direct, star, and starstar delivery matrix', () => {
    expect(expectedTeamemChannelsDeliveryMatrix('direct')).toEqual({
      alice: false,
      bob: true,
      carol: false
    });
    expect(expectedTeamemChannelsDeliveryMatrix('star')).toEqual({
      alice: false,
      bob: true,
      carol: true
    });
    expect(expectedTeamemChannelsDeliveryMatrix('starstar')).toEqual({
      alice: false,
      bob: true,
      carol: true
    });
  });

  it('encodes the Sprint direct, star, and starstar delivery matrix', () => {
    expect(expectedTeamemSprintChannelsDeliveryMatrix('direct')).toEqual({
      alice: false,
      bob: false,
      carol: true
    });
    expect(expectedTeamemSprintChannelsDeliveryMatrix('star')).toEqual({
      alice: false,
      bob: true,
      carol: false
    });
    expect(expectedTeamemSprintChannelsDeliveryMatrix('starstar')).toEqual({
      alice: false,
      bob: true,
      carol: true
    });
  });
});

function expectation(
  overrides: Partial<TeamemChannelsEvidenceExpectation>
): TeamemChannelsEvidenceExpectation {
  const runId = overrides.runId ?? 'run-1';
  const caseName = overrides.caseName ?? 'direct';
  const recipientPrincipal = overrides.recipientPrincipal ?? 'bob';
  return {
    runId,
    caseName,
    marker: overrides.marker ?? markerFor(runId, caseName),
    eventId: overrides.eventId ?? `evt-${caseName}-${recipientPrincipal}`,
    threadId: overrides.threadId ?? `thr-${caseName}`,
    messageId: overrides.messageId ?? `msg-${caseName}-${recipientPrincipal}`,
    senderPrincipal: overrides.senderPrincipal ?? 'alice',
    recipientPrincipal,
    deliveryScope: overrides.deliveryScope ?? 'direct'
  };
}

function decisionExpectation(input: {
  readonly runId: string;
  readonly marker: string;
  readonly recipientPrincipal: string;
  readonly title: string;
  readonly body: string;
}): TeamemChannelsEvidenceExpectation & {
  readonly title: string;
  readonly body: string;
} {
  return {
    runId: input.runId,
    caseName: 'decision-live',
    marker: input.marker,
    eventType: 'decision_published',
    eventId: 'evt-decision-live',
    senderPrincipal: 'alice',
    recipientPrincipal: input.recipientPrincipal,
    requiredPayloadText: [
      input.marker,
      input.title,
      input.body,
      'dec-marker-run-1-decision-live-body',
      '"version":1'
    ],
    requiredRenderedText: [
      input.marker,
      input.title,
      input.body,
      'dec-marker-run-1-decision-live-body',
      'decision_published',
      'alice'
    ],
    title: input.title,
    body: input.body
  };
}

function gotchaExpectation(input: {
  readonly runId: string;
  readonly summaryMarker: string;
  readonly bodyMarker: string;
  readonly recipientPrincipal: string;
}): TeamemChannelsEvidenceExpectation & {
  readonly summary: string;
  readonly bodyMarker: string;
  readonly includeBodyLeak?: boolean;
} {
  const findingId = 'finding-marker-run-1-gotcha-live-summary';
  const summary = `Gotcha summary ${input.summaryMarker}`;
  return {
    runId: input.runId,
    caseName: 'gotcha-live',
    marker: input.summaryMarker,
    eventType: 'finding_shared',
    eventId: 'evt-gotcha-live',
    senderPrincipal: 'alice',
    recipientPrincipal: input.recipientPrincipal,
    requiredPayloadText: [
      input.summaryMarker,
      summary,
      findingId,
      'gotcha',
      'warning',
      'teamem-smoke',
      'gotcha-live',
      '"version":1',
      'alice'
    ],
    requiredRenderedText: [
      input.summaryMarker,
      summary,
      findingId,
      'finding_shared',
      'gotcha',
      'warning',
      'alice'
    ],
    forbiddenPayloadText: [input.bodyMarker],
    forbiddenRenderedText: [input.bodyMarker],
    summary,
    bodyMarker: input.bodyMarker
  };
}

function negativeMarkerExpectation(input: {
  readonly runId: string;
  readonly caseName: string;
  readonly marker: string;
  readonly eventTypes: readonly string[];
}) {
  return input;
}

function expectEvidenceLayer(
  action: () => void,
  layer: TeamemChannelsEvidenceError['layer']
): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(TeamemChannelsEvidenceError);
    expect((error as TeamemChannelsEvidenceError).layer).toBe(layer);
    expect((error as Error).message).toStartWith(`${layer}:`);
    return;
  }
  throw new Error(`Expected ${layer} evidence error`);
}

function markerFor(runId: string, caseName: string, suffix?: string): string {
  return ['marker', runId, caseName, suffix].filter(Boolean).join('-');
}

function fakeTrace(messages: McpTraceMessage[]): McpTrace {
  return {
    serverName: 'teamem-channel',
    command: 'bun',
    args: ['run', 'src/channel/index.ts'],
    startedAt: '2026-06-04T00:00:00.000Z',
    endedAt: '2026-06-04T00:00:01.000Z',
    durationMs: 1000,
    exitCode: null,
    signal: null,
    partial: false,
    terminationReason: 'test',
    stdin: '',
    stdout: '',
    stderr: '',
    messages,
    artifacts: artifacts('/tmp/teamem-channel-trace.json'),
    placeholderExpansion: {
      supportedPattern: '${VAR}',
      unsupportedShellExpansion: true
    }
  };
}

function fakeChannelMessage(input: {
  readonly expected: TeamemChannelsEvidenceExpectation;
  readonly offsetMs: number;
}): McpTraceMessage {
  const json = createClaudeChannelNotification({
    event_id: input.expected.eventId,
    event_type: 'discussion_posted',
    principal: input.expected.senderPrincipal,
    delivery_scope: input.expected.deliveryScope,
    recipient_principals: [input.expected.recipientPrincipal],
    payload: {
      thread_id: input.expected.threadId,
      message_id: input.expected.messageId,
      recipient_principal:
        input.expected.deliveryScope === 'direct'
          ? input.expected.recipientPrincipal
          : null,
      body: `body ${input.expected.marker}`
    }
  });
  return {
    serverName: 'teamem-channel',
    direction: 'server-to-client',
    raw: JSON.stringify(json),
    json,
    method: 'notifications/claude/channel',
    metadata: {
      notification: { method: 'notifications/claude/channel' }
    },
    timestamp: new Date(input.offsetMs).toISOString(),
    offsetMs: input.offsetMs,
    artifacts: artifacts('/tmp/teamem-channel-trace.json')
  };
}

function fakeDecisionChannelMessage(input: {
  readonly expected: ReturnType<typeof decisionExpectation>;
  readonly offsetMs: number;
}): McpTraceMessage {
  const json = createClaudeChannelNotification({
    event_id: input.expected.eventId,
    event_type: 'decision_published',
    principal: input.expected.senderPrincipal,
    payload: decisionPayload(input.expected)
  });
  return {
    serverName: 'teamem-channel',
    direction: 'server-to-client',
    raw: JSON.stringify(json),
    json,
    method: 'notifications/claude/channel',
    metadata: {
      notification: { method: 'notifications/claude/channel' }
    },
    timestamp: new Date(input.offsetMs).toISOString(),
    offsetMs: input.offsetMs,
    artifacts: artifacts('/tmp/teamem-channel-decision-trace.json')
  };
}

function fakeGotchaChannelMessage(input: {
  readonly expected: ReturnType<typeof gotchaExpectation>;
  readonly offsetMs: number;
}): McpTraceMessage {
  const json = createClaudeChannelNotification({
    event_id: input.expected.eventId,
    event_type: 'finding_shared',
    principal: input.expected.senderPrincipal,
    delivery_scope: 'space',
    payload: gotchaPayload(input.expected)
  });
  if (input.expected.includeBodyLeak) {
    json.params.content = JSON.stringify(gotchaChannelEnvelope(input.expected));
  }
  return {
    serverName: 'teamem-channel',
    direction: 'server-to-client',
    raw: JSON.stringify(json),
    json,
    method: 'notifications/claude/channel',
    metadata: {
      notification: { method: 'notifications/claude/channel' }
    },
    timestamp: new Date(input.offsetMs).toISOString(),
    offsetMs: input.offsetMs,
    artifacts: artifacts('/tmp/teamem-channel-gotcha-trace.json')
  };
}

function fakeMarkerChannelMessage(input: {
  readonly expected: ReturnType<typeof negativeMarkerExpectation>;
  readonly eventType: string;
  readonly offsetMs: number;
}): McpTraceMessage {
  const json = createClaudeChannelNotification({
    event_id: `evt-${input.eventType}`,
    event_type: input.eventType,
    principal: 'alice',
    delivery_scope: 'space',
    recipient_principals: [],
    scope: { paths: [`src/features/${input.expected.marker}.ts`] },
    payload: {
      intent: `intent ${input.expected.marker}`,
      blocking_claim_id: `claim-${input.expected.marker}`
    }
  });
  return {
    serverName: 'teamem-channel',
    direction: 'server-to-client',
    raw: JSON.stringify(json),
    json,
    method: 'notifications/claude/channel',
    metadata: {
      notification: { method: 'notifications/claude/channel' }
    },
    timestamp: new Date(input.offsetMs).toISOString(),
    offsetMs: input.offsetMs,
    artifacts: artifacts('/tmp/teamem-channel-trace.json')
  };
}

function channelEnvelope(
  expected: TeamemChannelsEvidenceExpectation
): TeamemChannelEnvelope {
  return JSON.parse(
    createClaudeChannelNotification({
      event_id: expected.eventId,
      event_type: 'discussion_posted',
      principal: expected.senderPrincipal,
      delivery_scope: expected.deliveryScope,
      recipient_principals: [expected.recipientPrincipal],
      payload: {
        thread_id: expected.threadId,
        message_id: expected.messageId,
        recipient_principal:
          expected.deliveryScope === 'direct'
            ? expected.recipientPrincipal
            : null,
        body: `body ${expected.marker}`
      }
    }).params.content
  ) as TeamemChannelEnvelope;
}

function markerChannelEnvelope(input: {
  readonly expected: ReturnType<typeof negativeMarkerExpectation>;
  readonly eventType: string;
}): TeamemChannelEnvelope {
  return JSON.parse(
    createClaudeChannelNotification({
      event_id: `evt-${input.eventType}`,
      event_type: input.eventType,
      principal: 'alice',
      delivery_scope: 'space',
      recipient_principals: [],
      scope: { paths: [`src/features/${input.expected.marker}.ts`] },
      payload: {
        intent: `intent ${input.expected.marker}`,
        blocking_claim_id: `claim-${input.expected.marker}`
      }
    }).params.content
  ) as TeamemChannelEnvelope;
}

function decisionChannelEnvelope(
  expected: ReturnType<typeof decisionExpectation>
): TeamemChannelEnvelope {
  return JSON.parse(
    createClaudeChannelNotification({
      event_id: expected.eventId,
      event_type: 'decision_published',
      principal: expected.senderPrincipal,
      payload: decisionPayload(expected)
    }).params.content
  ) as TeamemChannelEnvelope;
}

function gotchaChannelEnvelope(
  expected: ReturnType<typeof gotchaExpectation>
): TeamemChannelEnvelope {
  const envelope = JSON.parse(
    createClaudeChannelNotification({
      event_id: expected.eventId,
      event_type: 'finding_shared',
      principal: expected.senderPrincipal,
      delivery_scope: 'space',
      payload: gotchaPayload(expected)
    }).params.content
  ) as TeamemChannelEnvelope;
  if (expected.includeBodyLeak) {
    envelope.payload = {
      ...(envelope.payload ?? {}),
      body: `Full gotcha body ${expected.bodyMarker}`
    };
  }
  return envelope;
}

function decisionPayload(expected: ReturnType<typeof decisionExpectation>) {
  return {
    decision_id: 'dec-marker-run-1-decision-live-body',
    title: expected.title,
    body: expected.body,
    summary: expected.body,
    kind: 'process',
    status: 'open',
    version: 1
  };
}

function gotchaPayload(expected: ReturnType<typeof gotchaExpectation>) {
  return {
    finding_id: 'finding-marker-run-1-gotcha-live-summary',
    kind: 'gotcha',
    lifecycle: 'persistent',
    status: 'open',
    version: 1,
    summary: expected.summary,
    ...(expected.includeBodyLeak
      ? { body: `Full gotcha body ${expected.bodyMarker}` }
      : {}),
    paths: ['src/gotcha-live.ts'],
    tags: ['teamem-smoke', 'gotcha-live'],
    recipient_principals: [],
    severity: 'warning',
    refs: { paths: ['src/gotcha-live.ts'] },
    expires_at: null
  };
}

function artifacts(tracePath: string) {
  return {
    tracePath,
    stdinPath: `${tracePath}.stdin`,
    stdoutPath: `${tracePath}.stdout`,
    stderrPath: `${tracePath}.stderr`
  };
}
