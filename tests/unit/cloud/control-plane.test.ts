import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  getCloudDashboardState,
  deleteCloudSpaceForOwner,
  overrideFreeCloudSpacePolicyForOperator,
  provisionFreeCloudSpace,
  requestFreeCloudSpace,
  rotateCloudRoomCodeForOwner,
  type CloudControlPlaneAccount,
  type CloudControlPlaneAuditEvent,
  type CloudControlPlaneFreePlanGrant,
  type CloudControlPlaneFreePlanPolicy,
  type CloudControlPlaneRepository,
  type CloudControlPlaneSpace,
  type CreateCloudSpaceInsertResult
} from '../../../src/cloud/control-plane.js';

const migrationSource = readFileSync(
  join(process.cwd(), 'apps/web/db/migrations/001_control_plane.sql'),
  'utf8'
);
const issue03MigrationSource = readFileSync(
  join(
    process.cwd(),
    'apps/web/db/migrations/003_issue03_cloud_space_policy_metadata.sql'
  ),
  'utf8'
);
const dashboardSource = readFileSync(
  join(process.cwd(), 'apps/web/app/[locale]/dashboard/page.tsx'),
  'utf8'
);
const controlPlaneServerSource = readFileSync(
  join(process.cwd(), 'apps/web/src/server/control-plane.ts'),
  'utf8'
);

