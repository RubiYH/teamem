import { readFile } from 'node:fs/promises';

import type {
  McpTrace,
  McpTraceMessage
} from '../../plugin-e2e-module/src/index.js';
import type { TeamemChannelEnvelope } from '../../src/channel/payload.js';
import type {
  TeamemChannelsPersona,
  TeamemChannelsSplitCase
} from './teamem-channels-session-planner.js';

export type TeamemChannelsEvidenceLayer =
  | 'launch/readiness'
  | 'command/MCP post'
  | 'channel transport'
  | 'stale evidence'
  | 'notification log'
  | 'rendered transcript'
  | 'body-leakage'
  | 'negative-recipient filtering'
  | 'sender-echo';

export type TeamemChannelsDeliveryScope = 'direct' | 'space' | 'sprint';

export type TeamemChannelsArtifactPaths = {
  readonly channelTracePath?: string;
  readonly notificationLogPath?: string;
  readonly rawTranscriptPath?: string;
  readonly normalizedTranscriptPath?: string;
};

export type TeamemChannelsEvidenceExpectation = {
  readonly runId: string;
  readonly caseName: TeamemChannelsSplitCase | string;
  readonly marker: string;
  readonly eventType?: string;
  readonly eventId: string;
  readonly threadId?: string;
  readonly messageId?: string;
  readonly senderPrincipal: string;
  readonly recipientPrincipal: string;
  readonly deliveryScope?: TeamemChannelsDeliveryScope;
  readonly requiredPayloadText?: readonly string[];
  readonly requiredRenderedText?: readonly string[];
  readonly forbiddenPayloadText?: readonly string[];
  readonly forbiddenRenderedText?: readonly string[];
};

export type TeamemChannelsTraceCheckpoint = {
  readonly offsetMs?: number;
  readonly timestamp?: string;
};

export type TeamemChannelsNotificationCheckpoint = {
  readonly lineOffset?: number;
  readonly timestamp?: string;
};

export type TeamemChannelsTranscriptCheckpoint = {
  readonly rawOffset: number;
  readonly normalizedOffset: number;
  readonly capturedAt?: string;
  readonly traceOffsetMs?: number;
  readonly notificationLineOffset?: number;
};

export type TeamemChannelsEvidenceContext = {
  readonly runId?: string;
  readonly caseName?: string;
  readonly persona?: TeamemChannelsPersona | string;
  readonly marker?: string;
  readonly artifacts?: TeamemChannelsArtifactPaths;
  readonly checkpoint?: Partial<
    TeamemChannelsTraceCheckpoint &
      TeamemChannelsNotificationCheckpoint &
      TeamemChannelsTranscriptCheckpoint
  >;
};

export class TeamemChannelsEvidenceError extends Error {
  readonly layer: TeamemChannelsEvidenceLayer;
  readonly context: TeamemChannelsEvidenceContext;

  constructor(
    layer: TeamemChannelsEvidenceLayer,
    message: string,
    context: TeamemChannelsEvidenceContext = {}
  ) {
    super(`${layer}: ${message}${formatEvidenceContext(context)}`);
    this.name = 'TeamemChannelsEvidenceError';
    this.layer = layer;
    this.context = context;
  }
}

export type TeamemChannelsTransportEvidence = {
  readonly trace: McpTrace;
  readonly message: McpTraceMessage;
  readonly envelope: TeamemChannelEnvelope;
};

export type TeamemChannelsNotificationLogEvidence = {
  readonly lineIndex: number;
  readonly envelope: TeamemChannelEnvelope;
};

export type TeamemChannelsRenderedTranscriptEvidence = {
  readonly source: 'raw' | 'normalized';
  readonly renderKind: 'marker' | 'channel-source';
  readonly renderedIndex: number;
  readonly markerIndex: number;
  readonly checkpoint: TeamemChannelsTranscriptCheckpoint;
};

export type TeamemChannelsRecipientReceiptEvidence = {
  readonly transport: TeamemChannelsTransportEvidence;
  readonly notificationLog: TeamemChannelsNotificationLogEvidence;
  readonly renderedTranscript: TeamemChannelsRenderedTranscriptEvidence;
};

export type TeamemChannelsNegativeMarkerExpectation = {
  readonly runId: string;
  readonly caseName: TeamemChannelsSplitCase | string;
  readonly marker: string;
  readonly eventTypes: readonly string[];
};

type TeamemChannelsTransportCandidate =
  | ({ readonly kind: 'match' } & TeamemChannelsTransportEvidence)
  | { readonly kind: 'stale'; readonly reason: string };

type TeamemChannelsNoRecipientEvidenceInput = {
  readonly persona: TeamemChannelsPersona;
  readonly expected: TeamemChannelsEvidenceExpectation;
  readonly traces?: readonly McpTrace[];
  readonly notificationLog?: string;
  readonly rawTranscript?: string;
  readonly normalizedTranscript?: string;
  readonly traceCheckpoint?: TeamemChannelsTraceCheckpoint;
  readonly notificationCheckpoint?: TeamemChannelsNotificationCheckpoint;
  readonly transcriptCheckpoint?: TeamemChannelsTranscriptCheckpoint;
  readonly allowedTranscriptMarkerEchoes?: readonly string[];
  readonly artifacts?: TeamemChannelsArtifactPaths;
};

export function createTeamemChannelsTranscriptCheckpoint(input: {
  readonly rawTranscript: string;
  readonly normalizedTranscript?: string;
  readonly capturedAt?: string;
  readonly traceOffsetMs?: number;
  readonly notificationLineOffset?: number;
}): TeamemChannelsTranscriptCheckpoint {
  return {
    rawOffset: input.rawTranscript.length,
    normalizedOffset: input.normalizedTranscript?.length ?? 0,
    capturedAt: input.capturedAt,
    traceOffsetMs: input.traceOffsetMs,
    notificationLineOffset: input.notificationLineOffset
  };
}

export async function assertTeamemChannelTransportEvidence(input: {
  readonly tracePath: string;
  readonly expected: TeamemChannelsEvidenceExpectation;
  readonly checkpoint?: TeamemChannelsTraceCheckpoint;
}): Promise<TeamemChannelsTransportEvidence> {
  const traces = await readTeamemChannelTraceArtifact({
    tracePath: input.tracePath,
    expected: input.expected,
    checkpoint: input.checkpoint
  });
  return findTeamemChannelTransportEvidence({
    traces,
    expected: input.expected,
    checkpoint: input.checkpoint,
    artifacts: { channelTracePath: input.tracePath }
  });
}

