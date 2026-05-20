import 'server-only';

import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type {
  CloudControlPlaneAccount,
  CloudControlPlaneAccountInput,
  CloudControlPlaneAuditEvent,
  CloudControlPlaneFreePlanGrant,
  CloudControlPlaneFreePlanPolicy,
  CloudControlPlaneRepository,
  CloudControlPlaneSpace,
  CloudControlPlaneSpacePlan,
  CloudControlPlaneSpaceStatus,
  CloudDashboardState,
  CloudRoomCodeDisplayMetadata,
  CreateCloudSpaceInsertResult
} from '../../../../src/cloud/control-plane';
import { getCloudDashboardState } from '../../../../src/cloud/control-plane';
import { loadTeamemCloudWebEnv } from './env';
import { createTeamemCloudPostgresPool } from './postgres';

let cachedPool: Pool | undefined;
let cachedRepository: CloudControlPlaneRepository | undefined;

export async function getDashboardStateForUser(
  user: CloudControlPlaneAccountInput
): Promise<CloudDashboardState> {
  return getCloudDashboardState(getControlPlaneRepository(), ids, clock, user);
}

export function getControlPlaneRepository(): CloudControlPlaneRepository {
  if (cachedRepository) {
    return cachedRepository;
  }

  cachedRepository = createPostgresControlPlaneRepository(
    getControlPlanePool()
  );
  return cachedRepository;
}

function getControlPlanePool(): Pool {
  if (cachedPool) {
    return cachedPool;
  }

  const envResult = loadTeamemCloudWebEnv();
  if (!envResult.ok) {
    throw new Error(
      `Teamem Cloud control-plane env is missing: ${envResult.missing.join(', ')}`
    );
  }

  cachedPool = createTeamemCloudPostgresPool(
    envResult.value.supabase.postgresUrl
  );
  return cachedPool;
}