describe('Teamem Cloud control plane schema and quota', () => {
  it('declares account, Space, audit, and active-free quota schema', () => {
    expect(migrationSource).toContain(
      'CREATE TABLE IF NOT EXISTS cloud_accounts'
    );
    expect(migrationSource).toContain(
      'CREATE TABLE IF NOT EXISTS cloud_spaces'
    );
    expect(migrationSource).toContain(
      'CREATE TABLE IF NOT EXISTS cloud_audit_events'
    );
    expect(migrationSource).toContain('cloud_space_create_succeeded');
    expect(migrationSource).toContain('cloud_space_create_failed');
    expect(migrationSource).toContain('cloud_space_suspended');
    expect(migrationSource).toContain('cloud_space_room_code_rotate_succeeded');
    expect(migrationSource).toContain('cloud_space_delete_attempted');
    expect(migrationSource).toContain('cloud_space_delete_succeeded');
    expect(migrationSource).toContain('cloud_space_delete_failed');
    expect(migrationSource).toContain('owner_account_id TEXT NOT NULL');
    expect(migrationSource).toContain('display_name TEXT NOT NULL');
    expect(migrationSource).toContain("plan IN ('free', 'team', 'enterprise')");
    expect(migrationSource).toContain('runtime_space_id TEXT');
    expect(migrationSource).toContain('runtime_server_url TEXT');
    expect(migrationSource).toContain('room_code_display_metadata JSONB');
    expect(migrationSource).toContain('trial_expires_at TIMESTAMPTZ');
    expect(migrationSource).toContain('member_limit INTEGER');
    expect(migrationSource).toContain('suspension_reason TEXT');
    expect(migrationSource).toContain('requested_at TIMESTAMPTZ NOT NULL');
    expect(migrationSource).toContain('provisioned_at TIMESTAMPTZ');
    expect(migrationSource).toContain('deleted_at TIMESTAMPTZ');
    expect(migrationSource).toContain(
      'cloud_spaces_one_active_free_space_per_account'
    );
    expect(migrationSource).toContain(
      'CREATE TABLE IF NOT EXISTS cloud_plan_policies'
    );
    expect(migrationSource).toContain(
      'CREATE TABLE IF NOT EXISTS cloud_free_plan_grants'
    );
    expect(migrationSource).toContain("'policy_free_trial_v1'");
    expect(migrationSource).toContain("'one_lifetime_space'");
    expect(migrationSource).toContain('14');
    expect(migrationSource).toContain('member_limit');
    expect(migrationSource).toContain(
      'cloud_free_plan_grants_one_non_voided_per_account'
    );
    expect(migrationSource).toContain("WHERE plan = 'free'");
    expect(migrationSource).toContain(
      "AND status IN ('provisioning_pending', 'active', 'delete_pending')"
    );
  });

  it('backfills non-failed free Spaces into idempotent free-plan grants', () => {
    expect(migrationSource).toContain('INSERT INTO cloud_free_plan_grants');
    expect(migrationSource).toContain("'fpg_backfill_' || ranked_spaces.id");
    expect(migrationSource).toContain("AND status <> 'provisioning_failed'");
    expect(migrationSource).toContain('ROW_NUMBER() OVER');
    expect(migrationSource).toContain('PARTITION BY owner_account_id');
    expect(migrationSource).toContain(
      'WHERE ranked_spaces.account_free_space_rank = 1'
    );
    expect(migrationSource).toContain('AND existing_grant.voided_at IS NULL');
    expect(migrationSource).toContain('ON CONFLICT DO NOTHING');
    expect(migrationSource).not.toContain(
      "AND status IN ('provisioning_pending', 'active', 'delete_pending')\n) AS ranked_spaces"
    );
  });

  it('migrates pre-issue03 cloud Spaces with policy metadata without consuming terminal failures', () => {
    const contract = parseIssue03ForwardMigration(issue03MigrationSource);
    expect(contract.alteredColumns).toEqual([
      'trial_expires_at',
      'member_limit',
      'suspension_reason'
    ]);
    expect(contract.backfillUsesPolicy).toBe(true);
    expect(contract.backfillExcludesStatus).toBe('provisioning_failed');

    const migrated = applyIssue03BackfillModel(
      [
        {
          id: 'space-active',
          plan: 'free',
          status: 'active',
          requestedAt: '2026-05-18T00:00:00.000Z',
          createdAt: '2026-05-17T00:00:00.000Z',
          trialExpiresAt: null,
          memberLimit: null
        },
        {
          id: 'space-suspended',
          plan: 'free',
          status: 'suspended',
          requestedAt: '2026-05-15T00:00:00.000Z',
          createdAt: '2026-05-14T00:00:00.000Z',
          trialExpiresAt: null,
          memberLimit: null
        },
        {
          id: 'space-deleted',
          plan: 'free',
          status: 'deleted',
          requestedAt: '2026-05-14T00:00:00.000Z',
          createdAt: '2026-05-13T00:00:00.000Z',
          trialExpiresAt: null,
          memberLimit: null
        },
        {
          id: 'space-failed',
          plan: 'free',
          status: 'provisioning_failed',
          requestedAt: '2026-05-18T00:00:00.000Z',
          createdAt: '2026-05-17T00:00:00.000Z',
          trialExpiresAt: null,
          memberLimit: null
        },
        {
          id: 'space-custom',
          plan: 'free',
          status: 'active',
          requestedAt: null,
          createdAt: '2026-05-17T00:00:00.000Z',
          trialExpiresAt: '2026-07-01T00:00:00.000Z',
          memberLimit: 9
        }
      ],
      { trialDays: 14, memberLimit: 3 }
    );

    expect(migrated.find((space) => space.id === 'space-active')).toMatchObject(
      {
        trialExpiresAt: '2026-06-01T00:00:00.000Z',
        memberLimit: 3
      }
    );
    expect(
      migrated.find((space) => space.id === 'space-suspended')
    ).toMatchObject({
      trialExpiresAt: '2026-05-29T00:00:00.000Z',
      memberLimit: 3
    });
    expect(
      migrated.find((space) => space.id === 'space-deleted')
    ).toMatchObject({
      trialExpiresAt: '2026-05-28T00:00:00.000Z',
      memberLimit: 3
    });
    expect(migrated.find((space) => space.id === 'space-failed')).toMatchObject(
      {
        trialExpiresAt: null,
        memberLimit: null
      }
    );
    expect(migrated.find((space) => space.id === 'space-custom')).toMatchObject(
      {
        trialExpiresAt: '2026-07-01T00:00:00.000Z',
        memberLimit: 9
      }
    );
  });

  it('keeps active free policy limits DB-configurable at runtime', () => {
    expect(controlPlaneServerSource).toContain('trialDays: row.trial_days');
    expect(controlPlaneServerSource).toContain('memberLimit: row.member_limit');
    expect(controlPlaneServerSource).toContain('row.quota_mode !==');
    expect(controlPlaneServerSource).not.toContain('row.trial_days !== 14');
    expect(controlPlaneServerSource).not.toContain('row.member_limit !== 3');
    expect(controlPlaneServerSource).not.toContain('trialDays: 14,');
    expect(controlPlaneServerSource).not.toContain('memberLimit: 3,');
  });

  it('writes create-attempt audit events and creates a pending control-plane record', async () => {
    const repository = new InMemoryControlPlaneRepository();
    const result = await requestFreeCloudSpace(
      repository,
      makeIds(),
      fixedClock,
      {
        betterAuthUserId: 'user-1',
        email: 'owner@example.com',
        accountDisplayName: 'Owner',
        spaceDisplayName: 'Launch Space'
      }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('expected create request to pass quota');
    }
    expect(result.space).toMatchObject({
      ownerAccountId: result.account.id,
      displayName: 'Launch Space',
      plan: 'free',
      status: 'provisioning_pending',
      trialExpiresAt: '2026-06-01T00:00:00.000Z',
      memberLimit: 3,
      runtimeSpaceId: null,
      runtimeServerUrl: null,
      roomCodeDisplayMetadata: {
        code: null,
        label: null,
        lastRotatedAt: null
      },
      suspendedAt: null,
      suspensionReason: null
    });
    expect(repository.auditEvents.map((event) => event.eventType)).toEqual([
      'cloud_space_create_attempted'
    ]);
    expect(repository.freePlanGrants).toHaveLength(1);
    expect(repository.freePlanGrants[0]).toMatchObject({
      accountId: result.account.id,
      acceptedCloudSpaceId: result.space.id,
      voidedAt: null
    });
    expect(controlPlaneServerSource).toContain('createFreeCloudSpaceGrant');
  });

  it('resolves the DB-configured active free plan policy before accepted requests', async () => {
    const repository = new InMemoryControlPlaneRepository();

    const result = await requestFreeCloudSpace(
      repository,
      makeIds(),
      fixedClock,
      {
        betterAuthUserId: 'user-1',
        email: 'owner@example.com',
        accountDisplayName: 'Owner',
        spaceDisplayName: 'Launch Space'
      }
    );

    expect(result.ok).toBe(true);
    expect(repository.resolvedFreePolicyCount).toBe(1);
    expect(repository.activeFreePlanPolicy).toMatchObject({
      plan: 'free',
      active: true,
      trialDays: 14,
      memberLimit: 3,
      quotaMode: 'one_lifetime_space'
    });
    expect(repository.freePlanGrants[0]).toMatchObject({
      policyId: repository.activeFreePlanPolicy.id
    });
  });

  it('keeps accepted Space, grant, and attempt audit atomic when the create transaction fails', async () => {
    const repository = new InMemoryControlPlaneRepository({
      failCreateGrant: true
    });

    await expect(
      requestFreeCloudSpace(repository, makeIds(), fixedClock, {
        betterAuthUserId: 'user-1',
        email: 'owner@example.com',
        accountDisplayName: 'Owner',
        spaceDisplayName: 'Launch Space'
      })
    ).rejects.toThrow('transaction failed');

    expect(repository.spaces).toHaveLength(0);
    expect(repository.freePlanGrants).toHaveLength(0);
    expect(repository.auditEvents).toHaveLength(0);
  });

  it('checks quota before calling runtime provisioning', async () => {
    const repository = new InMemoryControlPlaneRepository();
    await requestFreeCloudSpace(repository, makeIds(), fixedClock, {
      betterAuthUserId: 'user-1',
      email: 'owner@example.com',
      accountDisplayName: 'Owner',
      spaceDisplayName: 'Launch Space'
    });
    const runtimeCalls: unknown[] = [];

    const blocked = await provisionFreeCloudSpace(
      repository,
      makeIds(),
      fixedClock,
      {
        createSpace(input) {
          runtimeCalls.push(input);
          throw new Error('runtime should not be called');
        }
      },
      {
        betterAuthUserId: 'user-1',
        email: 'owner@example.com',
        accountDisplayName: 'Owner',
        spaceDisplayName: 'Second Space'
      }
    );

    expect(blocked).toMatchObject({
      ok: false,
      reason: 'active_free_space_exists'
    });
    expect(runtimeCalls).toHaveLength(0);
  });

  it('persists runtime details and success audit after provisioning succeeds', async () => {
    const repository = new InMemoryControlPlaneRepository();
    const runtimeCalls: unknown[] = [];

    const result = await provisionFreeCloudSpace(
      repository,
      makeIds(),
      fixedClock,
      {
        createSpace(input) {
          runtimeCalls.push(input);
          return Promise.resolve({
            controlPlaneSpaceId: input.controlPlaneSpaceId,
            runtimeSpaceId: 'runtime-space-1',
            runtimeServerUrl: 'https://runtime.teamem.test',
            label: input.label,
            roomCode: 'ABCD1234',
            status: 'active',
            correlation: {
              source: 'teamem-cloud',
              controlPlaneSpaceId: input.controlPlaneSpaceId,
              provisioningRequestId: input.provisioningRequestId
            }
          });
        }
      },
      {
        betterAuthUserId: 'user-1',
        email: 'owner@example.com',
        accountDisplayName: 'Owner',
        spaceDisplayName: 'Launch Space'
      }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('expected successful provisioning');
    }
    expect(result.space).toMatchObject({
      status: 'active',
      trialExpiresAt: '2026-06-01T00:00:00.000Z',
      memberLimit: 3,
      runtimeSpaceId: 'runtime-space-1',
      runtimeServerUrl: 'https://runtime.teamem.test',
      roomCodeDisplayMetadata: {
        code: 'ABCD1234',
        label: null,
        lastRotatedAt: fixedClock.now()
      },
      provisionedAt: fixedClock.now()
    });
    expect(runtimeCalls).toEqual([
      {
        label: 'Launch Space',
        idempotencyKey: result.space.id,
        controlPlaneSpaceId: result.space.id,
        provisioningRequestId: result.space.id,
        plan: 'free',
        trialExpiresAt: '2026-06-01T00:00:00.000Z',
        memberLimit: 3
      }
    ]);
    expect(repository.auditEvents.map((event) => event.eventType)).toEqual([
      'cloud_space_create_attempted',
      'cloud_space_create_succeeded'
    ]);
  });

  it('rotates room codes through the runtime and updates cached display metadata plus audit', async () => {
    const repository = new InMemoryControlPlaneRepository();
    const provisioned = await provisionFreeCloudSpace(
      repository,
      makeIds(),
      fixedClock,
      {
        createSpace(input) {
          return Promise.resolve({
            controlPlaneSpaceId: input.controlPlaneSpaceId,
            runtimeSpaceId: 'runtime-space-1',
            runtimeServerUrl: 'https://runtime.teamem.test',
            label: input.label,
            roomCode: 'OLD12345',
            status: 'active',
            correlation: {
              source: 'teamem-cloud',
              controlPlaneSpaceId: input.controlPlaneSpaceId,
              provisioningRequestId: input.provisioningRequestId
            }
          });
        }
      },
      {
        betterAuthUserId: 'user-1',
        email: 'owner@example.com',
        accountDisplayName: 'Owner',
        spaceDisplayName: 'Launch Space'
      }
    );
    if (!provisioned.ok) {
      throw new Error('expected provisioned Space');
    }

    const runtimeCalls: unknown[] = [];
    const rotated = await rotateCloudRoomCodeForOwner(
      repository,
      makeIds(),
      fixedClock,
      {
        rotateRoomCode(input) {
          runtimeCalls.push(input);
          return Promise.resolve({
            controlPlaneSpaceId: input.controlPlaneSpaceId,
            runtimeSpaceId: input.runtimeSpaceId,
            roomCode: 'NEW67890'
          });
        }
      },
      {
        betterAuthUserId: 'user-1',
        email: 'owner@example.com',
        displayName: 'Owner'
      }
    );

    expect(rotated.ok).toBe(true);
    if (!rotated.ok) {
      throw new Error('expected rotated Space');
    }
    expect(runtimeCalls).toEqual([
      {
        controlPlaneSpaceId: provisioned.space.id,
        runtimeSpaceId: 'runtime-space-1',
        idempotencyKey: `${provisioned.space.id}:room-code:OLD12345`
      }
    ]);
    expect(rotated.space.roomCodeDisplayMetadata).toEqual({
      code: 'NEW67890',
      label: null,
      lastRotatedAt: fixedClock.now()
    });
    expect(repository.auditEvents.map((event) => event.eventType)).toEqual([
      'cloud_space_create_attempted',
      'cloud_space_create_succeeded',
      'cloud_space_room_code_rotate_attempted',
      'cloud_space_room_code_rotate_succeeded'
    ]);
  });

  it('does not mutate cached room-code metadata when runtime rotation fails', async () => {
    const repository = new InMemoryControlPlaneRepository();
    const provisioned = await provisionFreeCloudSpace(
      repository,
      makeIds(),
      fixedClock,
      {
        createSpace(input) {
          return Promise.resolve({
            controlPlaneSpaceId: input.controlPlaneSpaceId,
            runtimeSpaceId: 'runtime-space-1',
            runtimeServerUrl: 'https://runtime.teamem.test',
            label: input.label,
            roomCode: 'OLD12345',
            status: 'active',
            correlation: {
              source: 'teamem-cloud',
              controlPlaneSpaceId: input.controlPlaneSpaceId,
              provisioningRequestId: input.provisioningRequestId
            }
          });
        }
      },
      {
        betterAuthUserId: 'user-1',
        email: 'owner@example.com',
        accountDisplayName: 'Owner',
        spaceDisplayName: 'Launch Space'
      }
    );
    if (!provisioned.ok) {
      throw new Error('expected provisioned Space');
    }

    const failed = await rotateCloudRoomCodeForOwner(
      repository,
      makeIds(),
      fixedClock,
      {
        rotateRoomCode() {
          return Promise.reject(new Error('runtime unavailable'));
        }
      },
      {
        betterAuthUserId: 'user-1',
        email: 'owner@example.com',
        displayName: 'Owner'
      }
    );

    expect(failed).toMatchObject({
      ok: false,
      reason: 'runtime_rotation_failed'
    });
    expect(repository.spaces[0]?.roomCodeDisplayMetadata).toEqual({
      code: 'OLD12345',
      label: null,
      lastRotatedAt: fixedClock.now()
    });
    expect(repository.auditEvents.map((event) => event.eventType)).toEqual([
      'cloud_space_create_attempted',
      'cloud_space_create_succeeded',
      'cloud_space_room_code_rotate_attempted',
      'cloud_space_room_code_rotate_failed'
    ]);
  });

  it('returns reconciliation status and failure audit when metadata update fails after runtime rotation', async () => {
    const repository = new InMemoryControlPlaneRepository({
      failUpdateRoomCodeDisplayMetadata: true
    });
    const provisioned = await provisionFreeCloudSpace(
      repository,
      makeIds(),
      fixedClock,
      {
        createSpace(input) {
          return Promise.resolve({
            controlPlaneSpaceId: input.controlPlaneSpaceId,
            runtimeSpaceId: 'runtime-space-1',
            runtimeServerUrl: 'https://runtime.teamem.test',
            label: input.label,
            roomCode: 'OLD12345',
            status: 'active',
            correlation: {
              source: 'teamem-cloud',
              controlPlaneSpaceId: input.controlPlaneSpaceId,
              provisioningRequestId: input.provisioningRequestId
            }
          });
        }
      },
      {
        betterAuthUserId: 'user-1',
        email: 'owner@example.com',
        accountDisplayName: 'Owner',
        spaceDisplayName: 'Launch Space'
      }
    );
    if (!provisioned.ok) {
      throw new Error('expected provisioned Space');
    }

    const failed = await rotateCloudRoomCodeForOwner(
      repository,
      makeIds(),
      fixedClock,
      {
        rotateRoomCode(input) {
          return Promise.resolve({
            controlPlaneSpaceId: input.controlPlaneSpaceId,
            runtimeSpaceId: input.runtimeSpaceId,
            roomCode: 'NEW67890'
          });
        }
      },
      {
        betterAuthUserId: 'user-1',
        email: 'owner@example.com',
        displayName: 'Owner'
      }
    );

    expect(failed).toMatchObject({
      ok: false,
      reason: 'control_plane_reconciliation_required',
      rotatedRoomCode: 'NEW67890'
    });
    expect(repository.spaces[0]?.roomCodeDisplayMetadata).toEqual({
      code: 'OLD12345',
      label: null,
      lastRotatedAt: fixedClock.now()
    });
    expect(repository.auditEvents.map((event) => event.eventType)).toEqual([
      'cloud_space_create_attempted',
      'cloud_space_create_succeeded',
      'cloud_space_room_code_rotate_attempted',
      'cloud_space_room_code_rotate_failed'
    ]);
    expect(repository.auditEvents[3]?.metadata).toMatchObject({
      reason: 'control_plane_reconciliation_required',
      runtimeSpaceId: 'runtime-space-1'
    });
  });

  it('rolls back room-code metadata and reuses the idempotency key when success audit fails after runtime rotation', async () => {
    const repository = new InMemoryControlPlaneRepository({
      failAuditEventType: 'cloud_space_room_code_rotate_succeeded'
    });
    const provisioned = await provisionFreeCloudSpace(
      repository,
      makeIds(),
      fixedClock,
      {
        createSpace(input) {
          return Promise.resolve({
            controlPlaneSpaceId: input.controlPlaneSpaceId,
            runtimeSpaceId: 'runtime-space-1',
            runtimeServerUrl: 'https://runtime.teamem.test',
            label: input.label,
            roomCode: 'OLD12345',
            status: 'active',
            correlation: {
              source: 'teamem-cloud',
              controlPlaneSpaceId: input.controlPlaneSpaceId,
              provisioningRequestId: input.provisioningRequestId
            }
          });
        }
      },
      {
        betterAuthUserId: 'user-1',
        email: 'owner@example.com',
        accountDisplayName: 'Owner',
        spaceDisplayName: 'Launch Space'
      }
    );
    if (!provisioned.ok) {
      throw new Error('expected provisioned Space');
    }

    const runtimeCalls: unknown[] = [];
    const failed = await rotateCloudRoomCodeForOwner(
      repository,
      makeIds(),
      fixedClock,
      {
        rotateRoomCode(input) {
          runtimeCalls.push(input);
          return Promise.resolve({
            controlPlaneSpaceId: input.controlPlaneSpaceId,
            runtimeSpaceId: input.runtimeSpaceId,
            roomCode: 'NEW67890'
          });
        }
      },
      {
        betterAuthUserId: 'user-1',
        email: 'owner@example.com',
        displayName: 'Owner'
      }
    );

    expect(failed).toMatchObject({
      ok: false,
      reason: 'control_plane_reconciliation_required',
      rotatedRoomCode: 'NEW67890'
    });
    expect(repository.spaces[0]?.roomCodeDisplayMetadata).toEqual({
      code: 'OLD12345',
      label: null,
      lastRotatedAt: fixedClock.now()
    });
    expect(repository.auditEvents.map((event) => event.eventType)).toEqual([
      'cloud_space_create_attempted',
      'cloud_space_create_succeeded',
      'cloud_space_room_code_rotate_attempted',
      'cloud_space_room_code_rotate_failed'
    ]);
    expect(repository.auditEvents[3]?.metadata).toMatchObject({
      reason: 'control_plane_reconciliation_required',
      runtimeSpaceId: 'runtime-space-1'
    });

    const retry = await rotateCloudRoomCodeForOwner(
      repository,
      makeIds(),
      fixedClock,
      {
        rotateRoomCode(input) {
          runtimeCalls.push(input);
          return Promise.resolve({
            controlPlaneSpaceId: input.controlPlaneSpaceId,
            runtimeSpaceId: input.runtimeSpaceId,
            roomCode: 'NEW67890'
          });
        }
      },
      {
        betterAuthUserId: 'user-1',
        email: 'owner@example.com',
        displayName: 'Owner'
      }
    );

    expect(retry).toMatchObject({
      ok: false,
      reason: 'control_plane_reconciliation_required',
      rotatedRoomCode: 'NEW67890'
    });
    expect(runtimeCalls).toEqual([
      {
        controlPlaneSpaceId: provisioned.space.id,
        runtimeSpaceId: 'runtime-space-1',
        idempotencyKey: `${provisioned.space.id}:room-code:OLD12345`
      },
      {
        controlPlaneSpaceId: provisioned.space.id,
        runtimeSpaceId: 'runtime-space-1',
        idempotencyKey: `${provisioned.space.id}:room-code:OLD12345`
      }
    ]);
  });

  it('soft-deletes through runtime while preserving the consumed free-trial grant', async () => {
    const repository = new InMemoryControlPlaneRepository();
    const provisioned = await provisionFreeCloudSpace(
      repository,
      makeIds(),
      fixedClock,
      {
        createSpace(input) {
          return Promise.resolve({
            controlPlaneSpaceId: input.controlPlaneSpaceId,
            runtimeSpaceId: 'runtime-space-1',
            runtimeServerUrl: 'https://runtime.teamem.test',
            label: input.label,
            roomCode: 'OLD12345',
            status: 'active',
            correlation: {
              source: 'teamem-cloud',
              controlPlaneSpaceId: input.controlPlaneSpaceId,
              provisioningRequestId: input.provisioningRequestId
            }
          });
        }
      },
      {
        betterAuthUserId: 'user-1',
        email: 'owner@example.com',
        accountDisplayName: 'Owner',
        spaceDisplayName: 'Launch Space'
      }
    );
    if (!provisioned.ok) {
      throw new Error('expected provisioned Space');
    }

    const runtimeCalls: unknown[] = [];
    const deleted = await deleteCloudSpaceForOwner(
      repository,
      makeIds(),
      fixedClock,
      {
        softDeleteSpace(input) {
          runtimeCalls.push(input);
          return Promise.resolve({
            controlPlaneSpaceId: input.controlPlaneSpaceId,
            runtimeSpaceId: input.runtimeSpaceId,
            status: 'soft_deleted',
            deletedAt: fixedClock.now()
          });
        }
      },
      {
        betterAuthUserId: 'user-1',
        email: 'owner@example.com',
        displayName: 'Owner',
        confirmationAccepted: true
      }
    );

    expect(deleted.ok).toBe(true);
    if (!deleted.ok) {
      throw new Error('expected deleted Space');
    }
    expect(runtimeCalls).toEqual([
      {
        controlPlaneSpaceId: provisioned.space.id,
        runtimeSpaceId: 'runtime-space-1',
        idempotencyKey: `${provisioned.space.id}:soft-delete:runtime-space-1`,
        reason: 'owner_requested'
      }
    ]);
    expect(deleted.space).toMatchObject({
      status: 'deleted',
      deletedAt: fixedClock.now()
    });
    expect(
      await repository.findActiveFreeSpaceForAccount('account-1')
    ).toBeNull();
    expect(
      await repository.findNonVoidedFreePlanGrantForAccount('account-1')
    ).toMatchObject({
      acceptedCloudSpaceId: provisioned.space.id,
      voidedAt: null
    });

    const retryCreate = await requestFreeCloudSpace(
      repository,
      makeIds(),
      fixedClock,
      {
        betterAuthUserId: 'user-1',
        email: 'owner@example.com',
        accountDisplayName: 'Owner',
        spaceDisplayName: 'Second Space'
      }
    );
    expect(retryCreate).toMatchObject({
      ok: false,
      reason: 'free_trial_already_used'
    });
    expect(repository.auditEvents.map((event) => event.eventType)).toEqual([
      'cloud_space_create_attempted',
      'cloud_space_create_succeeded',
      'cloud_space_delete_attempted',
      'cloud_space_delete_succeeded',
      'cloud_space_create_attempted',
      'cloud_space_create_quota_rejected'
    ]);
  });

  it('keeps free quota reserved while runtime soft-delete is pending or failed', async () => {
    const repository = new InMemoryControlPlaneRepository();
    const provisioned = await provisionFreeCloudSpace(
      repository,
      makeIds(),
      fixedClock,
      {
        createSpace(input) {
          return Promise.resolve({
            controlPlaneSpaceId: input.controlPlaneSpaceId,
            runtimeSpaceId: 'runtime-space-1',
            runtimeServerUrl: 'https://runtime.teamem.test',
            label: input.label,
            roomCode: 'OLD12345',
            status: 'active',
            correlation: {
              source: 'teamem-cloud',
              controlPlaneSpaceId: input.controlPlaneSpaceId,
              provisioningRequestId: input.provisioningRequestId
            }
          });
        }
      },
      {
        betterAuthUserId: 'user-1',
        email: 'owner@example.com',
        accountDisplayName: 'Owner',
        spaceDisplayName: 'Launch Space'
      }
    );
    if (!provisioned.ok) {
      throw new Error('expected provisioned Space');
    }

    const failed = await deleteCloudSpaceForOwner(
      repository,
      makeIds(),
      fixedClock,
      {
        softDeleteSpace() {
          return Promise.reject(new Error('runtime unavailable'));
        }
      },
      {
        betterAuthUserId: 'user-1',
        email: 'owner@example.com',
        displayName: 'Owner',
        confirmationAccepted: true
      }
    );

    expect(failed).toMatchObject({
      ok: false,
      reason: 'runtime_soft_delete_failed'
    });
    expect(repository.spaces[0]).toMatchObject({
      status: 'delete_pending'
    });
    expect(
      await repository.findActiveFreeSpaceForAccount('account-1')
    ).toMatchObject({
      status: 'delete_pending'
    });
    expect(
      await repository.findNonVoidedFreePlanGrantForAccount('account-1')
    ).toMatchObject({
      acceptedCloudSpaceId: provisioned.space.id,
      voidedAt: null
    });
    expect(repository.auditEvents.map((event) => event.eventType)).toEqual([
      'cloud_space_create_attempted',
      'cloud_space_create_succeeded',
      'cloud_space_delete_attempted',
      'cloud_space_delete_failed'
    ]);
  });

  it('keeps free quota reserved when delete success audit persistence fails', async () => {
    const repository = new InMemoryControlPlaneRepository({
      failAuditEventType: 'cloud_space_delete_succeeded'
    });
    const provisioned = await provisionFreeCloudSpace(
      repository,
      makeIds(),
      fixedClock,
      {
        createSpace(input) {
          return Promise.resolve({
            controlPlaneSpaceId: input.controlPlaneSpaceId,
            runtimeSpaceId: 'runtime-space-1',
            runtimeServerUrl: 'https://runtime.teamem.test',
            label: input.label,
            roomCode: 'OLD12345',
            status: 'active',
            correlation: {
              source: 'teamem-cloud',
              controlPlaneSpaceId: input.controlPlaneSpaceId,
              provisioningRequestId: input.provisioningRequestId
            }
          });
        }
      },
      {
        betterAuthUserId: 'user-1',
        email: 'owner@example.com',
        accountDisplayName: 'Owner',
        spaceDisplayName: 'Launch Space'
      }
    );
    if (!provisioned.ok) {
      throw new Error('expected provisioned Space');
    }

    const failed = await deleteCloudSpaceForOwner(
      repository,
      makeIds(),
      fixedClock,
      {
        softDeleteSpace(input) {
          return Promise.resolve({
            controlPlaneSpaceId: input.controlPlaneSpaceId,
            runtimeSpaceId: input.runtimeSpaceId,
            status: 'soft_deleted',
            deletedAt: fixedClock.now()
          });
        }
      },
      {
        betterAuthUserId: 'user-1',
        email: 'owner@example.com',
        displayName: 'Owner',
        confirmationAccepted: true
      }
    );

    expect(failed).toMatchObject({
      ok: false,
      reason: 'control_plane_reconciliation_required'
    });
    expect(repository.spaces[0]).toMatchObject({
      status: 'delete_pending',
      deletedAt: null
    });
    expect(
      await repository.findActiveFreeSpaceForAccount('account-1')
    ).toMatchObject({
      status: 'delete_pending'
    });
    expect(repository.auditEvents.map((event) => event.eventType)).toEqual([
      'cloud_space_create_attempted',
      'cloud_space_create_succeeded',
      'cloud_space_delete_attempted',
      'cloud_space_delete_failed'
    ]);
    expect(repository.auditEvents[3]?.metadata).toMatchObject({
      reason: 'control_plane_reconciliation_required',
      runtimeSpaceId: 'runtime-space-1'
    });
  });

  it('requires explicit dashboard confirmation before attempting runtime deletion', async () => {
    const repository = new InMemoryControlPlaneRepository();
    const runtimeCalls: unknown[] = [];

    const failed = await deleteCloudSpaceForOwner(
      repository,
      makeIds(),
      fixedClock,
      {
        softDeleteSpace(input) {
          runtimeCalls.push(input);
          throw new Error('runtime should not be called');
        }
      },
      {
        betterAuthUserId: 'user-1',
        email: 'owner@example.com',
        displayName: 'Owner',
        confirmationAccepted: false
      }
    );

    expect(failed).toMatchObject({
      ok: false,
      reason: 'confirmation_required'
    });
    expect(runtimeCalls).toHaveLength(0);
    expect(dashboardSource).toContain('name="confirmDelete"');
    expect(dashboardSource).toContain('deleteSpaceAction');
    expect(dashboardSource).not.toContain('hardDelete');
  });

  it('propagates operator free-trial overrides through runtime before updating the control plane', async () => {
    const repository = new InMemoryControlPlaneRepository();
    const provisioned = await provisionFreeCloudSpace(
      repository,
      makeIds(),
      fixedClock,
      {
        createSpace(input) {
          return Promise.resolve({
            controlPlaneSpaceId: input.controlPlaneSpaceId,
            runtimeSpaceId: 'runtime-space-1',
            runtimeServerUrl: 'https://runtime.teamem.test',
            label: input.label,
            roomCode: 'OLD12345',
            status: 'active',
            correlation: {
              source: 'teamem-cloud',
              controlPlaneSpaceId: input.controlPlaneSpaceId,
              provisioningRequestId: input.provisioningRequestId
            }
          });
        }
      },
      {
        betterAuthUserId: 'user-1',
        email: 'owner@example.com',
        accountDisplayName: 'Owner',
        spaceDisplayName: 'Launch Space'
      }
    );
    if (!provisioned.ok) {
      throw new Error('expected provisioned Space');
    }

    const runtimeCalls: unknown[] = [];
    const result = await overrideFreeCloudSpacePolicyForOperator(
      repository,
      makeIds(),
      fixedClock,
      {
        updateSpaceRuntimePolicy(input) {
          runtimeCalls.push(input);
          return Promise.resolve({
            controlPlaneSpaceId: input.controlPlaneSpaceId,
            runtimeSpaceId: input.runtimeSpaceId,
            trialExpiresAt: input.trialExpiresAt,
            memberLimit: input.memberLimit
          });
        }
      },
      {
        cloudSpaceId: provisioned.space.id,
        trialExpiresAt: '2026-07-01T00:00:00.000Z',
        memberLimit: 5
      }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('expected policy override to propagate');
    }
    expect(runtimeCalls).toEqual([
      {
        controlPlaneSpaceId: provisioned.space.id,
        runtimeSpaceId: 'runtime-space-1',
        trialExpiresAt: '2026-07-01T00:00:00.000Z',
        memberLimit: 5
      }
    ]);
    expect(result.space).toMatchObject({
      trialExpiresAt: '2026-07-01T00:00:00.000Z',
      memberLimit: 5
    });
    expect(repository.auditEvents.map((event) => event.eventType)).toEqual([
      'cloud_space_create_attempted',
      'cloud_space_create_succeeded',
      'cloud_space_policy_override_attempted',
      'cloud_space_policy_override_succeeded'
    ]);
  });

  it('does not treat a control-plane-only operator override as complete when runtime propagation fails', async () => {
    const repository = new InMemoryControlPlaneRepository();
    const provisioned = await provisionFreeCloudSpace(
      repository,
      makeIds(),
      fixedClock,
      {
        createSpace(input) {
          return Promise.resolve({
            controlPlaneSpaceId: input.controlPlaneSpaceId,
            runtimeSpaceId: 'runtime-space-1',
            runtimeServerUrl: 'https://runtime.teamem.test',
            label: input.label,
            roomCode: 'OLD12345',
            status: 'active',
            correlation: {
              source: 'teamem-cloud',
              controlPlaneSpaceId: input.controlPlaneSpaceId,
              provisioningRequestId: input.provisioningRequestId
            }
          });
        }
      },
      {
        betterAuthUserId: 'user-1',
        email: 'owner@example.com',
        accountDisplayName: 'Owner',
        spaceDisplayName: 'Launch Space'
      }
    );
    if (!provisioned.ok) {
      throw new Error('expected provisioned Space');
    }

    const result = await overrideFreeCloudSpacePolicyForOperator(
      repository,
      makeIds(),
      fixedClock,
      {
        updateSpaceRuntimePolicy() {
          return Promise.reject(new Error('runtime unavailable'));
        }
      },
      {
        cloudSpaceId: provisioned.space.id,
        trialExpiresAt: '2026-07-01T00:00:00.000Z',
        memberLimit: 5
      }
    );

    expect(result).toMatchObject({
      ok: false,
      reason: 'runtime_policy_update_failed'
    });
    expect(repository.spaces[0]).toMatchObject({
      trialExpiresAt: '2026-06-01T00:00:00.000Z',
      memberLimit: 3
    });
    expect(repository.auditEvents.map((event) => event.eventType)).toEqual([
      'cloud_space_create_attempted',
      'cloud_space_create_succeeded',
      'cloud_space_policy_override_attempted',
      'cloud_space_policy_override_failed'
    ]);
  });

  it('audits authenticated display-name validation failures before returning', async () => {
    const repository = new InMemoryControlPlaneRepository();

    const failed = await provisionFreeCloudSpace(
      repository,
      makeIds(),
      fixedClock,
      {
        createSpace() {
          throw new Error('runtime should not be called');
        }
      },
      {
        betterAuthUserId: 'user-1',
        email: 'owner@example.com',
        accountDisplayName: 'Owner',
        spaceDisplayName: '   '
      }
    );

    expect(failed).toEqual({
      ok: false,
      reason: 'display_name_required'
    });
    expect([...repository.accounts.values()]).toHaveLength(1);
    expect(repository.spaces).toHaveLength(0);
    expect(repository.auditEvents.map((event) => event.eventType)).toEqual([
      'cloud_space_create_attempted',
      'cloud_space_create_failed'
    ]);
    expect(repository.auditEvents[1]?.metadata).toMatchObject({
      reason: 'display_name_required'
    });
  });

  it('keeps ambiguous runtime create failures pending so quota and idempotency are preserved', async () => {
    const repository = new InMemoryControlPlaneRepository();

    const failed = await provisionFreeCloudSpace(
      repository,
      makeIds(),
      fixedClock,
      {
        createSpace() {
          return Promise.reject(new Error('runtime unavailable'));
        }
      },
      {
        betterAuthUserId: 'user-1',
        email: 'owner@example.com',
        accountDisplayName: 'Owner',
        spaceDisplayName: 'Launch Space'
      }
    );

    expect(failed).toMatchObject({
      ok: false,
      reason: 'control_plane_reconciliation_required'
    });
    expect(repository.spaces[0]).toMatchObject({
      status: 'provisioning_pending',
      runtimeSpaceId: null,
      runtimeServerUrl: null
    });
    expect(
      await repository.findActiveFreeSpaceForAccount('account-1')
    ).toMatchObject({
      id: repository.spaces[0]?.id,
      status: 'provisioning_pending'
    });
    expect(repository.auditEvents.map((event) => event.eventType)).toEqual([
      'cloud_space_create_attempted',
      'cloud_space_create_failed'
    ]);
    expect(repository.auditEvents[1]?.metadata).toMatchObject({
      reason: 'control_plane_reconciliation_required'
    });
  });

  it('voids the free trial grant when runtime returns terminal provisioning failure', async () => {
    const repository = new InMemoryControlPlaneRepository();

    const failed = await provisionFreeCloudSpace(
      repository,
      makeIds(),
      fixedClock,
      {
        createSpace(input) {
          return Promise.resolve({
            controlPlaneSpaceId: input.controlPlaneSpaceId,
            status: 'provisioning_failed',
            reason: 'capacity_unavailable',
            correlation: {
              source: 'teamem-cloud',
              controlPlaneSpaceId: input.controlPlaneSpaceId,
              provisioningRequestId: input.provisioningRequestId
            }
          });
        }
      },
      {
        betterAuthUserId: 'user-1',
        email: 'owner@example.com',
        accountDisplayName: 'Owner',
        spaceDisplayName: 'Launch Space'
      }
    );

    expect(failed).toMatchObject({
      ok: false,
      reason: 'runtime_provisioning_failed'
    });
    expect(repository.spaces[0]).toMatchObject({
      status: 'provisioning_failed'
    });
    expect(repository.freePlanGrants[0]).toMatchObject({
      voidedAt: fixedClock.now(),
      voidReason: 'capacity_unavailable'
    });
    expect(
      await repository.findNonVoidedFreePlanGrantForAccount('account-1')
    ).toBeNull();
    expect(repository.auditEvents.map((event) => event.eventType)).toEqual([
      'cloud_space_create_attempted',
      'cloud_space_create_failed'
    ]);
    expect(repository.auditEvents[1]?.metadata).toMatchObject({
      reason: 'runtime_provisioning_failed',
      runtimeReason: 'capacity_unavailable'
    });

    const retry = await requestFreeCloudSpace(
      repository,
      makeIds(),
      fixedClock,
      {
        betterAuthUserId: 'user-1',
        email: 'owner@example.com',
        accountDisplayName: 'Owner',
        spaceDisplayName: 'Retry Space'
      }
    );
    expect(retry.ok).toBe(true);
  });

  it('retries ambiguous committed runtime creates with the same control-plane Space and idempotency key', async () => {
    const repository = new InMemoryControlPlaneRepository();
    const runtimeCalls: unknown[] = [];
    let committedRuntime = false;

    const first = await provisionFreeCloudSpace(
      repository,
      makeIds(),
      fixedClock,
      {
        createSpace(input) {
          runtimeCalls.push(input);
          committedRuntime = true;
          return Promise.reject(new Error('response lost after commit'));
        }
      },
      {
        betterAuthUserId: 'user-1',
        email: 'owner@example.com',
        accountDisplayName: 'Owner',
        spaceDisplayName: 'Launch Space'
      }
    );

    expect(first).toMatchObject({
      ok: false,
      reason: 'control_plane_reconciliation_required'
    });
    expect(committedRuntime).toBe(true);
    const pendingSpace = repository.spaces[0];
    expect(pendingSpace).toMatchObject({
      status: 'provisioning_pending'
    });
    expect(pendingSpace?.id).toBeTruthy();

    const retry = await provisionFreeCloudSpace(
      repository,
      makeIds(),
      fixedClock,
      {
        createSpace(input) {
          runtimeCalls.push(input);
          return Promise.resolve({
            controlPlaneSpaceId: input.controlPlaneSpaceId,
            runtimeSpaceId: 'runtime-space-1',
            runtimeServerUrl: 'https://runtime.teamem.test',
            label: input.label,
            roomCode: 'ABCD1234',
            status: 'active',
            correlation: {
              source: 'teamem-cloud',
              controlPlaneSpaceId: input.controlPlaneSpaceId,
              provisioningRequestId: input.provisioningRequestId
            }
          });
        }
      },
      {
        betterAuthUserId: 'user-1',
        email: 'owner@example.com',
        accountDisplayName: 'Owner',
        spaceDisplayName: 'Launch Space'
      }
    );

    expect(retry.ok).toBe(true);
    if (!retry.ok) {
      throw new Error('expected retry to reconcile existing pending Space');
    }
    expect(repository.spaces).toHaveLength(1);
    expect(retry.space.id).toBe(pendingSpace?.id);
    expect(runtimeCalls).toEqual([
      {
        label: 'Launch Space',
        idempotencyKey: pendingSpace?.id,
        controlPlaneSpaceId: pendingSpace?.id,
        provisioningRequestId: pendingSpace?.id,
        plan: 'free',
        trialExpiresAt: '2026-06-01T00:00:00.000Z',
        memberLimit: 3
      },
      {
        label: 'Launch Space',
        idempotencyKey: pendingSpace?.id,
        controlPlaneSpaceId: pendingSpace?.id,
        provisioningRequestId: pendingSpace?.id,
        plan: 'free',
        trialExpiresAt: '2026-06-01T00:00:00.000Z',
        memberLimit: 3
      }
    ]);
    expect(retry.space).toMatchObject({
      status: 'active',
      runtimeSpaceId: 'runtime-space-1',
      runtimeServerUrl: 'https://runtime.teamem.test'
    });
  });

  it('keeps quota reserved when runtime create returns mismatched correlation', async () => {
    const repository = new InMemoryControlPlaneRepository();

    const failed = await provisionFreeCloudSpace(
      repository,
      makeIds(),
      fixedClock,
      {
        createSpace(input) {
          return Promise.resolve({
            controlPlaneSpaceId: input.controlPlaneSpaceId,
            runtimeSpaceId: 'runtime-space-1',
            runtimeServerUrl: 'https://runtime.teamem.test',
            label: input.label,
            roomCode: 'ABCD1234',
            status: 'active',
            correlation: {
              source: 'teamem-cloud',
              controlPlaneSpaceId: 'different-space',
              provisioningRequestId: input.provisioningRequestId
            }
          });
        }
      },
      {
        betterAuthUserId: 'user-1',
        email: 'owner@example.com',
        accountDisplayName: 'Owner',
        spaceDisplayName: 'Launch Space'
      }
    );

    expect(failed).toMatchObject({
      ok: false,
      reason: 'control_plane_reconciliation_required'
    });
    expect(repository.spaces[0]).toMatchObject({
      status: 'provisioning_pending',
      runtimeSpaceId: null,
      runtimeServerUrl: null
    });
    expect(
      await repository.findActiveFreeSpaceForAccount('account-1')
    ).toMatchObject({
      status: 'provisioning_pending'
    });
    expect(repository.auditEvents.map((event) => event.eventType)).toEqual([
      'cloud_space_create_attempted',
      'cloud_space_create_failed'
    ]);
    expect(repository.auditEvents[1]?.metadata).toMatchObject({
      reason: 'control_plane_reconciliation_required',
      message: 'runtime provisioning response did not match request'
    });
  });

  it('reuses room-code rotation idempotency key across non-terminal retries', async () => {
    const repository = new InMemoryControlPlaneRepository();
    const provisioned = await provisionFreeCloudSpace(
      repository,
      makeIds(),
      fixedClock,
      {
        createSpace(input) {
          return Promise.resolve({
            controlPlaneSpaceId: input.controlPlaneSpaceId,
            runtimeSpaceId: 'runtime-space-1',
            runtimeServerUrl: 'https://runtime.teamem.test',
            label: input.label,
            roomCode: 'OLD12345',
            status: 'active',
            correlation: {
              source: 'teamem-cloud',
              controlPlaneSpaceId: input.controlPlaneSpaceId,
              provisioningRequestId: input.provisioningRequestId
            }
          });
        }
      },
      {
        betterAuthUserId: 'user-1',
        email: 'owner@example.com',
        accountDisplayName: 'Owner',
        spaceDisplayName: 'Launch Space'
      }
    );
    if (!provisioned.ok) {
      throw new Error('expected provisioned Space');
    }

    const runtimeCalls: unknown[] = [];
    const retryClock = makeSequenceClock([
      '2026-05-18T00:00:01.000Z',
      '2026-05-18T00:00:02.000Z',
      '2026-05-18T00:00:03.000Z',
      '2026-05-18T00:00:04.000Z'
    ]);
    for (let attempt = 0; attempt < 2; attempt++) {
      const failed = await rotateCloudRoomCodeForOwner(
        repository,
        makeIds(),
        retryClock,
        {
          rotateRoomCode(input) {
            runtimeCalls.push(input);
            return Promise.reject(new Error('runtime unavailable'));
          }
        },
        {
          betterAuthUserId: 'user-1',
          email: 'owner@example.com',
          displayName: 'Owner'
        }
      );
      expect(failed).toMatchObject({
        ok: false,
        reason: 'runtime_rotation_failed'
      });
    }

    expect(runtimeCalls).toEqual([
      {
        controlPlaneSpaceId: provisioned.space.id,
        runtimeSpaceId: 'runtime-space-1',
        idempotencyKey: `${provisioned.space.id}:room-code:OLD12345`
      },
      {
        controlPlaneSpaceId: provisioned.space.id,
        runtimeSpaceId: 'runtime-space-1',
        idempotencyKey: `${provisioned.space.id}:room-code:OLD12345`
      }
    ]);
  });

  it('reuses soft-delete idempotency key across non-terminal retries', async () => {
    const repository = new InMemoryControlPlaneRepository();
    const provisioned = await provisionFreeCloudSpace(
      repository,
      makeIds(),
      fixedClock,
      {
        createSpace(input) {
          return Promise.resolve({
            controlPlaneSpaceId: input.controlPlaneSpaceId,
            runtimeSpaceId: 'runtime-space-1',
            runtimeServerUrl: 'https://runtime.teamem.test',
            label: input.label,
            roomCode: 'OLD12345',
            status: 'active',
            correlation: {
              source: 'teamem-cloud',
              controlPlaneSpaceId: input.controlPlaneSpaceId,
              provisioningRequestId: input.provisioningRequestId
            }
          });
        }
      },
      {
        betterAuthUserId: 'user-1',
        email: 'owner@example.com',
        accountDisplayName: 'Owner',
        spaceDisplayName: 'Launch Space'
      }
    );
    if (!provisioned.ok) {
      throw new Error('expected provisioned Space');
    }

    const runtimeCalls: unknown[] = [];
    const retryClock = makeSequenceClock([
      '2026-05-18T00:00:01.000Z',
      '2026-05-18T00:00:02.000Z',
      '2026-05-18T00:00:03.000Z',
      '2026-05-18T00:00:04.000Z'
    ]);
    for (let attempt = 0; attempt < 2; attempt++) {
      const failed = await deleteCloudSpaceForOwner(
        repository,
        makeIds(),
        retryClock,
        {
          softDeleteSpace(input) {
            runtimeCalls.push(input);
            return Promise.reject(new Error('runtime unavailable'));
          }
        },
        {
          betterAuthUserId: 'user-1',
          email: 'owner@example.com',
          displayName: 'Owner',
          confirmationAccepted: true
        }
      );
      expect(failed).toMatchObject({
        ok: false,
        reason: 'runtime_soft_delete_failed'
      });
    }

    expect(runtimeCalls).toEqual([
      {
        controlPlaneSpaceId: provisioned.space.id,
        runtimeSpaceId: 'runtime-space-1',
        idempotencyKey: `${provisioned.space.id}:soft-delete:runtime-space-1`,
        reason: 'owner_requested'
      },
      {
        controlPlaneSpaceId: provisioned.space.id,
        runtimeSpaceId: 'runtime-space-1',
        idempotencyKey: `${provisioned.space.id}:soft-delete:runtime-space-1`,
        reason: 'owner_requested'
      }
    ]);
  });

  it('does not release quota when control-plane persistence fails after runtime creation', async () => {
    const repository = new InMemoryControlPlaneRepository({
      failMarkProvisioned: true
    });

    await expect(
      provisionFreeCloudSpace(
        repository,
        makeIds(),
        fixedClock,
        {
          createSpace(input) {
            return Promise.resolve({
              controlPlaneSpaceId: input.controlPlaneSpaceId,
              runtimeSpaceId: 'runtime-space-1',
              runtimeServerUrl: 'https://runtime.teamem.test',
              label: input.label,
              roomCode: 'ABCD1234',
              status: 'active',
              correlation: {
                source: 'teamem-cloud',
                controlPlaneSpaceId: input.controlPlaneSpaceId,
                provisioningRequestId: input.provisioningRequestId
              }
            });
          }
        },
        {
          betterAuthUserId: 'user-1',
          email: 'owner@example.com',
          accountDisplayName: 'Owner',
          spaceDisplayName: 'Launch Space'
        }
      )
    ).rejects.toThrow('mark provisioned failed');

    expect(repository.failedMarkProvisioningFailedCalls).toBe(0);
    expect(repository.spaces[0]).toMatchObject({
      status: 'provisioning_pending',
      runtimeSpaceId: null,
      runtimeServerUrl: null
    });
    expect(
      await repository.findActiveFreeSpaceForAccount('account-1')
    ).toMatchObject({
      status: 'provisioning_pending'
    });
    expect(repository.auditEvents.map((event) => event.eventType)).toEqual([
      'cloud_space_create_attempted'
    ]);
  });

  it('does not release quota when success audit fails after runtime creation', async () => {
    const repository = new InMemoryControlPlaneRepository({
      failAuditEventType: 'cloud_space_create_succeeded'
    });

    await expect(
      provisionFreeCloudSpace(
        repository,
        makeIds(),
        fixedClock,
        {
          createSpace(input) {
            return Promise.resolve({
              controlPlaneSpaceId: input.controlPlaneSpaceId,
              runtimeSpaceId: 'runtime-space-1',
              runtimeServerUrl: 'https://runtime.teamem.test',
              label: input.label,
              roomCode: 'ABCD1234',
              status: 'active',
              correlation: {
                source: 'teamem-cloud',
                controlPlaneSpaceId: input.controlPlaneSpaceId,
                provisioningRequestId: input.provisioningRequestId
              }
            });
          }
        },
        {
          betterAuthUserId: 'user-1',
          email: 'owner@example.com',
          accountDisplayName: 'Owner',
          spaceDisplayName: 'Launch Space'
        }
      )
    ).rejects.toThrow('audit failed');

    expect(repository.failedMarkProvisioningFailedCalls).toBe(0);
    expect(repository.spaces[0]).toMatchObject({
      status: 'active',
      runtimeSpaceId: 'runtime-space-1',
      runtimeServerUrl: 'https://runtime.teamem.test'
    });
    expect(
      await repository.findActiveFreeSpaceForAccount('account-1')
    ).toMatchObject({
      status: 'active'
    });
    expect(repository.auditEvents.map((event) => event.eventType)).toEqual([
      'cloud_space_create_attempted'
    ]);
  });

  it('blocks concurrent active-free insert conflicts before runtime provisioning', async () => {
    const repository = new InMemoryControlPlaneRepository({
      forceUniqueConflict: true
    });
    const runtimeCalls: unknown[] = [];

    const blocked = await provisionFreeCloudSpace(
      repository,
      makeIds(),
      fixedClock,
      {
        createSpace(input) {
          runtimeCalls.push(input);
          throw new Error('runtime should not be called');
        }
      },
      {
        betterAuthUserId: 'user-1',
        email: 'owner@example.com',
        accountDisplayName: 'Owner',
        spaceDisplayName: 'Launch Space'
      }
    );

    expect(blocked).toMatchObject({
      ok: false,
      reason: 'active_free_space_exists'
    });
    expect(runtimeCalls).toHaveLength(0);
    expect(repository.auditEvents.map((event) => event.eventType)).toEqual([
      'cloud_space_create_attempted',
      'cloud_space_create_quota_rejected'
    ]);
  });

  it('enforces one active free Space per account before insert and audits quota rejection', async () => {
    const repository = new InMemoryControlPlaneRepository();

    await requestFreeCloudSpace(repository, makeIds(), fixedClock, {
      betterAuthUserId: 'user-1',
      email: 'owner@example.com',
      accountDisplayName: 'Owner',
      spaceDisplayName: 'Launch Space'
    });
    const blocked = await requestFreeCloudSpace(
      repository,
      makeIds(),
      fixedClock,
      {
        betterAuthUserId: 'user-1',
        email: 'owner@example.com',
        accountDisplayName: 'Owner',
        spaceDisplayName: 'Second Space'
      }
    );

    expect(blocked).toMatchObject({
      ok: false,
      reason: 'active_free_space_exists'
    });
    expect(repository.spaces).toHaveLength(1);
    expect(repository.auditEvents.map((event) => event.eventType)).toEqual([
      'cloud_space_create_attempted',
      'cloud_space_create_attempted',
      'cloud_space_create_quota_rejected'
    ]);
  });

  it('handles database-level active-free uniqueness conflicts as quota rejections', async () => {
    const repository = new InMemoryControlPlaneRepository({
      forceUniqueConflict: true
    });
    const blocked = await requestFreeCloudSpace(
      repository,
      makeIds(),
      fixedClock,
      {
        betterAuthUserId: 'user-1',
        email: 'owner@example.com',
        accountDisplayName: 'Owner',
        spaceDisplayName: 'Launch Space'
      }
    );

    expect(blocked).toMatchObject({
      ok: false,
      reason: 'active_free_space_exists'
    });
    expect(repository.auditEvents.map((event) => event.eventType)).toEqual([
      'cloud_space_create_attempted',
      'cloud_space_create_quota_rejected'
    ]);
  });

  it('rejects create attempts after a non-voided free trial grant has been used', async () => {
    const repository = new InMemoryControlPlaneRepository();
    const created = await requestFreeCloudSpace(
      repository,
      makeIds(),
      fixedClock,
      {
        betterAuthUserId: 'user-1',
        email: 'owner@example.com',
        accountDisplayName: 'Owner',
        spaceDisplayName: 'Launch Space'
      }
    );
    if (!created.ok) {
      throw new Error('expected first request to create Space');
    }
    repository.spaces[0] = {
      ...created.space,
      status: 'deleted',
      deletedAt: fixedClock.now(),
      updatedAt: fixedClock.now()
    };

    const blocked = await requestFreeCloudSpace(
      repository,
      makeIds(),
      fixedClock,
      {
        betterAuthUserId: 'user-1',
        email: 'owner@example.com',
        accountDisplayName: 'Owner',
        spaceDisplayName: 'Second Space'
      }
    );

    expect(blocked).toMatchObject({
      ok: false,
      reason: 'free_trial_already_used'
    });
    expect(repository.spaces).toHaveLength(1);
    expect(repository.auditEvents.map((event) => event.eventType)).toEqual([
      'cloud_space_create_attempted',
      'cloud_space_create_attempted',
      'cloud_space_create_quota_rejected'
    ]);
    expect(repository.auditEvents[2]?.metadata).toMatchObject({
      reason: 'free_trial_already_used'
    });
  });

  it('builds dashboard no-Space, existing-Space, and quota-blocked branches from control-plane data', async () => {
    const repository = new InMemoryControlPlaneRepository();
    const empty = await getCloudDashboardState(
      repository,
      makeIds(),
      fixedClock,
      {
        betterAuthUserId: 'user-1',
        email: 'owner@example.com',
        displayName: 'Owner'
      }
    );

    expect(empty.kind).toBe('no-space');
    expect(dashboardSource).toContain('NoSpaceState');
    expect(dashboardSource).toContain('ExistingSpaceState');
    expect(dashboardSource).toContain('QuotaBlockedState');
    expect(dashboardSource).toContain('getDashboardStateForUser');

    await requestFreeCloudSpace(repository, makeIds(), fixedClock, {
      betterAuthUserId: 'user-1',
      email: 'owner@example.com',
      accountDisplayName: 'Owner',
      spaceDisplayName: 'Launch Space'
    });
    const existing = await getCloudDashboardState(
      repository,
      makeIds(),
      fixedClock,
      {
        betterAuthUserId: 'user-1',
        email: 'owner@example.com',
        displayName: 'Owner'
      }
    );

    expect(existing.kind).toBe('existing-space');
    if (existing.kind !== 'existing-space') {
      throw new Error('expected existing Space state');
    }
    expect(existing.quota).toEqual({
      canCreateFreeSpace: false,
      blockedReason: 'active_free_space_exists'
    });

    repository.spaces[0] = {
      ...existing.space,
      status: 'deleted',
      deletedAt: fixedClock.now(),
      updatedAt: fixedClock.now()
    };
    const consumed = await getCloudDashboardState(
      repository,
      makeIds(),
      fixedClock,
      {
        betterAuthUserId: 'user-1',
        email: 'owner@example.com',
        displayName: 'Owner'
      }
    );

    expect(consumed.kind).toBe('free-trial-consumed');
    if (consumed.kind !== 'free-trial-consumed') {
      throw new Error('expected consumed free trial state');
    }
    expect(consumed.quota).toEqual({
      canCreateFreeSpace: false,
      blockedReason: 'free_trial_already_used'
    });
    expect(dashboardSource).toContain('FreeTrialConsumedState');
    expect(dashboardSource).toContain("state.kind === 'free-trial-consumed'");
  });

  it('keeps renderable non-deleted Space states visible instead of showing consumed trial', async () => {
    for (const status of [
      'suspended',
      'provisioning_pending',
      'delete_pending',
      'provisioning_failed'
    ] as const) {
      const repository = new InMemoryControlPlaneRepository();
      const created = await requestFreeCloudSpace(
        repository,
        makeIds(),
        fixedClock,
        {
          betterAuthUserId: 'user-1',
          email: 'owner@example.com',
          accountDisplayName: 'Owner',
          spaceDisplayName: 'Launch Space'
        }
      );
      if (!created.ok) {
        throw new Error('expected first request to create Space');
      }
      repository.spaces[0] = {
        ...created.space,
        status,
        updatedAt: fixedClock.now()
      };

      const state = await getCloudDashboardState(
        repository,
        makeIds(),
        fixedClock,
        {
          betterAuthUserId: 'user-1',
          email: 'owner@example.com',
          displayName: 'Owner'
        }
      );

      expect(state.kind).toBe('existing-space');
      if (state.kind !== 'existing-space') {
        throw new Error(`expected existing Space state for ${status}`);
      }
      expect(state.space.status).toBe(status);
    }
  });

  it('lazily suspends expired free Spaces from dashboard state and writes one suspension audit', async () => {
    const repository = new InMemoryControlPlaneRepository();
    const created = await requestFreeCloudSpace(
      repository,
      makeIds(),
      fixedClock,
      {
        betterAuthUserId: 'user-1',
        email: 'owner@example.com',
        accountDisplayName: 'Owner',
        spaceDisplayName: 'Launch Space'
      }
    );
    if (!created.ok) {
      throw new Error('expected first request to create Space');
    }
    repository.spaces[0] = {
      ...created.space,
      status: 'active',
      runtimeSpaceId: 'runtime-1',
      runtimeServerUrl: 'https://runtime.teamem.test',
      trialExpiresAt: '2026-05-01T00:00:00.000Z',
      updatedAt: fixedClock.now()
    };
    repository.auditEvents = [];

    const first = await getCloudDashboardState(
      repository,
      makeIds(),
      fixedClock,
      {
        betterAuthUserId: 'user-1',
        email: 'owner@example.com',
        displayName: 'Owner'
      }
    );
    const second = await getCloudDashboardState(
      repository,
      makeIds(),
      fixedClock,
      {
        betterAuthUserId: 'user-1',
        email: 'owner@example.com',
        displayName: 'Owner'
      }
    );

    expect(first.kind).toBe('existing-space');
    expect(second.kind).toBe('existing-space');
    if (first.kind !== 'existing-space' || second.kind !== 'existing-space') {
      throw new Error('expected suspended Space to remain visible');
    }
    expect(first.space).toMatchObject({
      status: 'suspended',
      suspendedAt: fixedClock.now(),
      suspensionReason: 'free_trial_expired'
    });
    expect(second.space).toMatchObject(first.space);
    expect(repository.auditEvents.map((event) => event.eventType)).toEqual([
      'cloud_space_suspended'
    ]);
    expect(repository.auditEvents[0]?.metadata).toMatchObject({
      reason: 'free_trial_expired',
      trialExpiresAt: '2026-05-01T00:00:00.000Z'
    });
  });
});