export function findTeamemChannelTransportEvidence(input: {
  readonly traces: readonly McpTrace[];
  readonly expected: TeamemChannelsEvidenceExpectation;
  readonly checkpoint?: TeamemChannelsTraceCheckpoint;
  readonly artifacts?: TeamemChannelsArtifactPaths;
}): TeamemChannelsTransportEvidence {
  assertExpectedMarkerIdentity(input.expected, 'channel transport', {
    artifacts: input.artifacts,
    checkpoint: input.checkpoint
  });

  const candidates = input.traces.flatMap<TeamemChannelsTransportCandidate>(
    (trace) =>
      trace.messages.flatMap<TeamemChannelsTransportCandidate>((message) => {
        const notification = parseChannelNotification(message.json);
        const envelope = notification
          ? parseChannelEnvelope(notification.params.content)
          : undefined;
        if (
          !notification ||
          !envelope ||
          !matchesExpectedChannelRouting({
            notification,
            envelope,
            expected: input.expected
          })
        ) {
          return [];
        }

        const staleReason = traceStaleReason({
          message,
          envelope,
          expected: input.expected,
          checkpoint: input.checkpoint
        });
        if (staleReason) {
          return [{ kind: 'stale' as const, reason: staleReason }];
        }

        assertNoForbiddenPayloadText(envelope, input.expected, {
          layer: 'channel transport',
          artifacts: input.artifacts,
          checkpoint: input.checkpoint
        });

        if (!matchesExpectedEnvelope(envelope, input.expected)) {
          return [
            {
              kind: 'stale' as const,
              reason:
                'channel trace matched ids/principals but marker run/case identity did not match'
            }
          ];
        }

        return [{ kind: 'match' as const, trace, message, envelope }];
      })
  );
  const match = candidates.find(
    (
      candidate
    ): candidate is TeamemChannelsTransportEvidence & {
      readonly kind: 'match';
    } => candidate.kind === 'match'
  );

  if (match) return match;

  const stale = candidates.find(
    (
      candidate
    ): candidate is { readonly kind: 'stale'; readonly reason: string } =>
      candidate.kind === 'stale'
  );
  if (stale) {
    throw new TeamemChannelsEvidenceError(
      'stale evidence',
      stale.reason,
      contextForExpectation(input.expected, {
        artifacts: input.artifacts,
        checkpoint: input.checkpoint
      })
    );
  }

  throw new TeamemChannelsEvidenceError(
    'channel transport',
    `expected notifications/claude/channel trace for recipient ${input.expected.recipientPrincipal}`,
    contextForExpectation(input.expected, {
      artifacts: input.artifacts,
      checkpoint: input.checkpoint
    })
  );
}

export async function assertTeamemNotificationLogEvidence(input: {
  readonly notificationLogPath: string;
  readonly expected: TeamemChannelsEvidenceExpectation;
  readonly checkpoint?: TeamemChannelsNotificationCheckpoint;
}): Promise<TeamemChannelsNotificationLogEvidence> {
  let raw: string;
  try {
    raw = await readFile(input.notificationLogPath, 'utf8');
  } catch (error) {
    throw new TeamemChannelsEvidenceError(
      'notification log',
      `failed to read recipient notification log: ${formatUnknown(error)}`,
      contextForExpectation(input.expected, {
        artifacts: { notificationLogPath: input.notificationLogPath },
        checkpoint: input.checkpoint
      })
    );
  }

  return findTeamemNotificationLogEvidence({
    log: raw,
    expected: input.expected,
    checkpoint: input.checkpoint,
    artifacts: { notificationLogPath: input.notificationLogPath }
  });
}

export function findTeamemNotificationLogEvidence(input: {
  readonly log: string;
  readonly expected: TeamemChannelsEvidenceExpectation;
  readonly checkpoint?: TeamemChannelsNotificationCheckpoint;
  readonly artifacts?: TeamemChannelsArtifactPaths;
}): TeamemChannelsNotificationLogEvidence {
  assertExpectedMarkerIdentity(input.expected, 'notification log', {
    artifacts: input.artifacts,
    checkpoint: input.checkpoint
  });

  const minLine = input.checkpoint?.lineOffset ?? 0;
  const lines = input.log.split(/\r?\n/);
  let staleReason: string | undefined;
  for (let index = minLine; index < lines.length; index += 1) {
    const line = lines[index]?.trim();
    if (!line) continue;
    const envelope = parseNotificationLogEnvelope(line);
    if (envelope && matchesExpectedEnvelopeIdentity(envelope, input.expected)) {
      assertNoForbiddenPayloadText(envelope, input.expected, {
        layer: 'notification log',
        artifacts: input.artifacts,
        checkpoint: input.checkpoint
      });
    }
    if (envelope && matchesExpectedEnvelope(envelope, input.expected)) {
      return { lineIndex: index, envelope };
    }
    if (envelope && matchesExpectedEnvelopeIdentity(envelope, input.expected)) {
      staleReason =
        'notification log matched ids/principals but marker run/case identity did not match';
    }
  }

  for (let index = 0; index < minLine; index += 1) {
    const line = lines[index]?.trim();
    if (!line) continue;
    const envelope = parseNotificationLogEnvelope(line);
    if (envelope && matchesExpectedEnvelope(envelope, input.expected)) {
      staleReason = `notification log evidence line ${index} was before checkpoint line ${minLine}`;
      break;
    }
    if (envelope && matchesExpectedEnvelopeIdentity(envelope, input.expected)) {
      staleReason =
        'notification log matched ids/principals but marker run/case identity did not match';
    }
  }

  if (staleReason) {
    throw new TeamemChannelsEvidenceError(
      'stale evidence',
      staleReason,
      contextForExpectation(input.expected, {
        artifacts: input.artifacts,
        checkpoint: input.checkpoint
      })
    );
  }

  throw new TeamemChannelsEvidenceError(
    'notification log',
    `expected recipient notification log envelope for ${input.expected.recipientPrincipal}`,
    contextForExpectation(input.expected, {
      artifacts: input.artifacts,
      checkpoint: input.checkpoint
    })
  );
}

export async function assertTeamemRenderedTranscriptEvidence(input: {
  readonly rawTranscriptPath: string;
  readonly normalizedTranscriptPath: string;
  readonly expected: TeamemChannelsEvidenceExpectation;
  readonly checkpoint: TeamemChannelsTranscriptCheckpoint;
  readonly notificationEvidence: TeamemChannelsNotificationLogEvidence;
  readonly artifacts?: TeamemChannelsArtifactPaths;
}): Promise<TeamemChannelsRenderedTranscriptEvidence> {
  let rawTranscript = '';
  let normalizedTranscript = '';
  try {
    rawTranscript = await readFile(input.rawTranscriptPath, 'utf8');
    normalizedTranscript = await readFile(
      input.normalizedTranscriptPath,
      'utf8'
    );
  } catch (error) {
    throw new TeamemChannelsEvidenceError(
      'rendered transcript',
      `failed to read transcript artifact: ${formatUnknown(error)}`,
      contextForExpectation(input.expected, {
        artifacts: renderArtifacts(input),
        checkpoint: input.checkpoint
      })
    );
  }

  return findTeamemRenderedTranscriptEvidence({
    rawTranscript,
    normalizedTranscript,
    expected: input.expected,
    checkpoint: input.checkpoint,
    notificationEvidence: input.notificationEvidence,
    artifacts: renderArtifacts(input)
  });
}

