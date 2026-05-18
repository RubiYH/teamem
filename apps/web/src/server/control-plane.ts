import 'server-only';

import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type {
  CloudControlPlaneAccount,
  CloudControlPlaneAccountInput,
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
              runtime_space_id,
              runtime_server_url,
              room_code_display_metadata,
              requested_at,
              provisioned_at,
              suspended_at,
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
              $8::jsonb,
              $9,
              $10,
              $11,
              $12,
              $13,
              $14
            )
            RETURNING *
          `,
          [
            space.id,
            space.ownerAccountId,
            space.displayName,
            space.plan,
            space.status,
            space.runtimeSpaceId,
            space.runtimeServerUrl,
            JSON.stringify(space.roomCodeDisplayMetadata),
            space.requestedAt,
            space.provisionedAt,
            space.suspendedAt,
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
  room_code_display_metadata: CloudRoomCodeDisplayMetadata;
  requested_at: Date | string;
  provisioned_at: Date | string | null;
  suspended_at: Date | string | null;
  deleted_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
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
    runtimeSpaceId: row.runtime_space_id,
    runtimeServerUrl: row.runtime_server_url,
    roomCodeDisplayMetadata: row.room_code_display_metadata,
    requestedAt: formatTimestamp(row.requested_at),
    provisionedAt: formatNullableTimestamp(row.provisioned_at),
    suspendedAt: formatNullableTimestamp(row.suspended_at),
    deletedAt: formatNullableTimestamp(row.deleted_at),
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
