import { describe, expect, it } from 'bun:test';
import { createHttpRuntimeAdminProvisioningClient } from '../../../src/cloud/runtime-admin-client.js';
import {
  CLOUD_ADMIN_AUTH_HEADER,
  CLOUD_ADMIN_AUTH_SCHEME,
  CLOUD_ADMIN_ENDPOINTS,
  CLOUD_ADMIN_HTTP_METHODS
} from '../../../src/cloud/runtime-admin-contract.js';

describe('runtime admin provisioning client', () => {
  it('calls the runtime admin create operation through the shared contract', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const client = createHttpRuntimeAdminProvisioningClient({
      runtimeUrl: 'https://runtime.teamem.test',
      provisioningToken: 'runtime-token',
      fetchImpl: ((url, init) => {
        requests.push({ url: String(url), init });
        return Promise.resolve(
          Response.json(
            {
              controlPlaneSpaceId: 'csp-1',
              runtimeSpaceId: 'runtime-1',
              runtimeServerUrl: 'https://runtime.teamem.test',
              label: 'Launch Space',
              roomCode: 'ABCD1234',
              status: 'active',
              correlation: {
                source: 'teamem-cloud',
                controlPlaneSpaceId: 'csp-1',
                provisioningRequestId: 'csp-1'
              }
            },
            { status: 201 }
          )
        );
      }) as typeof fetch
    });

    const result = await client.createSpace({
      label: 'Launch Space',
      idempotencyKey: 'csp-1',
      controlPlaneSpaceId: 'csp-1',
      provisioningRequestId: 'csp-1',
      plan: 'free',
      trialExpiresAt: '2026-06-01T00:00:00.000Z',
      memberLimit: 3
    });

    expect(result).toMatchObject({
      status: 'active',
      runtimeSpaceId: 'runtime-1'
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      `https://runtime.teamem.test${CLOUD_ADMIN_ENDPOINTS.createSpace}`
    );
    expect(requests[0]?.init?.method).toBe(
      CLOUD_ADMIN_HTTP_METHODS.createSpace
    );
    expect(requests[0]?.init?.headers).toMatchObject({
      'Content-Type': 'application/json',
      [CLOUD_ADMIN_AUTH_HEADER]: `${CLOUD_ADMIN_AUTH_SCHEME} runtime-token`
    });
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      label: 'Launch Space',
      idempotencyKey: 'csp-1',
      controlPlaneSpaceId: 'csp-1',
      provisioningRequestId: 'csp-1',
      plan: 'free',
      trialExpiresAt: '2026-06-01T00:00:00.000Z',
      memberLimit: 3
    });
  });

  it('throws on runtime admin failures without returning a provisioned Space', async () => {
    const client = createHttpRuntimeAdminProvisioningClient({
      runtimeUrl: 'https://runtime.teamem.test',
      provisioningToken: 'runtime-token',
      fetchImpl: (() =>
        Promise.resolve(
          Response.json({ error: 'unavailable' }, { status: 503 })
        )) as unknown as typeof fetch
    });

    await expect(
      client.createSpace({
        label: 'Launch Space',
        idempotencyKey: 'csp-1',
        controlPlaneSpaceId: 'csp-1',
        provisioningRequestId: 'csp-1',
        plan: 'free',
        trialExpiresAt: '2026-06-01T00:00:00.000Z',
        memberLimit: 3
      })
    ).rejects.toThrow('runtime admin create failed: HTTP 503');
  });

  it('returns terminal provisioning failure payloads from runtime admin create', async () => {
    const client = createHttpRuntimeAdminProvisioningClient({
      runtimeUrl: 'https://runtime.teamem.test',
      provisioningToken: 'runtime-token',
      fetchImpl: (() =>
        Promise.resolve(
          Response.json(
            {
              controlPlaneSpaceId: 'csp-1',
              status: 'provisioning_failed',
              reason: 'capacity_unavailable',
              correlation: {
                source: 'teamem-cloud',
                controlPlaneSpaceId: 'csp-1',
                provisioningRequestId: 'csp-1'
              }
            },
            { status: 201 }
          )
        )) as unknown as typeof fetch
    });

    const result = await client.createSpace({
      label: 'Launch Space',
      idempotencyKey: 'csp-1',
      controlPlaneSpaceId: 'csp-1',
      provisioningRequestId: 'csp-1',
      plan: 'free',
      trialExpiresAt: '2026-06-01T00:00:00.000Z',
      memberLimit: 3
    });

    expect(result).toEqual({
      controlPlaneSpaceId: 'csp-1',
      status: 'provisioning_failed',
      reason: 'capacity_unavailable',
      correlation: {
        source: 'teamem-cloud',
        controlPlaneSpaceId: 'csp-1',
        provisioningRequestId: 'csp-1'
      }
    });
  });

  it('calls runtime admin room-code rotation instead of generating a local code', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const client = createHttpRuntimeAdminProvisioningClient({
      runtimeUrl: 'https://runtime.teamem.test',
      provisioningToken: 'runtime-token',
      fetchImpl: ((url, init) => {
        requests.push({ url: String(url), init });
        return Promise.resolve(
          Response.json({
            controlPlaneSpaceId: 'csp-1',
            runtimeSpaceId: 'runtime-1',
            roomCode: 'RUNTIME9'
          })
        );
      }) as typeof fetch
    });

    const result = await client.rotateRoomCode({
      controlPlaneSpaceId: 'csp-1',
      runtimeSpaceId: 'runtime-1',
      idempotencyKey: 'rotate-1'
    });

    expect(result.roomCode).toBe('RUNTIME9');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      'https://runtime.teamem.test/cloud-admin/v1/spaces/runtime-1/room-code'
    );
    expect(requests[0]?.init?.method).toBe(
      CLOUD_ADMIN_HTTP_METHODS.rotateRoomCode
    );
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      controlPlaneSpaceId: 'csp-1',
      runtimeSpaceId: 'runtime-1',
      idempotencyKey: 'rotate-1'
    });
  });

  it('fetches runtime status through the shared cloud-admin contract', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const client = createHttpRuntimeAdminProvisioningClient({
      runtimeUrl: 'https://runtime.teamem.test',
      provisioningToken: 'runtime-token',
      fetchImpl: ((url, init) => {
        requests.push({ url: String(url), init });
        return Promise.resolve(
          Response.json({
            controlPlaneSpaceId: 'csp-1',
            runtimeSpaceId: 'runtime-1',
            plan: 'free',
            trialExpiresAt: '2026-06-01T00:00:00.000Z',
            memberLimit: 3,
            activeUserFacingMemberCount: 2,
            suspendedAt: null,
            suspensionReason: null,
            setupAvailable: true,
            controlsAvailable: true
          })
        );
      }) as typeof fetch
    });

    const result = await client.getSpaceRuntimeStatus({
      controlPlaneSpaceId: 'csp-1',
      runtimeSpaceId: 'runtime-1'
    });

    expect(result).toMatchObject({
      activeUserFacingMemberCount: 2,
      memberLimit: 3,
      setupAvailable: true,
      controlsAvailable: true
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      'https://runtime.teamem.test/cloud-admin/v1/spaces/runtime-1/status?controlPlaneSpaceId=csp-1'
    );
    expect(requests[0]?.init?.method).toBe(
      CLOUD_ADMIN_HTTP_METHODS.spaceStatus
    );
    expect(requests[0]?.init?.headers).toMatchObject({
      [CLOUD_ADMIN_AUTH_HEADER]: `${CLOUD_ADMIN_AUTH_SCHEME} runtime-token`
    });
  });

  it('throws when runtime status returns space IDs that do not match the request', async () => {
    const client = createHttpRuntimeAdminProvisioningClient({
      runtimeUrl: 'https://runtime.teamem.test',
      provisioningToken: 'runtime-token',
      fetchImpl: (() =>
        Promise.resolve(
          Response.json({
            controlPlaneSpaceId: 'csp-other',
            runtimeSpaceId: 'runtime-other',
            plan: 'free',
            trialExpiresAt: '2026-06-01T00:00:00.000Z',
            memberLimit: 3,
            activeUserFacingMemberCount: 2,
            suspendedAt: null,
            suspensionReason: null,
            setupAvailable: true,
            controlsAvailable: true
          })
        )) as unknown as typeof fetch
    });

    await expect(
      client.getSpaceRuntimeStatus({
        controlPlaneSpaceId: 'csp-1',
        runtimeSpaceId: 'runtime-1'
      })
    ).rejects.toThrow('runtime admin status returned mismatched space IDs');
  });

  it('updates runtime policy through the shared cloud-admin contract', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const client = createHttpRuntimeAdminProvisioningClient({
      runtimeUrl: 'https://runtime.teamem.test',
      provisioningToken: 'runtime-token',
      fetchImpl: ((url, init) => {
        requests.push({ url: String(url), init });
        return Promise.resolve(
          Response.json({
            controlPlaneSpaceId: 'csp-1',
            runtimeSpaceId: 'runtime-1',
            plan: 'free',
            trialExpiresAt: '2026-07-01T00:00:00.000Z',
            memberLimit: 5,
            activeUserFacingMemberCount: 2,
            suspendedAt: null,
            suspensionReason: null,
            setupAvailable: true,
            controlsAvailable: true
          })
        );
      }) as typeof fetch
    });

    const result = await client.updateSpaceRuntimePolicy({
      controlPlaneSpaceId: 'csp-1',
      runtimeSpaceId: 'runtime-1',
      trialExpiresAt: '2026-07-01T00:00:00.000Z',
      memberLimit: 5
    });

    expect(result).toMatchObject({
      trialExpiresAt: '2026-07-01T00:00:00.000Z',
      memberLimit: 5
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      'https://runtime.teamem.test/cloud-admin/v1/spaces/runtime-1/policy'
    );
    expect(requests[0]?.init?.method).toBe(
      CLOUD_ADMIN_HTTP_METHODS.updateSpacePolicy
    );
    expect(requests[0]?.init?.headers).toMatchObject({
      'Content-Type': 'application/json',
      [CLOUD_ADMIN_AUTH_HEADER]: `${CLOUD_ADMIN_AUTH_SCHEME} runtime-token`
    });
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      controlPlaneSpaceId: 'csp-1',
      runtimeSpaceId: 'runtime-1',
      trialExpiresAt: '2026-07-01T00:00:00.000Z',
      memberLimit: 5
    });
  });

  it('rejects runtime policy update responses that do not reflect the override', async () => {
    const client = createHttpRuntimeAdminProvisioningClient({
      runtimeUrl: 'https://runtime.teamem.test',
      provisioningToken: 'runtime-token',
      fetchImpl: (() =>
        Promise.resolve(
          Response.json({
            controlPlaneSpaceId: 'csp-1',
            runtimeSpaceId: 'runtime-1',
            plan: 'free',
            trialExpiresAt: '2026-07-01T00:00:00.000Z',
            memberLimit: 3,
            activeUserFacingMemberCount: 2,
            suspendedAt: null,
            suspensionReason: null,
            setupAvailable: true,
            controlsAvailable: true
          })
        )) as unknown as typeof fetch
    });

    await expect(
      client.updateSpaceRuntimePolicy({
        controlPlaneSpaceId: 'csp-1',
        runtimeSpaceId: 'runtime-1',
        trialExpiresAt: '2026-07-01T00:00:00.000Z',
        memberLimit: 5
      })
    ).rejects.toThrow('runtime admin policy update returned mismatched state');
  });

  it('calls runtime admin soft-delete instead of hard-deleting local state', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const client = createHttpRuntimeAdminProvisioningClient({
      runtimeUrl: 'https://runtime.teamem.test',
      provisioningToken: 'runtime-token',
      fetchImpl: ((url, init) => {
        requests.push({ url: String(url), init });
        return Promise.resolve(
          Response.json({
            controlPlaneSpaceId: 'csp-1',
            runtimeSpaceId: 'runtime-1',
            status: 'soft_deleted',
            deletedAt: '2026-05-18T00:00:00.000Z'
          })
        );
      }) as typeof fetch
    });

    const result = await client.softDeleteSpace({
      controlPlaneSpaceId: 'csp-1',
      runtimeSpaceId: 'runtime-1',
      idempotencyKey: 'delete-1',
      reason: 'owner_requested'
    });

    expect(result.status).toBe('soft_deleted');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      'https://runtime.teamem.test/cloud-admin/v1/spaces/runtime-1/soft-delete'
    );
    expect(requests[0]?.init?.method).toBe(
      CLOUD_ADMIN_HTTP_METHODS.softDeleteSpace
    );
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      controlPlaneSpaceId: 'csp-1',
      runtimeSpaceId: 'runtime-1',
      idempotencyKey: 'delete-1',
      reason: 'owner_requested'
    });
  });
});