export function findTeamemRenderedTranscriptEvidence(input: {
  readonly rawTranscript: string;
  readonly normalizedTranscript: string;
  readonly expected: TeamemChannelsEvidenceExpectation;
  readonly checkpoint: TeamemChannelsTranscriptCheckpoint;
  readonly notificationEvidence: TeamemChannelsNotificationLogEvidence;
  readonly artifacts?: TeamemChannelsArtifactPaths;
}): TeamemChannelsRenderedTranscriptEvidence {
  assertExpectedMarkerIdentity(input.expected, 'rendered transcript', {
    artifacts: input.artifacts,
    checkpoint: input.checkpoint
  });
  assertRenderedTranscriptNotificationEvidence(input);

  const rawSegment = input.rawTranscript.slice(input.checkpoint.rawOffset);
  assertNoForbiddenRenderedText(rawSegment, input.expected, {
    artifacts: input.artifacts,
    checkpoint: input.checkpoint
  });
  const rawIndex = rawSegment.indexOf(input.expected.marker);
  if (
    rawIndex >= 0 &&
    segmentIncludesRenderedText(rawSegment, input.expected)
  ) {
    return {
      source: 'raw',
      renderKind: 'marker',
      renderedIndex: input.checkpoint.rawOffset + rawIndex,
      markerIndex: input.checkpoint.rawOffset + rawIndex,
      checkpoint: input.checkpoint
    };
  }

  const normalizedSegment = input.normalizedTranscript.slice(
    input.checkpoint.normalizedOffset
  );
  assertNoForbiddenRenderedText(normalizedSegment, input.expected, {
    artifacts: input.artifacts,
    checkpoint: input.checkpoint
  });
  const normalizedIndex = normalizedSegment.indexOf(input.expected.marker);
  if (
    normalizedIndex >= 0 &&
    segmentIncludesRenderedText(normalizedSegment, input.expected)
  ) {
    return {
      source: 'normalized',
      renderKind: 'marker',
      renderedIndex: input.checkpoint.normalizedOffset + normalizedIndex,
      markerIndex: input.checkpoint.normalizedOffset + normalizedIndex,
      checkpoint: input.checkpoint
    };
  }

  const rawChannelSourceIndex = findRenderedChannelSourceIndex(
    rawSegment,
    input.expected
  );
  if (rawChannelSourceIndex >= 0) {
    return {
      source: 'raw',
      renderKind: 'channel-source',
      renderedIndex: input.checkpoint.rawOffset + rawChannelSourceIndex,
      markerIndex: input.checkpoint.rawOffset + rawChannelSourceIndex,
      checkpoint: input.checkpoint
    };
  }

  const normalizedChannelSourceIndex = findRenderedChannelSourceIndex(
    normalizedSegment,
    input.expected
  );
  if (normalizedChannelSourceIndex >= 0) {
    return {
      source: 'normalized',
      renderKind: 'channel-source',
      renderedIndex:
        input.checkpoint.normalizedOffset + normalizedChannelSourceIndex,
      markerIndex:
        input.checkpoint.normalizedOffset + normalizedChannelSourceIndex,
      checkpoint: input.checkpoint
    };
  }

  const rawStaleIndex = input.rawTranscript
    .slice(0, input.checkpoint.rawOffset)
    .indexOf(input.expected.marker);
  const normalizedStaleIndex = input.normalizedTranscript
    .slice(0, input.checkpoint.normalizedOffset)
    .indexOf(input.expected.marker);
  if (rawStaleIndex >= 0 || normalizedStaleIndex >= 0) {
    throw new TeamemChannelsEvidenceError(
      'stale evidence',
      `rendered transcript marker existed only before checkpoint for ${input.expected.recipientPrincipal}`,
      contextForExpectation(input.expected, {
        artifacts: input.artifacts,
        checkpoint: input.checkpoint
      })
    );
  }

  const rawStaleForbiddenIndex = findForbiddenTextIndex(
    input.rawTranscript.slice(0, input.checkpoint.rawOffset),
    input.expected.forbiddenRenderedText
  );
  const normalizedStaleForbiddenIndex = findForbiddenTextIndex(
    input.normalizedTranscript.slice(0, input.checkpoint.normalizedOffset),
    input.expected.forbiddenRenderedText
  );
  if (rawStaleForbiddenIndex >= 0 || normalizedStaleForbiddenIndex >= 0) {
    throw new TeamemChannelsEvidenceError(
      'stale evidence',
      `rendered transcript body marker existed only before checkpoint for ${input.expected.recipientPrincipal}`,
      contextForExpectation(input.expected, {
        artifacts: input.artifacts,
        checkpoint: input.checkpoint
      })
    );
  }

  const rawStaleChannelSourceIndex = findRenderedChannelSourceIndex(
    input.rawTranscript.slice(0, input.checkpoint.rawOffset),
    input.expected
  );
  const normalizedStaleChannelSourceIndex = findRenderedChannelSourceIndex(
    input.normalizedTranscript.slice(0, input.checkpoint.normalizedOffset),
    input.expected
  );
  if (
    rawStaleChannelSourceIndex >= 0 ||
    normalizedStaleChannelSourceIndex >= 0
  ) {
    throw new TeamemChannelsEvidenceError(
      'stale evidence',
      `rendered channel source existed only before checkpoint for ${input.expected.recipientPrincipal}`,
      contextForExpectation(input.expected, {
        artifacts: input.artifacts,
        checkpoint: input.checkpoint
      })
    );
  }

  throw new TeamemChannelsEvidenceError(
    'rendered transcript',
    `expected rendered channel source for ${input.expected.recipientPrincipal}`,
    contextForExpectation(input.expected, {
      artifacts: input.artifacts,
      checkpoint: input.checkpoint
    })
  );
}

function segmentIncludesRenderedText(
  segment: string,
  expected: TeamemChannelsEvidenceExpectation
): boolean {
  return (expected.requiredRenderedText ?? []).every((text) =>
    segment.includes(text)
  );
}

function assertNoForbiddenPayloadText(
  envelope: TeamemChannelEnvelope,
  expected: TeamemChannelsEvidenceExpectation,
  context: {
    readonly layer: 'channel transport' | 'notification log';
    readonly artifacts?: TeamemChannelsArtifactPaths;
    readonly checkpoint?: Partial<
      TeamemChannelsTraceCheckpoint & TeamemChannelsNotificationCheckpoint
    >;
  }
): void {
  const forbidden = findForbiddenText(
    envelopeTextHaystack(envelope),
    expected.forbiddenPayloadText
  );
  if (!forbidden) return;
  throw new TeamemChannelsEvidenceError(
    'body-leakage',
    `${context.layer} included forbidden compact-notice body text "${forbidden}" for ${expected.recipientPrincipal}`,
    contextForExpectation(expected, {
      artifacts: context.artifacts,
      checkpoint: context.checkpoint
    })
  );
}