function createPostgresControlPlaneRepository(
  pool: Pool
): CloudControlPlaneRepository {
  return {
    async ensureAccount(input) {
      const result = await pool.query<CloudAccountRow>(
        `
          INSERT INTO cloud_accounts (
            id,
            better_auth_user_id,
            email,
            display_name,
            created_at,
            updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $5)
          ON CONFLICT (better_auth_user_id)
          DO UPDATE SET
            email = EXCLUDED.email,
            display_name = EXCLUDED.display_name,
            updated_at = EXCLUDED.updated_at
          RETURNING *
        `,
        [
          input.id,
          input.betterAuthUserId,
          input.email,
          input.displayName,
          input.now
        ]
      );

      return mapAccountRow(requireRow(result.rows, 'cloud_accounts'));
    },

    async findPrimarySpaceForAccount(accountId) {
      const result = await pool.query<CloudSpaceRow>(
        `
          SELECT *
          FROM cloud_spaces
          WHERE owner_account_id = $1
            AND status NOT IN ('deleted')
          ORDER BY
            CASE
              WHEN plan = 'free'
                AND status IN ('provisioning_pending', 'active')
                THEN 0
              ELSE 1
            END,
            updated_at DESC
          LIMIT 1
        `,
        [accountId]
      );

      return result.rows[0] ? mapSpaceRow(result.rows[0]) : null;
    },

    async findCloudSpaceById(spaceId) {
      const result = await pool.query<CloudSpaceRow>(
        `
          SELECT *
          FROM cloud_spaces
          WHERE id = $1
          LIMIT 1
        `,
        [spaceId]
      );

      return result.rows[0] ? mapSpaceRow(result.rows[0]) : null;
    },

    async resolveActiveFreePlanPolicy() {
      const result = await pool.query<CloudPlanPolicyRow>(
        `
          SELECT *
          FROM cloud_plan_policies
          WHERE plan = 'free'
            AND active = TRUE
          LIMIT 1
        `
      );

      return mapFreePlanPolicyRow(
        requireRow(result.rows, 'cloud_plan_policies')
      );
    },

    async findActiveFreeSpaceForAccount(accountId) {
      const result = await pool.query<CloudSpaceRow>(
        `
          SELECT *
          FROM cloud_spaces
          WHERE owner_account_id = $1
            AND plan = 'free'
            AND status IN ('provisioning_pending', 'active', 'delete_pending')
          ORDER BY updated_at DESC
          LIMIT 1
        `,
        [accountId]
      );

      return result.rows[0] ? mapSpaceRow(result.rows[0]) : null;
    },

    async findNonVoidedFreePlanGrantForAccount(accountId) {
      const result = await pool.query<CloudFreePlanGrantRow>(
        `
          SELECT *
          FROM cloud_free_plan_grants
          WHERE account_id = $1
            AND voided_at IS NULL
          ORDER BY created_at DESC
          LIMIT 1
        `,
        [accountId]
      );

      return result.rows[0] ? mapFreePlanGrantRow(result.rows[0]) : null;
    },

    async insertCloudSpace(space) {
      try {
        const result = await pool.query<CloudSpaceRow>(
          `
            INSERT INTO cloud_spaces (
              id,
              owner_account_id,
              display_name,
              plan,
              status,
              trial_expires_at,
              member_limit,
              runtime_space_id,
              runtime_server_url,
              room_code_display_metadata,
              requested_at,
              provisioned_at,
              suspended_at,
              suspension_reason,
              deleted_at,
              created_at,
              updated_at
            )
            VALUES (
              $1,
              $2,
              $3,
              $4,
              $5,
              $6,
              $7,
              $8,
              $9,
              $10::jsonb,
              $11,
              $12,
              $13,
              $14,
              $15,
              $16,
              $17
            )
            RETURNING *
          `,
          [
            space.id,
            space.ownerAccountId,
            space.displayName,
            space.plan,
            space.status,
            space.trialExpiresAt,
            space.memberLimit,
            space.runtimeSpaceId,
            space.runtimeServerUrl,
            JSON.stringify(space.roomCodeDisplayMetadata),
            space.requestedAt,
            space.provisionedAt,
            space.suspendedAt,
            space.suspensionReason,
            space.deletedAt,
            space.createdAt,
            space.updatedAt
          ]
        );

        return {
          ok: true,
          space: mapSpaceRow(requireRow(result.rows, 'cloud_spaces'))
        } satisfies CreateCloudSpaceInsertResult;
      } catch (error) {
        if (isActiveFreeSpaceUniqueViolation(error)) {
          return { ok: false, reason: 'active_free_space_exists' };
        }
        throw error;
      }
    },

    async createFreeCloudSpaceGrant(input) {
      const client = await (
        pool as unknown as {
          connect(): Promise<{
            query<Row = unknown>(
              sql: string,
              values?: unknown[]
            ): Promise<{ rows: Row[] }>;
            release(): void;
          }>;
        }
      ).connect();
      try {
        await client.query('BEGIN');
        const result = await insertCloudSpaceWithClient(client, input.space);
        await client.query(
          `
            INSERT INTO cloud_free_plan_grants (
              id,
              account_id,
              policy_id,
              accepted_cloud_space_id,
              granted_at,
              voided_at,
              void_reason,
              created_at,
              updated_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          `,
          [
            input.grant.id,
            input.grant.accountId,
            input.grant.policyId,
            input.grant.acceptedCloudSpaceId,
            input.grant.grantedAt,
            input.grant.voidedAt,
            input.grant.voidReason,
            input.grant.createdAt,
            input.grant.updatedAt
          ]
        );
        await insertAuditEventWithClient(client, input.attemptAuditEvent);
        await client.query('COMMIT');
        return {
          ok: true,
          space: mapSpaceRow(requireRow(result.rows, 'cloud_spaces'))
        } satisfies CreateCloudSpaceInsertResult;
      } catch (error) {
        await client.query('ROLLBACK');
        if (isFreeTrialGrantUniqueViolation(error)) {
          return { ok: false, reason: 'free_trial_already_used' };
        }
        if (isActiveFreeSpaceUniqueViolation(error)) {
          return { ok: false, reason: 'active_free_space_exists' };
        }
        throw error;
      } finally {
        client.release();
      }
    },

    async markCloudSpaceProvisioned(input) {
      const result = await pool.query<CloudSpaceRow>(
        `
          UPDATE cloud_spaces
          SET
            status = 'active',
            runtime_space_id = $2,
            runtime_server_url = $3,
            room_code_display_metadata = $4::jsonb,
            provisioned_at = $5,
            updated_at = $5
          WHERE id = $1
          RETURNING *
        `,
        [
          input.spaceId,
          input.runtimeSpaceId,
          input.runtimeServerUrl,
          JSON.stringify(input.roomCodeDisplayMetadata),
          input.now
        ]
      );

      return mapSpaceRow(requireRow(result.rows, 'cloud_spaces'));
    },

    async markCloudSpaceProvisioningFailed(input) {
      const result = await pool.query<CloudSpaceRow>(
        `
          UPDATE cloud_spaces
          SET
            status = 'provisioning_failed',
            updated_at = $2
          WHERE id = $1
          RETURNING *
        `,
        [input.spaceId, input.now]
      );

      return mapSpaceRow(requireRow(result.rows, 'cloud_spaces'));
    },

    async markCloudSpaceProvisioningFailedAndVoidGrant(input) {
      const client = await (
        pool as unknown as {
          connect(): Promise<{
            query<Row = unknown>(
              sql: string,
              values?: unknown[]
            ): Promise<{ rows: Row[] }>;
            release(): void;
          }>;
        }
      ).connect();
      try {
        await client.query('BEGIN');
        const result = await client.query<CloudSpaceRow>(
          `
            UPDATE cloud_spaces
            SET
              status = 'provisioning_failed',
              updated_at = $2
            WHERE id = $1
            RETURNING *
          `,
          [input.spaceId, input.now]
        );
        await client.query(
          `
            UPDATE cloud_free_plan_grants
            SET
              voided_at = $2,
              void_reason = $3,
              updated_at = $2
            WHERE accepted_cloud_space_id = $1
              AND voided_at IS NULL
          `,
          [input.spaceId, input.now, input.voidReason]
        );
        await insertAuditEventWithClient(client, input.failureAuditEvent);
        await client.query('COMMIT');
        return mapSpaceRow(requireRow(result.rows, 'cloud_spaces'));
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },

    async markCloudSpaceDeletePending(input) {
      const result = await pool.query<CloudSpaceRow>(
        `
          UPDATE cloud_spaces
          SET
            status = 'delete_pending',
            updated_at = $2
          WHERE id = $1
            AND status <> 'deleted'
          RETURNING *
        `,
        [input.spaceId, input.now]
      );

      return mapSpaceRow(requireRow(result.rows, 'cloud_spaces'));
    },

    async markExpiredFreeCloudSpaceSuspended(input) {
      const client = await (
        pool as unknown as {
          connect(): Promise<{
            query<Row = unknown>(
              sql: string,
              values?: unknown[]
            ): Promise<{ rows: Row[] }>;
            release(): void;
          }>;
        }
      ).connect();
      try {
        await client.query('BEGIN');
        const updateResult = await client.query<CloudSpaceRow>(
          `
            UPDATE cloud_spaces
            SET
              status = 'suspended',
              suspended_at = COALESCE(suspended_at, $2),
              suspension_reason = 'free_trial_expired',
              updated_at = $3
            WHERE id = $1
              AND plan = 'free'
              AND status IN ('provisioning_pending', 'active')
            RETURNING *
          `,
          [input.spaceId, input.suspendedAt, input.now]
        );

        if (updateResult.rows[0]) {
          await insertAuditEventWithClient(client, input.suspensionAuditEvent);
          await client.query('COMMIT');
          return mapSpaceRow(updateResult.rows[0]);
        }

        const existing = await client.query<CloudSpaceRow>(
          `
            SELECT *
            FROM cloud_spaces
            WHERE id = $1
            LIMIT 1
          `,
          [input.spaceId]
        );
        await client.query('COMMIT');
        return mapSpaceRow(requireRow(existing.rows, 'cloud_spaces'));
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },

    async markCloudSpaceDeletedWithAudit(input) {
      const client = await (
        pool as unknown as {
          connect(): Promise<{
            query<Row = unknown>(
              sql: string,
              values?: unknown[]
            ): Promise<{ rows: Row[] }>;
            release(): void;
          }>;
        }
      ).connect();
      try {
        await client.query('BEGIN');
        const result = await client.query<CloudSpaceRow>(
          `
            UPDATE cloud_spaces
            SET
              status = 'deleted',
              deleted_at = $2,
              updated_at = $3
            WHERE id = $1
            RETURNING *
          `,
          [input.spaceId, input.deletedAt, input.now]
        );
        const space = mapSpaceRow(requireRow(result.rows, 'cloud_spaces'));

        await client.query(
          `
            INSERT INTO cloud_audit_events (
              id,
              account_id,
              cloud_space_id,
              event_type,
              metadata,
              created_at
            )
            VALUES ($1, $2, $3, $4, $5::jsonb, $6)
          `,
          [
            input.successAuditEvent.id,
            input.successAuditEvent.accountId,
            input.successAuditEvent.cloudSpaceId,
            input.successAuditEvent.eventType,
            JSON.stringify(input.successAuditEvent.metadata),
            input.successAuditEvent.createdAt
          ]
        );
        await client.query('COMMIT');
        return space;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },

    async updateRoomCodeDisplayMetadataWithAudit(input) {
      const client = await (
        pool as unknown as {
          connect(): Promise<{
            query<Row = unknown>(
              sql: string,
              values?: unknown[]
            ): Promise<{ rows: Row[] }>;
            release(): void;
          }>;
        }
      ).connect();
      try {
        await client.query('BEGIN');
        const result = await client.query<CloudSpaceRow>(
          `
            UPDATE cloud_spaces
            SET
              room_code_display_metadata = $2::jsonb,
              updated_at = $3
            WHERE id = $1
            RETURNING *
          `,
          [
            input.spaceId,
            JSON.stringify(input.roomCodeDisplayMetadata),
            input.now
          ]
        );
        const space = mapSpaceRow(requireRow(result.rows, 'cloud_spaces'));

        await client.query(
          `
            INSERT INTO cloud_audit_events (
              id,
              account_id,
              cloud_space_id,
              event_type,
              metadata,
              created_at
            )
            VALUES ($1, $2, $3, $4, $5::jsonb, $6)
          `,
          [
            input.successAuditEvent.id,
            input.successAuditEvent.accountId,
            input.successAuditEvent.cloudSpaceId,
            input.successAuditEvent.eventType,
            JSON.stringify(input.successAuditEvent.metadata),
            input.successAuditEvent.createdAt
          ]
        );
        await client.query('COMMIT');
        return space;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },

    async updateCloudSpaceResolvedPolicyWithAudit(input) {
      const client = await (
        pool as unknown as {
          connect(): Promise<{
            query<Row = unknown>(
              sql: string,
              values?: unknown[]
            ): Promise<{ rows: Row[] }>;
            release(): void;
          }>;
        }
      ).connect();
      try {
        await client.query('BEGIN');
        const result = await client.query<CloudSpaceRow>(
          `
            UPDATE cloud_spaces
            SET
              trial_expires_at = $2,
              member_limit = $3,
              status = CASE
                WHEN status = 'suspended'
                  AND suspension_reason = 'free_trial_expired'
                  AND $2::timestamptz > $4::timestamptz
                  THEN 'active'
                ELSE status
              END,
              suspended_at = CASE
                WHEN status = 'suspended'
                  AND suspension_reason = 'free_trial_expired'
                  AND $2::timestamptz > $4::timestamptz
                  THEN NULL
                ELSE suspended_at
              END,
              suspension_reason = CASE
                WHEN status = 'suspended'
                  AND suspension_reason = 'free_trial_expired'
                  AND $2::timestamptz > $4::timestamptz
                  THEN NULL
                ELSE suspension_reason
              END,
              updated_at = $4
            WHERE id = $1
            RETURNING *
          `,
          [input.spaceId, input.trialExpiresAt, input.memberLimit, input.now]
        );
        const space = mapSpaceRow(requireRow(result.rows, 'cloud_spaces'));

        await insertAuditEventWithClient(client, input.successAuditEvent);
        await client.query('COMMIT');
        return space;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },

    async appendAuditEvent(event) {
      await pool.query(
        `
          INSERT INTO cloud_audit_events (
            id,
            account_id,
            cloud_space_id,
            event_type,
            metadata,
            created_at
          )
          VALUES ($1, $2, $3, $4, $5::jsonb, $6)
        `,
        [
          event.id,
          event.accountId,
          event.cloudSpaceId,
          event.eventType,
          JSON.stringify(event.metadata),
          event.createdAt
        ]
      );
    }
  };
}

const ids = {
  accountId: () => `acct_${randomUUID()}`,
  spaceId: () => `csp_${randomUUID()}`,
  freePlanGrantId: () => `fpg_${randomUUID()}`,
  auditEventId: () => `aud_${randomUUID()}`
};

const clock = {
  now: () => new Date().toISOString()
};

type CloudAccountRow = {
  id: string;
  better_auth_user_id: string;
  email: string | null;
  display_name: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

type CloudSpaceRow = {
  id: string;
  owner_account_id: string;
  display_name: string;
  plan: CloudControlPlaneSpacePlan;
  status: CloudControlPlaneSpaceStatus;
  runtime_space_id: string | null;
  runtime_server_url: string | null;
  trial_expires_at: Date | string | null;
  member_limit: number | null;
  room_code_display_metadata: CloudRoomCodeDisplayMetadata;
  requested_at: Date | string;
  provisioned_at: Date | string | null;
  suspended_at: Date | string | null;
  suspension_reason: string | null;
  deleted_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

type CloudPlanPolicyRow = {
  id: string;
  plan: CloudControlPlaneSpacePlan;
  active: boolean;
  trial_days: number;
  member_limit: number;
  quota_mode: string;
  created_at: Date | string;
  updated_at: Date | string;
};

type CloudFreePlanGrantRow = {
  id: string;
  account_id: string;
  policy_id: string;
  accepted_cloud_space_id: string;
  granted_at: Date | string;
  voided_at: Date | string | null;
  void_reason: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

type ControlPlaneSqlClient = {
  query<Row = unknown>(
    sql: string,
    values?: unknown[]
  ): Promise<{ rows: Row[] }>;
};

function mapAccountRow(row: CloudAccountRow): CloudControlPlaneAccount {
  return {
    id: row.id,
    betterAuthUserId: row.better_auth_user_id,
    email: row.email,
    displayName: row.display_name,
    createdAt: formatTimestamp(row.created_at),
    updatedAt: formatTimestamp(row.updated_at)
  };
}

function mapSpaceRow(row: CloudSpaceRow): CloudControlPlaneSpace {
  return {
    id: row.id,
    ownerAccountId: row.owner_account_id,
    displayName: row.display_name,
    plan: row.plan,
    status: row.status,
    trialExpiresAt: formatNullableTimestamp(row.trial_expires_at),
    memberLimit: row.member_limit,
    runtimeSpaceId: row.runtime_space_id,
    runtimeServerUrl: row.runtime_server_url,
    roomCodeDisplayMetadata: row.room_code_display_metadata,
    requestedAt: formatTimestamp(row.requested_at),
    provisionedAt: formatNullableTimestamp(row.provisioned_at),
    suspendedAt: formatNullableTimestamp(row.suspended_at),
    suspensionReason: row.suspension_reason,
    deletedAt: formatNullableTimestamp(row.deleted_at),
    createdAt: formatTimestamp(row.created_at),
    updatedAt: formatTimestamp(row.updated_at)
  };
}

function mapFreePlanPolicyRow(
  row: CloudPlanPolicyRow
): CloudControlPlaneFreePlanPolicy {
  if (
    row.plan !== 'free' ||
    row.active !== true ||
    !Number.isInteger(row.trial_days) ||
    row.trial_days <= 0 ||
    !Number.isInteger(row.member_limit) ||
    row.member_limit <= 0 ||
    row.quota_mode !== 'one_lifetime_space'
  ) {
    throw new Error(
      'active free plan policy does not match Teamem Cloud policy constraints'
    );
  }

  return {
    id: row.id,
    plan: 'free',
    active: true,
    trialDays: row.trial_days,
    memberLimit: row.member_limit,
    quotaMode: 'one_lifetime_space',
    createdAt: formatTimestamp(row.created_at),
    updatedAt: formatTimestamp(row.updated_at)
  };
}

function mapFreePlanGrantRow(
  row: CloudFreePlanGrantRow
): CloudControlPlaneFreePlanGrant {
  return {
    id: row.id,
    accountId: row.account_id,
    policyId: row.policy_id,
    acceptedCloudSpaceId: row.accepted_cloud_space_id,
    grantedAt: formatTimestamp(row.granted_at),
    voidedAt: formatNullableTimestamp(row.voided_at),
    voidReason: row.void_reason,
    createdAt: formatTimestamp(row.created_at),
    updatedAt: formatTimestamp(row.updated_at)
  };
}

function formatNullableTimestamp(value: Date | string | null): string | null {
  return value === null ? null : formatTimestamp(value);
}

function formatTimestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function requireRow<Row>(rows: Row[], tableName: string): Row {
  const row = rows[0];
  if (!row) {
    throw new Error(`expected ${tableName} mutation to return a row`);
  }
  return row;
}

function isActiveFreeSpaceUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23505' &&
    'constraint' in error &&
    error.constraint === 'cloud_spaces_one_active_free_space_per_account'
  );
}

function isFreeTrialGrantUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23505' &&
    'constraint' in error &&
    error.constraint === 'cloud_free_plan_grants_one_non_voided_per_account'
  );
}

async function insertCloudSpaceWithClient(
  client: ControlPlaneSqlClient,
  space: CloudControlPlaneSpace
): Promise<{ rows: CloudSpaceRow[] }> {
  return client.query<CloudSpaceRow>(
    `
      INSERT INTO cloud_spaces (
        id,
        owner_account_id,
        display_name,
        plan,
        status,
        trial_expires_at,
        member_limit,
        runtime_space_id,
        runtime_server_url,
        room_code_display_metadata,
        requested_at,
        provisioned_at,
        suspended_at,
        suspension_reason,
        deleted_at,
        created_at,
        updated_at
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        $8,
        $9,
        $10::jsonb,
        $11,
        $12,
        $13,
        $14,
        $15,
        $16,
        $17
      )
      RETURNING *
    `,
    [
      space.id,
      space.ownerAccountId,
      space.displayName,
      space.plan,
      space.status,
      space.trialExpiresAt,
      space.memberLimit,
      space.runtimeSpaceId,
      space.runtimeServerUrl,
      JSON.stringify(space.roomCodeDisplayMetadata),
      space.requestedAt,
      space.provisionedAt,
      space.suspendedAt,
      space.suspensionReason,
      space.deletedAt,
      space.createdAt,
      space.updatedAt
    ]
  );
}

async function insertAuditEventWithClient(
  client: ControlPlaneSqlClient,
  event: CloudControlPlaneAuditEvent
): Promise<void> {
  await client.query(
    `
      INSERT INTO cloud_audit_events (
        id,
        account_id,
        cloud_space_id,
        event_type,
        metadata,
        created_at
      )
      VALUES ($1, $2, $3, $4, $5::jsonb, $6)
    `,
    [
      event.id,
      event.accountId,
      event.cloudSpaceId,
      event.eventType,
      JSON.stringify(event.metadata),
      event.createdAt
    ]
  );
}
