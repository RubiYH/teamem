import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createSqliteClient,
  runMigration
} from '../../../src/infra/db/sqlite-client.js';

const issue01MigrationSource = readFileSync(
  join(
    process.cwd(),
    'apps/web/db/migrations/002_issue01_free_trial_policy_and_grants.sql'
  ),
  'utf8'
);
const issue03MigrationSource = readFileSync(
  join(
    process.cwd(),
    'apps/web/db/migrations/003_issue03_cloud_space_policy_metadata.sql'
  ),
  'utf8'
);
const issue07MigrationSource = readFileSync(
  join(
    process.cwd(),
    'apps/web/db/migrations/004_issue07_policy_override_audit_events.sql'
  ),
  'utf8'
);
const runtimePolicyMigrationSource = readFileSync(
  join(
    process.cwd(),
    'src/infra/db/migrations/030_cloud_admin_policy_metadata.sql'
  ),
  'utf8'
);

const preIssue07AuditEventTypes = [
  'cloud_space_create_attempted',
  'cloud_space_create_quota_rejected',
  'cloud_space_create_succeeded',
  'cloud_space_create_failed',
  'cloud_space_suspended',
  'cloud_space_room_code_rotate_attempted',
  'cloud_space_room_code_rotate_succeeded',
  'cloud_space_room_code_rotate_failed',
  'cloud_space_delete_attempted',
  'cloud_space_delete_succeeded',
  'cloud_space_delete_failed'
] as const;

const issue07PolicyOverrideAuditEventTypes = [
  'cloud_space_policy_override_attempted',
  'cloud_space_policy_override_succeeded',
  'cloud_space_policy_override_failed'
] as const;

describe('Teamem Cloud control-plane migrations', () => {
  it('adds free-trial policy and grant tables for databases that already ran the old baseline', () => {
    expect(issue01MigrationSource).toContain(
      'CREATE TABLE IF NOT EXISTS cloud_plan_policies'
    );
    expect(issue01MigrationSource).toContain(
      'CREATE TABLE IF NOT EXISTS cloud_free_plan_grants'
    );
    expect(issue01MigrationSource).toContain("'policy_free_trial_v1'");
    expect(issue01MigrationSource).toContain("'one_lifetime_space'");
    expect(issue01MigrationSource).toContain(
      'INSERT INTO cloud_free_plan_grants'
    );
    expect(issue01MigrationSource).toContain("status <> 'provisioning_failed'");
    expect(issue03MigrationSource).toContain('FROM cloud_plan_policies');
  });

  it('migrates pre-issue07 audit constraints to accept policy override events', () => {
    const beforeMigration = new AuditEventConstraint(preIssue07AuditEventTypes);

    for (const eventType of issue07PolicyOverrideAuditEventTypes) {
      expect(() => beforeMigration.insert(eventType)).toThrow(
        `event_type check failed: ${eventType}`
      );
    }

    const migratedEventTypes = extractAuditEventCheckEventTypes(
      issue07MigrationSource
    );
    const afterMigration = new AuditEventConstraint(migratedEventTypes);

    expect(issue07MigrationSource).toContain(
      'DROP CONSTRAINT IF EXISTS cloud_audit_events_event_type_check'
    );
    for (const eventType of preIssue07AuditEventTypes) {
      expect(() => afterMigration.insert(eventType)).not.toThrow();
    }
    for (const eventType of issue07PolicyOverrideAuditEventTypes) {
      expect(() => afterMigration.insert(eventType)).not.toThrow();
    }
  });

  it('backfills legacy runtime Cloud Spaces with enforceable free-trial policy metadata', () => {
    expect(runtimePolicyMigrationSource).toContain('cloud_trial_expires_at');
    expect(runtimePolicyMigrationSource).toContain('cloud_member_limit');
    expect(runtimePolicyMigrationSource).toContain(
      "cloud_provisioning_source = 'teamem-cloud'"
    );
    expect(runtimePolicyMigrationSource).toContain(
      "COALESCE(cloud_plan, 'free')"
    );
    expect(runtimePolicyMigrationSource).toContain(
      "strftime('%Y-%m-%dT%H:%M:%fZ', spaces.created_at, '+14 days')"
    );
    const addedRuntimeColumns = Array.from(
      runtimePolicyMigrationSource.matchAll(/ADD COLUMN\s+([a-z_]+)/g),
      ([, column]) => column
    );
    expect(addedRuntimeColumns).not.toContain('better_auth_user_id');
    expect(addedRuntimeColumns).not.toContain('oauth_provider_id');
    expect(addedRuntimeColumns).not.toContain('email');
    expect(addedRuntimeColumns).not.toContain('cloud_account_id');

    const db = createSqliteClient(':memory:');
    const migrationPath = (filename: string) =>
      join(process.cwd(), 'src/infra/db/migrations', filename);
    for (const filename of [
      '001_init.sql',
      '002_decisions_kind_and_indexes.sql',
      '003_room_codes_and_members.sql',
      '027_cloud_admin_space_metadata.sql'
    ]) {
      runMigration(db, migrationPath(filename));
    }

    db.prepare(
      `INSERT INTO spaces (
        id,
        label,
        creator_member_id,
        created_at,
        cloud_provisioning_source,
        cloud_control_plane_space_id,
        cloud_provisioning_request_id,
        cloud_idempotency_key
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
    ).run(
      'runtime-created-before-policy-copy',
      'Legacy Cloud Space',
      'member-1',
      '2026-05-12T00:00:00.000Z',
      'teamem-cloud',
      'control-space-1',
      'request-1',
      'idem-1'
    );

    runMigration(db, migrationPath('030_cloud_admin_policy_metadata.sql'));

    const row = db
      .prepare(
        `SELECT cloud_plan, cloud_trial_expires_at, cloud_member_limit
           FROM spaces
          WHERE id = ?1`
      )
      .get('runtime-created-before-policy-copy') as {
      cloud_plan: string | null;
      cloud_trial_expires_at: string | null;
      cloud_member_limit: number | null;
    };

    expect(row).toEqual({
      cloud_plan: 'free',
      cloud_trial_expires_at: '2026-05-26T00:00:00.000Z',
      cloud_member_limit: 3
    });
  });
});

function extractAuditEventCheckEventTypes(sql: string): string[] {
  const match = sql.match(/event_type\s+IN\s+\(([\s\S]*?)\)/);
  if (!match) {
    throw new Error('missing cloud_audit_events event_type check constraint');
  }

  return Array.from(match[1].matchAll(/'([^']+)'/g), ([, eventType]) => {
    if (!eventType) {
      throw new Error('empty event_type literal');
    }
    return eventType;
  });
}

class AuditEventConstraint {
  private readonly allowedEventTypes: ReadonlySet<string>;

  constructor(eventTypes: readonly string[]) {
    this.allowedEventTypes = new Set(eventTypes);
  }

  insert(eventType: string): void {
    if (!this.allowedEventTypes.has(eventType)) {
      throw new Error(`event_type check failed: ${eventType}`);
    }
  }
}