function assertNoForbiddenRenderedText(
  segment: string,
  expected: TeamemChannelsEvidenceExpectation,
  context: {
    readonly artifacts?: TeamemChannelsArtifactPaths;
    readonly checkpoint?: TeamemChannelsTranscriptCheckpoint;
  }
): void {
  const forbidden = findForbiddenText(segment, expected.forbiddenRenderedText);
  if (!forbidden) return;
  throw new TeamemChannelsEvidenceError(
    'body-leakage',
    `rendered transcript included forbidden compact-notice body text "${forbidden}" for ${expected.recipientPrincipal}`,
    contextForExpectation(expected, {
      artifacts: context.artifacts,
      checkpoint: context.checkpoint
    })
  );
}

function findForbiddenText(
  haystack: string,
  forbiddenText?: readonly string[]
): string | undefined {
  return forbiddenText?.find(
    (text) => text.length > 0 && haystack.includes(text)
  );
}

function findForbiddenTextIndex(
  haystack: string,
  forbiddenText?: readonly string[]
): number {
  return (
    forbiddenText?.reduce((found, text) => {
      if (found >= 0 || text.length === 0) return found;
      return haystack.indexOf(text);
    }, -1) ?? -1
  );
}

export function assertTeamemNegativeRecipientEvidence(
  input: TeamemChannelsNoRecipientEvidenceInput
): void {
  assertTeamemNoRecipientEvidence(input, {
    layer: 'negative-recipient filtering',
    subject: 'non-recipient'
  });
}

export function assertTeamemNoSenderEchoEvidence(
  input: TeamemChannelsNoRecipientEvidenceInput
): void {
  assertTeamemNoRecipientEvidence(input, {
    layer: 'sender-echo',
    subject: 'sender'
  });
}

function assertTeamemNoRecipientEvidence(
  input: TeamemChannelsNoRecipientEvidenceInput,
  options: {
    readonly layer: Extract<
      TeamemChannelsEvidenceLayer,
      'negative-recipient filtering' | 'sender-echo'
    >;
    readonly subject: string;
  }
): void {
  assertExpectedMarkerIdentity(input.expected, options.layer, {
    persona: input.persona,
    artifacts: input.artifacts,
    checkpoint: {
      ...input.traceCheckpoint,
      ...input.notificationCheckpoint,
      ...input.transcriptCheckpoint
    }
  });

  const context = contextForExpectation(input.expected, {
    persona: input.persona,
    artifacts: input.artifacts,
    checkpoint: {
      ...input.traceCheckpoint,
      ...input.notificationCheckpoint,
      ...input.transcriptCheckpoint
    }
  });

  if (
    input.traces?.some((trace) =>
      trace.messages.some((message) =>
        isMatchingChannelTraceMessage({
          message,
          expected: input.expected,
          checkpoint: input.traceCheckpoint
        })
      )
    )
  ) {
    throw new TeamemChannelsEvidenceError(
      options.layer,
      `unexpected channel transport evidence for ${options.subject} ${input.persona}`,
      context
    );
  }

  if (input.notificationLog) {
    const minLine = input.notificationCheckpoint?.lineOffset ?? 0;
    const lines = input.notificationLog.split(/\r?\n/).slice(minLine);
    if (
      lines.some((line) => {
        const envelope = parseNotificationLogEnvelope(line);
        return envelope
          ? matchesExpectedEnvelope(envelope, input.expected)
          : false;
      })
    ) {
      throw new TeamemChannelsEvidenceError(
        options.layer,
        `unexpected notification log evidence for ${options.subject} ${input.persona}`,
        context
      );
    }
  }

  if (input.transcriptCheckpoint) {
    const rawSegment =
      input.rawTranscript?.slice(input.transcriptCheckpoint.rawOffset) ?? '';
    const normalizedSegment =
      input.normalizedTranscript?.slice(
        input.transcriptCheckpoint.normalizedOffset
      ) ?? '';
    const rawWithoutAllowedEcho = removeSingleAllowedTranscriptMarkerEcho({
      segment: rawSegment,
      marker: input.expected.marker,
      allowedEchoes: input.allowedTranscriptMarkerEchoes
    });
    const normalizedWithoutAllowedEcho =
      removeSingleAllowedTranscriptMarkerEcho({
        segment: normalizedSegment,
        marker: input.expected.marker,
        allowedEchoes: input.allowedTranscriptMarkerEchoes
      });
    if (
      containsExpectedMarkerRender(rawWithoutAllowedEcho, input.expected) ||
      containsExpectedMarkerRender(normalizedWithoutAllowedEcho, input.expected)
    ) {
      throw new TeamemChannelsEvidenceError(
        options.layer,
        `unexpected rendered marker for ${options.subject} ${input.persona}`,
        context
      );
    }
  }
}

