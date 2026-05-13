import { createHash } from 'node:crypto';

export const SPACE_RULES_MANAGED_BEGIN = '<!-- BEGIN TEAMEM SPACE RULES -->';
export const SPACE_RULES_MANAGED_END = '<!-- END TEAMEM SPACE RULES -->';

export type SpaceRulesSnapshotMetadata = {
  format_version: 1;
  source: 'server' | 'none';
  managed_begin: string;
  managed_end: string;
  rules_version: number;
  rules_hash: string;
  generated_at: string;
  space_id: string;
  space_label: string;
  source_event_id: string | null;
  snapshot_updated_at: string | null;
  snapshot_updated_by: string | null;
};

export type SpaceRulesSnapshotResponse = {
  has_server_rules: boolean;
  rendered_rules_body: string;
  metadata: SpaceRulesSnapshotMetadata;
};

export function canonicalRulesBody(body: string): string {
  return body.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trimEnd();
}

export function stableRulesHash(body: string): string {
  return createHash('sha256').update(canonicalRulesBody(body)).digest('hex');
}

export function buildSpaceRulesSnapshot(input: {
  renderedRulesBody: string;
  hasServerRules: boolean;
  spaceId: string;
  spaceLabel: string;
  rulesVersion: number;
  sourceEventId: string | null;
  snapshotUpdatedAt: string | null;
  snapshotUpdatedBy: string | null;
  generatedAt?: string;
}): SpaceRulesSnapshotResponse {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const source = input.hasServerRules ? 'server' : 'none';

  return {
    has_server_rules: input.hasServerRules,
    rendered_rules_body: input.renderedRulesBody,
    metadata: {
      format_version: 1,
      source,
      managed_begin: SPACE_RULES_MANAGED_BEGIN,
      managed_end: SPACE_RULES_MANAGED_END,
      rules_version: input.rulesVersion,
      rules_hash: stableRulesHash(input.renderedRulesBody),
      generated_at: generatedAt,
      space_id: input.spaceId,
      space_label: input.spaceLabel,
      source_event_id: input.sourceEventId,
      snapshot_updated_at: input.snapshotUpdatedAt,
      snapshot_updated_by: input.snapshotUpdatedBy
    }
  };
}