type Issue03ForwardMigrationContract = {
  alteredColumns: string[];
  backfillUsesPolicy: boolean;
  backfillExcludesStatus: string | null;
};

type LegacyCloudSpaceRow = {
  id: string;
  plan: string;
  status: string;
  requestedAt: string | null;
  createdAt: string;
  trialExpiresAt: string | null;
  memberLimit: number | null;
};

function parseIssue03ForwardMigration(
  sql: string
): Issue03ForwardMigrationContract {
  const alteredColumns = Array.from(
    sql.matchAll(/ADD COLUMN IF NOT EXISTS\s+([a-z_]+)/g),
    (match) => match[1]!
  );
  const updateStatement = sql.match(
    /UPDATE cloud_spaces[\s\S]+?WHERE cloud_spaces\.plan = 'free'[\s\S]+?;/
  )?.[0];
  if (!updateStatement) {
    throw new Error('missing cloud_spaces policy metadata backfill statement');
  }

  return {
    alteredColumns,
    backfillUsesPolicy:
      /\bFROM\s+\([\s\S]+FROM cloud_plan_policies[\s\S]+active = TRUE[\s\S]+LIMIT 1[\s\S]+\) AS active_free_policy/.test(
        updateStatement
      ) &&
      /trial_expires_at = COALESCE\([\s\S]+active_free_policy\.trial_days \* INTERVAL '1 day'/.test(
        updateStatement
      ) &&
      /member_limit = COALESCE\([\s\S]+active_free_policy\.member_limit/.test(
        updateStatement
      ),
    backfillExcludesStatus:
      updateStatement.match(/cloud_spaces\.status <> '([^']+)'/)?.[1] ?? null
  };
}

function applyIssue03BackfillModel(
  rows: LegacyCloudSpaceRow[],
  activeFreePolicy: { trialDays: number; memberLimit: number }
): LegacyCloudSpaceRow[] {
  return rows.map((row) => {
    if (
      row.plan !== 'free' ||
      row.status === 'provisioning_failed' ||
      (row.trialExpiresAt !== null && row.memberLimit !== null)
    ) {
      return row;
    }

    const trialStart = row.requestedAt ?? row.createdAt;
    const trialExpiresAt =
      row.trialExpiresAt ??
      new Date(
        new Date(trialStart).getTime() +
          activeFreePolicy.trialDays * 24 * 60 * 60 * 1000
      ).toISOString();

    return {
      ...row,
      trialExpiresAt,
      memberLimit: row.memberLimit ?? activeFreePolicy.memberLimit
    };
  });
}

const fixedClock = {
  now: () => '2026-05-18T00:00:00.000Z'
};

function makeSequenceClock(values: string[]) {
  let index = 0;
  return {
    now: () => values[index++] ?? values[values.length - 1]!
  };
}

function makeIds() {
  let next = 0;
  return {
    accountId: () => `account-${++next}`,
    spaceId: () => `space-${++next}`,
    freePlanGrantId: () => `grant-${++next}`,
    auditEventId: () => `audit-${++next}`
  };
}

class InMemoryControlPlaneRepository implements CloudControlPlaneRepository {
  accounts = new Map<string, CloudControlPlaneAccount>();
  spaces: CloudControlPlaneSpace[] = [];
  freePlanGrants: CloudControlPlaneFreePlanGrant[] = [];
  auditEvents: CloudControlPlaneAuditEvent[] = [];
  failedMarkProvisioningFailedCalls = 0;
  resolvedFreePolicyCount = 0;
  activeFreePlanPolicy: CloudControlPlaneFreePlanPolicy = {
    id: 'policy-free-test',
    plan: 'free',
    active: true,
    trialDays: 14,
    memberLimit: 3,
    quotaMode: 'one_lifetime_space',
    createdAt: fixedClock.now(),
    updatedAt: fixedClock.now()
  };

  constructor(
    private readonly options?: {
      forceUniqueConflict?: boolean;
      forceGrantUniqueConflict?: boolean;
      failCreateGrant?: boolean;
      failMarkProvisioned?: boolean;
      failMarkDeletePending?: boolean;
      failMarkDeleted?: boolean;
      failUpdateResolvedPolicy?: boolean;
      failUpdateRoomCodeDisplayMetadata?: boolean;
      failAuditEventType?: CloudControlPlaneAuditEvent['eventType'];
    }
  ) {}

  async ensureAccount(input: {
    id: string;
    betterAuthUserId: string;
    email: string | null;
    displayName: string | null;
    now: string;
  }): Promise<CloudControlPlaneAccount> {
    const existing = [...this.accounts.values()].find(
      (account) => account.betterAuthUserId === input.betterAuthUserId
    );
    const account = {
      id: existing?.id ?? input.id,
      betterAuthUserId: input.betterAuthUserId,
      email: input.email,
      displayName: input.displayName,
      createdAt: existing?.createdAt ?? input.now,
      updatedAt: input.now
    };
    this.accounts.set(account.id, account);
    return account;
  }

  async resolveActiveFreePlanPolicy(): Promise<CloudControlPlaneFreePlanPolicy> {
    this.resolvedFreePolicyCount += 1;
    return this.activeFreePlanPolicy;
  }

  async findPrimarySpaceForAccount(
    accountId: string
  ): Promise<CloudControlPlaneSpace | null> {
    return (
      this.spaces.find(
        (space) =>
          space.ownerAccountId === accountId && space.status !== 'deleted'
      ) ?? null
    );
  }

  async findCloudSpaceById(
    spaceId: string
  ): Promise<CloudControlPlaneSpace | null> {
    return this.spaces.find((space) => space.id === spaceId) ?? null;
  }

  async findActiveFreeSpaceForAccount(
    accountId: string
  ): Promise<CloudControlPlaneSpace | null> {
    return (
      this.spaces.find(
        (space) =>
          space.ownerAccountId === accountId &&
          space.plan === 'free' &&
          ['provisioning_pending', 'active', 'delete_pending'].includes(
            space.status
          )
      ) ?? null
    );
  }

  async findNonVoidedFreePlanGrantForAccount(
    accountId: string
  ): Promise<CloudControlPlaneFreePlanGrant | null> {
    return (
      this.freePlanGrants.find(
        (grant) => grant.accountId === accountId && grant.voidedAt === null
      ) ?? null
    );
  }

  async insertCloudSpace(
    space: CloudControlPlaneSpace
  ): Promise<CreateCloudSpaceInsertResult> {
    if (
      this.options?.forceUniqueConflict ||
      (await this.findActiveFreeSpaceForAccount(space.ownerAccountId))
    ) {
      return { ok: false, reason: 'active_free_space_exists' };
    }

    this.spaces.push(space);
    return { ok: true, space };
  }

  async createFreeCloudSpaceGrant(input: {
    space: CloudControlPlaneSpace;
    grant: CloudControlPlaneFreePlanGrant;
    attemptAuditEvent: CloudControlPlaneAuditEvent;
  }): Promise<CreateCloudSpaceInsertResult> {
    if (this.options?.failCreateGrant) {
      throw new Error('transaction failed');
    }
    if (
      this.options?.forceUniqueConflict ||
      (await this.findActiveFreeSpaceForAccount(input.space.ownerAccountId))
    ) {
      return { ok: false, reason: 'active_free_space_exists' };
    }
    if (
      this.options?.forceGrantUniqueConflict ||
      (await this.findNonVoidedFreePlanGrantForAccount(input.grant.accountId))
    ) {
      return { ok: false, reason: 'free_trial_already_used' };
    }

    this.spaces.push(input.space);
    this.freePlanGrants.push(input.grant);
    this.auditEvents.push(input.attemptAuditEvent);
    return { ok: true, space: input.space };
  }

  async markCloudSpaceProvisioned(input: {
    spaceId: string;
    runtimeSpaceId: string;
    runtimeServerUrl: string;
    roomCodeDisplayMetadata: CloudControlPlaneSpace['roomCodeDisplayMetadata'];
    now: string;
  }): Promise<CloudControlPlaneSpace> {
    if (this.options?.failMarkProvisioned) {
      throw new Error('mark provisioned failed');
    }

    return this.updateSpace(input.spaceId, {
      status: 'active',
      runtimeSpaceId: input.runtimeSpaceId,
      runtimeServerUrl: input.runtimeServerUrl,
      roomCodeDisplayMetadata: input.roomCodeDisplayMetadata,
      provisionedAt: input.now,
      updatedAt: input.now
    });
  }

  async markCloudSpaceProvisioningFailed(input: {
    spaceId: string;
    now: string;
  }): Promise<CloudControlPlaneSpace> {
    this.failedMarkProvisioningFailedCalls += 1;
    return this.updateSpace(input.spaceId, {
      status: 'provisioning_failed',
      updatedAt: input.now
    });
  }

  async markCloudSpaceProvisioningFailedAndVoidGrant(input: {
    spaceId: string;
    now: string;
    voidReason: string;
    failureAuditEvent: CloudControlPlaneAuditEvent;
  }): Promise<CloudControlPlaneSpace> {
    this.failedMarkProvisioningFailedCalls += 1;
    const space = this.updateSpace(input.spaceId, {
      status: 'provisioning_failed',
      updatedAt: input.now
    });
    const grantIndex = this.freePlanGrants.findIndex(
      (grant) =>
        grant.acceptedCloudSpaceId === input.spaceId && grant.voidedAt === null
    );
    if (grantIndex !== -1) {
      this.freePlanGrants[grantIndex] = {
        ...this.freePlanGrants[grantIndex]!,
        voidedAt: input.now,
        voidReason: input.voidReason,
        updatedAt: input.now
      };
    }
    this.auditEvents.push(input.failureAuditEvent);
    return space;
  }

  async markCloudSpaceDeletePending(input: {
    spaceId: string;
    now: string;
  }): Promise<CloudControlPlaneSpace> {
    if (this.options?.failMarkDeletePending) {
      throw new Error('mark delete pending failed');
    }

    return this.updateSpace(input.spaceId, {
      status: 'delete_pending',
      updatedAt: input.now
    });
  }

  async markExpiredFreeCloudSpaceSuspended(input: {
    spaceId: string;
    suspendedAt: string;
    now: string;
    suspensionAuditEvent: CloudControlPlaneAuditEvent;
  }): Promise<CloudControlPlaneSpace> {
    const existing = this.spaces.find((space) => space.id === input.spaceId);
    if (!existing) {
      throw new Error(`missing test Space ${input.spaceId}`);
    }
    if (existing.status === 'suspended') {
      return existing;
    }

    const space = this.updateSpace(input.spaceId, {
      status: 'suspended',
      suspendedAt: input.suspendedAt,
      suspensionReason: 'free_trial_expired',
      updatedAt: input.now
    });
    this.auditEvents.push(input.suspensionAuditEvent);
    return space;
  }

  async markCloudSpaceDeletedWithAudit(input: {
    spaceId: string;
    deletedAt: string;
    now: string;
    successAuditEvent: CloudControlPlaneAuditEvent;
  }): Promise<CloudControlPlaneSpace> {
    if (this.options?.failMarkDeleted) {
      throw new Error('mark deleted failed');
    }
    if (
      this.options?.failAuditEventType === input.successAuditEvent.eventType
    ) {
      throw new Error('audit failed');
    }

    const space = this.updateSpace(input.spaceId, {
      status: 'deleted',
      deletedAt: input.deletedAt,
      updatedAt: input.now
    });
    this.auditEvents.push(input.successAuditEvent);
    return space;
  }

  async updateRoomCodeDisplayMetadataWithAudit(input: {
    spaceId: string;
    roomCodeDisplayMetadata: CloudControlPlaneSpace['roomCodeDisplayMetadata'];
    now: string;
    successAuditEvent: CloudControlPlaneAuditEvent;
  }): Promise<CloudControlPlaneSpace> {
    if (this.options?.failUpdateRoomCodeDisplayMetadata) {
      throw new Error('metadata update failed');
    }
    if (
      this.options?.failAuditEventType === input.successAuditEvent.eventType
    ) {
      throw new Error('audit failed');
    }

    const space = this.updateSpace(input.spaceId, {
      roomCodeDisplayMetadata: input.roomCodeDisplayMetadata,
      updatedAt: input.now
    });
    this.auditEvents.push(input.successAuditEvent);
    return space;
  }

  async updateCloudSpaceResolvedPolicyWithAudit(input: {
    spaceId: string;
    trialExpiresAt: string;
    memberLimit: number;
    now: string;
    successAuditEvent: CloudControlPlaneAuditEvent;
  }): Promise<CloudControlPlaneSpace> {
    if (this.options?.failUpdateResolvedPolicy) {
      throw new Error('policy update failed');
    }
    if (
      this.options?.failAuditEventType === input.successAuditEvent.eventType
    ) {
      throw new Error('audit failed');
    }

    const existing = await this.findCloudSpaceById(input.spaceId);
    const shouldUnsuspend =
      existing?.status === 'suspended' &&
      existing.suspensionReason === 'free_trial_expired' &&
      new Date(input.trialExpiresAt) > new Date(input.now);
    const space = this.updateSpace(input.spaceId, {
      trialExpiresAt: input.trialExpiresAt,
      memberLimit: input.memberLimit,
      ...(shouldUnsuspend
        ? {
            status: 'active' as const,
            suspendedAt: null,
            suspensionReason: null
          }
        : {}),
      updatedAt: input.now
    });
    this.auditEvents.push(input.successAuditEvent);
    return space;
  }

  async appendAuditEvent(event: CloudControlPlaneAuditEvent): Promise<void> {
    if (this.options?.failAuditEventType === event.eventType) {
      throw new Error('audit failed');
    }

    this.auditEvents.push(event);
  }

  private updateSpace(
    spaceId: string,
    patch: Partial<CloudControlPlaneSpace>
  ): CloudControlPlaneSpace {
    const index = this.spaces.findIndex((space) => space.id === spaceId);
    if (index === -1) {
      throw new Error(`missing test Space ${spaceId}`);
    }
    const space = { ...this.spaces[index], ...patch };
    this.spaces[index] = space;
    return space;
  }
}