export function assertTeamemNoChannelEvidenceForMarker(input: {
  readonly persona: TeamemChannelsPersona | string;
  readonly expected: TeamemChannelsNegativeMarkerExpectation;
  readonly traces?: readonly McpTrace[];
  readonly notificationLog?: string;
  readonly rawTranscript?: string;
  readonly normalizedTranscript?: string;
  readonly traceCheckpoint?: TeamemChannelsTraceCheckpoint;
  readonly notificationCheckpoint?: TeamemChannelsNotificationCheckpoint;
  readonly transcriptCheckpoint?: TeamemChannelsTranscriptCheckpoint;
  readonly allowedTranscriptMarkerEchoes?: readonly string[];
  readonly artifacts?: TeamemChannelsArtifactPaths;
}): void {
  assertNegativeMarkerIdentity(input.expected, 'negative-recipient filtering', {
    persona: input.persona,
    artifacts: input.artifacts,
    checkpoint: {
      ...input.traceCheckpoint,
      ...input.notificationCheckpoint,
      ...input.transcriptCheckpoint
    }
  });

  const context = contextForNegativeMarker(input.expected, {
    persona: input.persona,
    artifacts: input.artifacts,
    checkpoint: {
      ...input.traceCheckpoint,
      ...input.notificationCheckpoint,
      ...input.transcriptCheckpoint
    }
  });

  const matchingTrace = input.traces
    ?.flatMap((trace) => trace.messages)
    .find((message) =>
      isMatchingChannelMarkerMessage({
        message,
        expected: input.expected,
        checkpoint: input.traceCheckpoint
      })
    );
  if (matchingTrace) {
    throw new TeamemChannelsEvidenceError(
      'channel transport',
      `unexpected fresh Channel MCP trace for ${input.persona}`,
      context
    );
  }

  const staleTrace = input.traces
    ?.flatMap((trace) => trace.messages)
    .find((message) =>
      isMatchingChannelMarkerMessage({
        message,
        expected: input.expected
      })
    );
  if (staleTrace) {
    throw new TeamemChannelsEvidenceError(
      'stale evidence',
      `Channel MCP trace for ${input.persona} matched marker only before checkpoint`,
      context
    );
  }

  if (input.notificationLog) {
    const minLine = input.notificationCheckpoint?.lineOffset ?? 0;
    const lines = input.notificationLog.split(/\r?\n/);
    for (let index = minLine; index < lines.length; index += 1) {
      const envelope = parseNotificationLogEnvelope(lines[index]?.trim() ?? '');
      if (envelope && matchesNegativeMarkerEnvelope(envelope, input.expected)) {
        throw new TeamemChannelsEvidenceError(
          'notification log',
          `unexpected fresh notification-log envelope for ${input.persona}`,
          context
        );
      }
    }
    for (let index = 0; index < minLine; index += 1) {
      const envelope = parseNotificationLogEnvelope(lines[index]?.trim() ?? '');
      if (envelope && matchesNegativeMarkerEnvelope(envelope, input.expected)) {
        throw new TeamemChannelsEvidenceError(
          'stale evidence',
          `notification-log envelope for ${input.persona} matched marker only before checkpoint`,
          context
        );
      }
    }
  }

  if (input.transcriptCheckpoint) {
    const rawSegment =
      input.rawTranscript?.slice(input.transcriptCheckpoint.rawOffset) ?? '';
    const normalizedSegment =
      input.normalizedTranscript?.slice(
        input.transcriptCheckpoint.normalizedOffset
      ) ?? '';
    const rawWithoutAllowedEcho = removeSingleAllowedTranscriptMarkerEcho({
      segment: rawSegment,
      marker: input.expected.marker,
      allowedEchoes: input.allowedTranscriptMarkerEchoes
    });
    const normalizedWithoutAllowedEcho =
      removeSingleAllowedTranscriptMarkerEcho({
        segment: normalizedSegment,
        marker: input.expected.marker,
        allowedEchoes: input.allowedTranscriptMarkerEchoes
      });
    if (
      containsNegativeMarkerRender(rawWithoutAllowedEcho, input.expected) ||
      containsNegativeMarkerRender(normalizedWithoutAllowedEcho, input.expected)
    ) {
      throw new TeamemChannelsEvidenceError(
        'rendered transcript',
        `unexpected fresh rendered Channel evidence for ${input.persona}`,
        context
      );
    }

    const staleRaw = input.rawTranscript?.slice(
      0,
      input.transcriptCheckpoint.rawOffset
    );
    const staleNormalized = input.normalizedTranscript?.slice(
      0,
      input.transcriptCheckpoint.normalizedOffset
    );
    if (
      containsNegativeMarkerRender(staleRaw ?? '', input.expected) ||
      containsNegativeMarkerRender(staleNormalized ?? '', input.expected)
    ) {
      throw new TeamemChannelsEvidenceError(
        'stale evidence',
        `rendered transcript for ${input.persona} matched marker only before checkpoint`,
        context
      );
    }
  }
}

function removeSingleAllowedTranscriptMarkerEcho(input: {
  readonly segment: string;
  readonly marker: string;
  readonly allowedEchoes?: readonly string[];
}): string {
  const allowedEchoes = input.allowedEchoes ?? [];
  const usedAllowedEchoes = new Set<number>();
  let segment = input.segment;

  for (let count = 0; count < allowedEchoes.length; count += 1) {
    const candidates = allowedEchoes
      .flatMap((echo, allowedIndex) => {
        if (
          usedAllowedEchoes.has(allowedIndex) ||
          echo.length === 0 ||
          !echo.includes(input.marker)
        ) {
          return [];
        }
        return findAllowedTranscriptMarkerEchoCandidates({
          segment,
          marker: input.marker,
          echo,
          allowedIndex
        });
      })
      .sort((left, right) => {
        if (left.index !== right.index) return left.index - right.index;
        return right.echo.length - left.echo.length;
      });
    const firstEcho = candidates[0];
    if (!firstEcho) break;

    segment = [
      segment.slice(0, firstEcho.index),
      segment.slice(firstEcho.index + firstEcho.echo.length)
    ].join('');
    usedAllowedEchoes.add(firstEcho.allowedIndex);
  }

  return segment;
}

type TranscriptMarkerEchoCandidate = {
  readonly echo: string;
  readonly index: number;
  readonly allowedIndex: number;
};

function findAllowedTranscriptMarkerEchoCandidates(input: {
  readonly segment: string;
  readonly marker: string;
  readonly echo: string;
  readonly allowedIndex: number;
}): TranscriptMarkerEchoCandidate[] {
  const exactIndex = input.segment.indexOf(input.echo);
  const exactCandidates =
    exactIndex >= 0
      ? [
          {
            echo: input.echo,
            index: exactIndex,
            allowedIndex: input.allowedIndex
          }
        ]
      : [];
  const wrappedEcho = findWrappedTranscriptMarkerEcho({
    segment: input.segment,
    marker: input.marker,
    echo: input.echo
  });
  const slashCommandEcho = findSlashCommandMarkerEcho({
    segment: input.segment,
    marker: input.marker,
    echo: input.echo
  });
  return [
    ...exactCandidates,
    ...(wrappedEcho
      ? [{ ...wrappedEcho, allowedIndex: input.allowedIndex }]
      : []),
    ...(slashCommandEcho
      ? [{ ...slashCommandEcho, allowedIndex: input.allowedIndex }]
      : [])
  ];
}

function findWrappedTranscriptMarkerEcho(input: {
  readonly segment: string;
  readonly marker: string;
  readonly echo: string;
}): { readonly echo: string; readonly index: number } | null {
  const tokens = input.echo.split(/\s+/).filter(Boolean);
  if (tokens.length < 2 || !tokens.includes(input.marker)) return null;

  const separator =
    String.raw`(?:[\s\u00a0]|` +
    String.raw`\x1b\[[0-?]*[ -/]*[@-~]|` +
    String.raw`\x1b\][^\x07]*(?:\x07|\x1b\\)|` +
    String.raw`\x1b[@-_])+`;
  const pattern = tokens.map(escapeRegExp).join(separator);
  const match = new RegExp(pattern).exec(input.segment);
  if (!match || match.index === undefined) return null;

  return { echo: match[0], index: match.index };
}

