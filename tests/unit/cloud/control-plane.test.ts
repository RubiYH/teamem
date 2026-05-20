import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  getCloudDashboardState,
  deleteCloudSpaceForOwner,
  provisionFreeCloudSpace,
  requestFreeCloudSpace,
  rotateCloudRoomCodeForOwner,
  type CloudControlPlaneAccount,
  type CloudControlPlaneAuditEvent,
  type CloudControlPlaneRepository,
  type CloudControlPlaneSpace,
  type CreateCloudSpaceInsertResult
} from '../../../src/cloud/control-plane.js';

const migrationSource = readFileSync(
  join(process.cwd(), 'apps/web/db/migrations/001_control_plane.sql'),
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
    expect(migrationSource).toContain('requested_at TIMESTAMPTZ NOT NULL');
    expect(migrationSource).toContain('provisioned_at TIMESTAMPTZ');
    expect(migrationSource).toContain('deleted_at TIMESTAMPTZ');
    expect(migrationSource).toContain(
      'cloud_spaces_one_active_free_space_per_account'
    );
    expect(migrationSource).toContain("WHERE plan = 'free'");
    expect(migrationSource).toContain(
      "AND status IN ('provisioning_pending', 'active', 'delete_pending')"
    );
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
      runtimeSpaceId: null,
      runtimeServerUrl: null,
      roomCodeDisplayMetadata: {
        code: null,
        label: null,
        lastRotatedAt: null
      }
    });
    expect(repository.auditEvents.map((event) => event.eventType)).toEqual([
      'cloud_space_create_attempted'
    ]);
    expect(controlPlaneServerSource).toContain('insertCloudSpace(space)');
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

    const result = await provisionFreeCloudSpace(
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
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('expected successful provisioning');
    }
    expect(result.space).toMatchObject({
      status: 'active',
      runtimeSpaceId: 'runtime-space-1',
      runtimeServerUrl: 'https://runtime.teamem.test',
      roomCodeDisplayMetadata: {
        code: 'ABCD1234',
        label: null,
        lastRotatedAt: fixedClock.now()
      },
      provisionedAt: fixedClock.now()
    });
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

  it('soft-deletes through runtime before marking the control-plane Space deleted and freeing quota', async () => {
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
    expect(repository.auditEvents.map((event) => event.eventType)).toEqual([
      'cloud_space_create_attempted',
      'cloud_space_create_succeeded',
      'cloud_space_delete_attempted',
      'cloud_space_delete_succeeded'
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
        provisioningRequestId: pendingSpace?.id
      },
      {
        label: 'Launch Space',
        idempotencyKey: pendingSpace?.id,
        controlPlaneSpaceId: pendingSpace?.id,
        provisioningRequestId: pendingSpace?.id
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
  });
});

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
    auditEventId: () => `audit-${++next}`
  };
}

class InMemoryControlPlaneRepository implements CloudControlPlaneRepository {
  accounts = new Map<string, CloudControlPlaneAccount>();
  spaces: CloudControlPlaneSpace[] = [];
  auditEvents: CloudControlPlaneAuditEvent[] = [];
  failedMarkProvisioningFailedCalls = 0;

  constructor(
    private readonly options?: {
      forceUniqueConflict?: boolean;
      failMarkProvisioned?: boolean;
      failMarkDeletePending?: boolean;
      failMarkDeleted?: boolean;
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