function findSlashCommandMarkerEcho(input: {
  readonly segment: string;
  readonly marker: string;
  readonly echo: string;
}): { readonly echo: string; readonly index: number } | null {
  if (!input.echo.includes('/teamem') || !input.echo.includes(input.marker)) {
    return null;
  }

  let searchFrom = 0;
  while (searchFrom < input.segment.length) {
    const markerIndex = input.segment.indexOf(input.marker, searchFrom);
    if (markerIndex < 0) return null;
    const prefixStart = Math.max(0, markerIndex - 512);
    const prefix = input.segment.slice(prefixStart, markerIndex);
    const slashIndex = prefix.lastIndexOf('/teamem');
    if (slashIndex >= 0) {
      const index = prefixStart + slashIndex;
      const echo = input.segment.slice(
        index,
        markerIndex + input.marker.length
      );
      if (!echo.includes('teamem-channel:')) {
        return { echo, index };
      }
    }
    searchFrom = markerIndex + input.marker.length;
  }

  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function assertTeamemRecipientReceipt(input: {
  readonly persona: TeamemChannelsPersona;
  readonly personaPrincipal?: string;
  readonly expected: TeamemChannelsEvidenceExpectation;
  readonly tracePath: string;
  readonly notificationLogPath: string;
  readonly rawTranscriptPath: string;
  readonly normalizedTranscriptPath: string;
  readonly traceCheckpoint?: TeamemChannelsTraceCheckpoint;
  readonly notificationCheckpoint?: TeamemChannelsNotificationCheckpoint;
  readonly transcriptCheckpoint: TeamemChannelsTranscriptCheckpoint;
}): Promise<TeamemChannelsRecipientReceiptEvidence> {
  const artifacts = {
    channelTracePath: input.tracePath,
    notificationLogPath: input.notificationLogPath,
    rawTranscriptPath: input.rawTranscriptPath,
    normalizedTranscriptPath: input.normalizedTranscriptPath
  };

  const observedRecipient = input.personaPrincipal ?? input.persona;
  if (observedRecipient !== input.expected.recipientPrincipal) {
    throw new TeamemChannelsEvidenceError(
      'launch/readiness',
      `recipient receipt persona ${input.persona} (${observedRecipient}) does not match expected recipient ${input.expected.recipientPrincipal}`,
      contextForExpectation(input.expected, {
        persona: input.persona,
        artifacts,
        checkpoint: {
          ...input.traceCheckpoint,
          ...input.notificationCheckpoint,
          ...input.transcriptCheckpoint
        }
      })
    );
  }

  const transport = await assertTeamemChannelTransportEvidence({
    tracePath: input.tracePath,
    expected: input.expected,
    checkpoint: input.traceCheckpoint
  });
  const notificationLog = await assertTeamemNotificationLogEvidence({
    notificationLogPath: input.notificationLogPath,
    expected: input.expected,
    checkpoint: input.notificationCheckpoint
  });
  const renderedTranscript = await assertTeamemRenderedTranscriptEvidence({
    rawTranscriptPath: input.rawTranscriptPath,
    normalizedTranscriptPath: input.normalizedTranscriptPath,
    expected: input.expected,
    checkpoint: input.transcriptCheckpoint,
    notificationEvidence: notificationLog,
    artifacts
  });

  return { transport, notificationLog, renderedTranscript };
}

export function expectedTeamemChannelsDeliveryMatrix(
  caseName: TeamemChannelsSplitCase
): Record<TeamemChannelsPersona, boolean> {
  switch (caseName) {
    case 'direct':
      return { alice: false, bob: true, carol: false };
    case 'star':
    case 'starstar':
      return { alice: false, bob: true, carol: true };
  }
}

async function readTeamemChannelTraceArtifact(input: {
  readonly tracePath: string;
  readonly expected: TeamemChannelsEvidenceExpectation;
  readonly checkpoint?: TeamemChannelsTraceCheckpoint;
}): Promise<McpTrace[]> {
  let raw: string;
  try {
    raw = await readFile(input.tracePath, 'utf8');
  } catch (error) {
    throw new TeamemChannelsEvidenceError(
      'channel transport',
      `failed to read channel trace artifact: ${formatUnknown(error)}`,
      contextForExpectation(input.expected, {
        artifacts: { channelTracePath: input.tracePath },
        checkpoint: input.checkpoint
      })
    );
  }

  try {
    const parsed = JSON.parse(raw) as McpTrace | McpTrace[];
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (error) {
    throw new TeamemChannelsEvidenceError(
      'channel transport',
      `failed to parse channel trace artifact: ${formatUnknown(error)}`,
      contextForExpectation(input.expected, {
        artifacts: { channelTracePath: input.tracePath },
        checkpoint: input.checkpoint
      })
    );
  }
}

function isMatchingChannelTraceMessage(input: {
  readonly message: McpTraceMessage;
  readonly expected: TeamemChannelsEvidenceExpectation;
  readonly checkpoint?: TeamemChannelsTraceCheckpoint;
}): boolean {
  const { message, expected, checkpoint } = input;
  if (message.method !== 'notifications/claude/channel') return false;
  if (
    checkpoint?.offsetMs !== undefined &&
    message.offsetMs < checkpoint.offsetMs
  ) {
    return false;
  }
  if (
    checkpoint?.timestamp &&
    Date.parse(message.timestamp) < Date.parse(checkpoint.timestamp)
  ) {
    return false;
  }
  const notification = parseChannelNotification(message.json);
  if (!notification) return false;
  const envelope = parseChannelEnvelope(notification.params.content);
  if (!envelope) return false;
  const meta = notification.params.meta;
  return (
    meta.event_id === expected.eventId &&
    matchesOptionalMeta(meta, 'event_type', expected.eventType) &&
    matchesOptionalMeta(meta, 'thread_id', expected.threadId) &&
    matchesOptionalMeta(meta, 'message_id', expected.messageId) &&
    meta.principal === expected.senderPrincipal &&
    matchesOptionalMeta(
      meta,
      'recipient_principal',
      expectedChannelMetaRecipient(expected)
    ) &&
    matchesOptionalMeta(meta, 'delivery_scope', expected.deliveryScope) &&
    matchesExpectedEnvelope(envelope, expected)
  );
}

function isMatchingChannelMarkerMessage(input: {
  readonly message: McpTraceMessage;
  readonly expected: TeamemChannelsNegativeMarkerExpectation;
  readonly checkpoint?: TeamemChannelsTraceCheckpoint;
}): boolean {
  const { message, expected, checkpoint } = input;
  if (message.method !== 'notifications/claude/channel') return false;
  if (
    checkpoint?.offsetMs !== undefined &&
    message.offsetMs < checkpoint.offsetMs
  ) {
    return false;
  }
  if (
    checkpoint?.timestamp &&
    Date.parse(message.timestamp) < Date.parse(checkpoint.timestamp)
  ) {
    return false;
  }
  const notification = parseChannelNotification(message.json);
  if (!notification) return false;
  const envelope = parseChannelEnvelope(notification.params.content);
  return envelope ? matchesNegativeMarkerEnvelope(envelope, expected) : false;
}

function traceStaleReason(input: {
  readonly message: McpTraceMessage;
  readonly envelope: TeamemChannelEnvelope;
  readonly expected: TeamemChannelsEvidenceExpectation;
  readonly checkpoint?: TeamemChannelsTraceCheckpoint;
}): string | undefined {
  if (!matchesExpectedEnvelope(input.envelope, input.expected)) {
    return undefined;
  }
  if (
    input.checkpoint?.offsetMs !== undefined &&
    input.message.offsetMs < input.checkpoint.offsetMs
  ) {
    return `channel trace offset ${input.message.offsetMs} was before checkpoint offset ${input.checkpoint.offsetMs}`;
  }
  if (
    input.checkpoint?.timestamp &&
    Date.parse(input.message.timestamp) < Date.parse(input.checkpoint.timestamp)
  ) {
    return `channel trace timestamp ${input.message.timestamp} was before checkpoint timestamp ${input.checkpoint.timestamp}`;
  }
  return undefined;
}

function parseChannelNotification(value: unknown):
  | {
      method: 'notifications/claude/channel';
      params: { content: string; meta: Record<string, string> };
    }
  | undefined {
  if (!isRecord(value)) return undefined;
  if (value.method !== 'notifications/claude/channel') return undefined;
  if (!isRecord(value.params)) return undefined;
  if (typeof value.params.content !== 'string') return undefined;
  if (!isRecord(value.params.meta)) return undefined;
  return {
    method: 'notifications/claude/channel',
    params: {
      content: value.params.content,
      meta: Object.fromEntries(
        Object.entries(value.params.meta).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string'
        )
      )
    }
  };
}

function parseChannelEnvelope(
  value: unknown
): TeamemChannelEnvelope | undefined {
  const parsed = typeof value === 'string' ? parseJson(value) : value;
  if (!isRecord(parsed)) return undefined;
  if (
    parsed.name !== 'teamem.peer_event' &&
    parsed.name !== 'teamem.dispute_event'
  ) {
    return undefined;
  }
  if (typeof parsed.event_id !== 'string') return undefined;
  if (typeof parsed.principal !== 'string') return undefined;
  return parsed as TeamemChannelEnvelope;
}

function parseNotificationLogEnvelope(
  line: string
): TeamemChannelEnvelope | undefined {
  const parsed = parseJson(line);
  if (!isRecord(parsed)) return undefined;
  if (
    parsed.method === 'notifications/claude/channel' &&
    isRecord(parsed.params)
  ) {
    return parseChannelEnvelope(parsed.params.content);
  }
  if (typeof parsed.content === 'string') {
    return parseChannelEnvelope(parsed.content);
  }
  return parseChannelEnvelope(parsed);
}

function matchesExpectedEnvelope(
  envelope: TeamemChannelEnvelope,
  expected: TeamemChannelsEvidenceExpectation
): boolean {
  if (!matchesExpectedEnvelopeIdentity(envelope, expected)) return false;
  if (expected.requiredPayloadText) {
    const haystack = envelopeTextHaystack(envelope);
    return expected.requiredPayloadText.every((text) =>
      haystack.includes(text)
    );
  }
  const payload = isRecord(envelope.payload) ? envelope.payload : {};
  return (
    typeof payload.body === 'string' &&
    String(payload.body).includes(expected.marker)
  );
}

function envelopeTextHaystack(envelope: TeamemChannelEnvelope): string {
  const payload = isRecord(envelope.payload) ? envelope.payload : {};
  return JSON.stringify({
    payload,
    summary: envelope.summary,
    event_type: envelope.event_type,
    principal: envelope.principal,
    scope: envelope.scope
  });
}

function matchesExpectedEnvelopeIdentity(
  envelope: TeamemChannelEnvelope,
  expected: TeamemChannelsEvidenceExpectation
): boolean {
  if (envelope.event_id !== expected.eventId) return false;
  if (envelope.principal !== expected.senderPrincipal) return false;
  const expectedEventType = expected.eventType ?? 'discussion_posted';
  if (envelope.event_type !== expectedEventType) return false;
  if (expectedEventType !== 'discussion_posted') return true;
  const payload = isRecord(envelope.payload) ? envelope.payload : {};
  if (
    expected.deliveryScope === 'direct' &&
    payload.recipient_principal !== expected.recipientPrincipal
  ) {
    return false;
  }
  return (
    payload.thread_id === expected.threadId &&
    payload.message_id === expected.messageId
  );
}

function matchesExpectedChannelRouting(input: {
  readonly notification: {
    readonly params: { readonly meta: Record<string, string> };
  };
  readonly envelope: TeamemChannelEnvelope;
  readonly expected: TeamemChannelsEvidenceExpectation;
}): boolean {
  const { meta } = input.notification.params;
  return (
    meta.event_id === input.expected.eventId &&
    matchesOptionalMeta(meta, 'event_type', input.expected.eventType) &&
    matchesOptionalMeta(meta, 'thread_id', input.expected.threadId) &&
    matchesOptionalMeta(meta, 'message_id', input.expected.messageId) &&
    meta.principal === input.expected.senderPrincipal &&
    matchesOptionalMeta(
      meta,
      'recipient_principal',
      expectedChannelMetaRecipient(input.expected)
    ) &&
    matchesOptionalMeta(meta, 'delivery_scope', input.expected.deliveryScope) &&
    matchesExpectedEnvelopeIdentity(input.envelope, input.expected)
  );
}

function assertExpectedMarkerIdentity(
  expected: TeamemChannelsEvidenceExpectation,
  layer: TeamemChannelsEvidenceLayer,
  options: {
    readonly persona?: TeamemChannelsPersona | string;
    readonly artifacts?: TeamemChannelsArtifactPaths;
    readonly checkpoint?: TeamemChannelsEvidenceContext['checkpoint'];
  } = {}
): void {
  const missingIdentity: string[] = [];
  if (!expected.marker.includes(expected.runId)) {
    missingIdentity.push('run id');
  }
  if (!expected.marker.includes(String(expected.caseName))) {
    missingIdentity.push('case');
  }
  if (missingIdentity.length === 0) return;

  throw new TeamemChannelsEvidenceError(
    layer,
    `expected marker must include ${missingIdentity.join(' and ')} identity`,
    contextForExpectation(expected, options)
  );
}

function assertRenderedTranscriptNotificationEvidence(input: {
  readonly expected: TeamemChannelsEvidenceExpectation;
  readonly checkpoint: TeamemChannelsTranscriptCheckpoint;
  readonly notificationEvidence: TeamemChannelsNotificationLogEvidence;
  readonly artifacts?: TeamemChannelsArtifactPaths;
}): void {
  if (
    !matchesExpectedEnvelope(
      input.notificationEvidence.envelope,
      input.expected
    )
  ) {
    throw new TeamemChannelsEvidenceError(
      'rendered transcript',
      `notification evidence did not match expected envelope for ${input.expected.recipientPrincipal}`,
      contextForExpectation(input.expected, {
        artifacts: input.artifacts,
        checkpoint: input.checkpoint
      })
    );
  }

  if (
    input.checkpoint.notificationLineOffset !== undefined &&
    input.notificationEvidence.lineIndex <
      input.checkpoint.notificationLineOffset
  ) {
    throw new TeamemChannelsEvidenceError(
      'stale evidence',
      `notification evidence line ${input.notificationEvidence.lineIndex} was before checkpoint line ${input.checkpoint.notificationLineOffset}`,
      contextForExpectation(input.expected, {
        artifacts: input.artifacts,
        checkpoint: input.checkpoint
      })
    );
  }
}

function expectedChannelMetaRecipient(
  expected: TeamemChannelsEvidenceExpectation
): string | undefined {
  if (!expected.deliveryScope) return undefined;
  if (expected.deliveryScope === 'direct') return expected.recipientPrincipal;
  if (expected.deliveryScope === 'space') return 'space';
  return 'sprint';
}

function matchesOptionalMeta(
  meta: Record<string, string>,
  key: string,
  expected: string | undefined
): boolean {
  return expected === undefined || meta[key] === expected;
}

function findRenderedChannelSourceIndex(
  segment: string,
  expected: TeamemChannelsEvidenceExpectation
): number {
  let searchFrom = 0;
  while (searchFrom < segment.length) {
    const peerEventIndex = segment.indexOf('teamem.peer_event', searchFrom);
    if (peerEventIndex < 0) return -1;
    const index = Math.max(0, peerEventIndex - 64);
    const renderedLine = segment.slice(index, peerEventIndex + 512);
    if (
      hasRenderedChannelSourcePrefix(renderedLine) &&
      !renderedLine.includes(expected.marker)
    ) {
      return index;
    }
    searchFrom = peerEventIndex + 'teamem.peer_event'.length;
  }
  return -1;
}

function containsNegativeMarkerRender(
  segment: string,
  expected: TeamemChannelsNegativeMarkerExpectation
): boolean {
  return findRenderedChannelMarkerSourceIndex(segment, expected) >= 0;
}

function containsExpectedMarkerRender(
  segment: string,
  expected: TeamemChannelsEvidenceExpectation
): boolean {
  return findRenderedExpectedChannelMarkerSourceIndex(segment, expected) >= 0;
}

function findRenderedExpectedChannelMarkerSourceIndex(
  segment: string,
  expected: TeamemChannelsEvidenceExpectation
): number {
  let searchFrom = 0;
  while (searchFrom < segment.length) {
    const peerEventIndex = segment.indexOf('teamem.peer_event', searchFrom);
    if (peerEventIndex < 0) return -1;
    const index = Math.max(0, peerEventIndex - 64);
    const renderedLine = segment.slice(index, peerEventIndex + 1024);
    if (
      hasRenderedChannelSourcePrefix(renderedLine) &&
      renderedLine.includes(expected.marker) &&
      (!expected.eventType || renderedLine.includes(expected.eventType))
    ) {
      return index;
    }
    searchFrom = peerEventIndex + 'teamem.peer_event'.length;
  }
  return -1;
}

function findRenderedChannelMarkerSourceIndex(
  segment: string,
  expected: TeamemChannelsNegativeMarkerExpectation
): number {
  let searchFrom = 0;
  while (searchFrom < segment.length) {
    const peerEventIndex = segment.indexOf('teamem.peer_event', searchFrom);
    if (peerEventIndex < 0) return -1;
    const index = Math.max(0, peerEventIndex - 64);
    const renderedLine = segment.slice(index, peerEventIndex + 1024);
    if (
      hasRenderedChannelSourcePrefix(renderedLine) &&
      renderedLine.includes(expected.marker) &&
      expected.eventTypes.some((eventType) => renderedLine.includes(eventType))
    ) {
      return index;
    }
    searchFrom = peerEventIndex + 'teamem.peer_event'.length;
  }
  return -1;
}

function hasRenderedChannelSourcePrefix(renderedLine: string): boolean {
  return (
    renderedLine.includes('channel:') ||
    renderedLine.includes('chanel:') ||
    renderedLine.includes('channe:') ||
    renderedLine.includes('teamem-cha') ||
    renderedLine.includes('tamem-cha') ||
    renderedLine.includes('tame-cha')
  );
}

function matchesNegativeMarkerEnvelope(
  envelope: TeamemChannelEnvelope,
  expected: TeamemChannelsNegativeMarkerExpectation
): boolean {
  return (
    expected.eventTypes.includes(envelope.event_type) &&
    JSON.stringify(envelope).includes(expected.marker)
  );
}

function contextForExpectation(
  expected: TeamemChannelsEvidenceExpectation,
  options: {
    readonly persona?: TeamemChannelsPersona | string;
    readonly artifacts?: TeamemChannelsArtifactPaths;
    readonly checkpoint?: TeamemChannelsEvidenceContext['checkpoint'];
  } = {}
): TeamemChannelsEvidenceContext {
  return {
    runId: expected.runId,
    caseName: expected.caseName,
    persona: options.persona ?? expected.recipientPrincipal,
    marker: expected.marker,
    artifacts: options.artifacts,
    checkpoint: options.checkpoint
  };
}

function contextForNegativeMarker(
  expected: TeamemChannelsNegativeMarkerExpectation,
  options: {
    readonly persona?: TeamemChannelsPersona | string;
    readonly artifacts?: TeamemChannelsArtifactPaths;
    readonly checkpoint?: TeamemChannelsEvidenceContext['checkpoint'];
  } = {}
): TeamemChannelsEvidenceContext {
  return {
    runId: expected.runId,
    caseName: expected.caseName,
    persona: options.persona,
    marker: expected.marker,
    artifacts: options.artifacts,
    checkpoint: options.checkpoint
  };
}

function assertNegativeMarkerIdentity(
  expected: TeamemChannelsNegativeMarkerExpectation,
  layer: TeamemChannelsEvidenceLayer,
  options: {
    readonly persona?: TeamemChannelsPersona | string;
    readonly artifacts?: TeamemChannelsArtifactPaths;
    readonly checkpoint?: TeamemChannelsEvidenceContext['checkpoint'];
  } = {}
): void {
  const missingIdentity: string[] = [];
  if (!expected.marker.includes(expected.runId)) {
    missingIdentity.push('run id');
  }
  if (!expected.marker.includes(String(expected.caseName))) {
    missingIdentity.push('case');
  }
  if (expected.eventTypes.length === 0) {
    missingIdentity.push('event types');
  }
  if (missingIdentity.length === 0) return;

  throw new TeamemChannelsEvidenceError(
    layer,
    `expected negative marker must include ${missingIdentity.join(' and ')}`,
    contextForNegativeMarker(expected, options)
  );
}

function renderArtifacts(input: {
  readonly rawTranscriptPath: string;
  readonly normalizedTranscriptPath: string;
  readonly artifacts?: TeamemChannelsArtifactPaths;
}): TeamemChannelsArtifactPaths {
  return {
    ...input.artifacts,
    rawTranscriptPath: input.rawTranscriptPath,
    normalizedTranscriptPath: input.normalizedTranscriptPath
  };
}

function formatEvidenceContext(context: TeamemChannelsEvidenceContext): string {
  const parts = [
    ['run id', context.runId],
    ['case', context.caseName],
    ['persona', context.persona],
    ['marker', context.marker],
    ['channel trace', context.artifacts?.channelTracePath],
    ['notification log', context.artifacts?.notificationLogPath],
    ['raw transcript', context.artifacts?.rawTranscriptPath],
    ['normalized transcript', context.artifacts?.normalizedTranscriptPath],
    [
      'checkpoint',
      context.checkpoint ? JSON.stringify(context.checkpoint) : undefined
    ]
  ]
    .filter((part): part is [string, string] => typeof part[1] === 'string')
    .map(([key, value]) => `${key}=${value}`);
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function formatUnknown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
