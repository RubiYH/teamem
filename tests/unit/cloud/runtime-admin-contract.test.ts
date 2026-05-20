import { describe, expect, it } from 'bun:test';
import {
  CLOUD_ADMIN_API_CONTRACT,
  CLOUD_ADMIN_API_PREFIX,
  type CloudAdminCreateSpaceRequest,
  type CloudAdminCreateSpaceResponse,
  type CloudAdminGetSpaceStatusResponse,
  type CloudAdminRotateRoomCodeRequest,
  type CloudAdminSoftDeleteSpaceRequest,
  type CloudAdminUpdateSpacePolicyRequest,
  type CloudAdminUpdateSpacePolicyResponse
} from '../../../src/cloud/runtime-admin-contract.js';
import {
  TEAMEM_CLOUD_BOUNDARIES,
  assertRuntimeCloudMetadataAllowed
} from '../../../src/cloud/boundary-guardrails.js';

describe('runtime cloud-admin contract', () => {
  it('keeps cloud-admin endpoints behind a separate runtime prefix', () => {
    expect(CLOUD_ADMIN_API_PREFIX).toBe('/cloud-admin/v1');
    expect(CLOUD_ADMIN_API_CONTRACT).toEqual({
      auth: {
        header: 'authorization',
        scheme: 'Bearer'
      },
      endpoints: {
        createSpace: '/cloud-admin/v1/spaces',
        spaceStatus: '/cloud-admin/v1/spaces/:runtimeSpaceId/status',
        updateSpacePolicy: '/cloud-admin/v1/spaces/:runtimeSpaceId/policy',
        rotateRoomCode: '/cloud-admin/v1/spaces/:runtimeSpaceId/room-code',
        softDeleteSpace: '/cloud-admin/v1/spaces/:runtimeSpaceId/soft-delete'
      },
      methods: {
        createSpace: 'POST',
        spaceStatus: 'GET',
        updateSpacePolicy: 'POST',
        rotateRoomCode: 'POST',
        softDeleteSpace: 'POST'
      }
    });
  });

  it('documents the runtime and control-plane ownership split', () => {
    expect(TEAMEM_CLOUD_BOUNDARIES.runtimeOwns).toContain('room_codes');
    expect(TEAMEM_CLOUD_BOUNDARIES.runtimeOwns).toContain('runtime_jwts');
    expect(TEAMEM_CLOUD_BOUNDARIES.controlPlaneOwns).toContain('quota');
    expect(TEAMEM_CLOUD_BOUNDARIES.controlPlaneOwns).toContain(
      'dashboard_state'
    );
  });

  it('keeps control-plane account identity out of runtime create requests', () => {
    const request = {
      label: 'Launch Space',
      idempotencyKey: 'idem-1',
      controlPlaneSpaceId: 'cloud-space-1',
      provisioningRequestId: 'request-1',
      plan: 'free',
      trialExpiresAt: '2026-06-01T00:00:00.000Z',
      memberLimit: 3
    } satisfies CloudAdminCreateSpaceRequest;

    expect(Object.keys(request).sort()).toEqual([
      'controlPlaneSpaceId',
      'idempotencyKey',
      'label',
      'memberLimit',
      'plan',
      'provisioningRequestId',
      'trialExpiresAt'
    ]);
    expect('accountId' in request).toBe(false);
    expect('email' in request).toBe(false);
  });

  it('allows runtime create to return a terminal provisioning failure', () => {
    const response = {
      controlPlaneSpaceId: 'cloud-space-1',
      status: 'provisioning_failed',
      reason: 'capacity_unavailable',
      correlation: {
        source: 'teamem-cloud',
        controlPlaneSpaceId: 'cloud-space-1',
        provisioningRequestId: 'request-1'
      }
    } satisfies CloudAdminCreateSpaceResponse;

    expect(Object.keys(response).sort()).toEqual([
      'controlPlaneSpaceId',
      'correlation',
      'reason',
      'status'
    ]);
    expect('runtimeSpaceId' in response).toBe(false);
    expect('runtimeServerUrl' in response).toBe(false);
    expect('memberLimit' in response).toBe(false);
    expect('trialExpiresAt' in response).toBe(false);
  });

  it('keeps runtime room-code rotation correlated by opaque IDs only', () => {
    const request = {
      controlPlaneSpaceId: 'cloud-space-1',
      runtimeSpaceId: 'runtime-space-1',
      idempotencyKey: 'rotate-1'
    } satisfies CloudAdminRotateRoomCodeRequest;

    expect(Object.keys(request).sort()).toEqual([
      'controlPlaneSpaceId',
      'idempotencyKey',
      'runtimeSpaceId'
    ]);
    expect('accountId' in request).toBe(false);
    expect('email' in request).toBe(false);
  });

  it('defines cloud-admin runtime status as policy state without account identity', () => {
    const response = {
      controlPlaneSpaceId: 'cloud-space-1',
      runtimeSpaceId: 'runtime-space-1',
      plan: 'free',
      trialExpiresAt: '2026-06-01T00:00:00.000Z',
      memberLimit: 3,
      activeUserFacingMemberCount: 2,
      suspendedAt: null,
      suspensionReason: null,
      setupAvailable: true,
      controlsAvailable: true
    } satisfies CloudAdminGetSpaceStatusResponse;

    expect(Object.keys(response).sort()).toEqual([
      'activeUserFacingMemberCount',
      'controlPlaneSpaceId',
      'controlsAvailable',
      'memberLimit',
      'plan',
      'runtimeSpaceId',
      'setupAvailable',
      'suspendedAt',
      'suspensionReason',
      'trialExpiresAt'
    ]);
    expect('accountId' in response).toBe(false);
    expect('email' in response).toBe(false);
  });

  it('keeps runtime policy updates operator-scoped by opaque Space IDs only', () => {
    const request = {
      controlPlaneSpaceId: 'cloud-space-1',
      runtimeSpaceId: 'runtime-space-1',
      trialExpiresAt: '2026-07-01T00:00:00.000Z',
      memberLimit: 5
    } satisfies CloudAdminUpdateSpacePolicyRequest;
    const response = {
      controlPlaneSpaceId: 'cloud-space-1',
      runtimeSpaceId: 'runtime-space-1',
      plan: 'free',
      trialExpiresAt: '2026-07-01T00:00:00.000Z',
      memberLimit: 5,
      activeUserFacingMemberCount: 2,
      suspendedAt: null,
      suspensionReason: null,
      setupAvailable: true,
      controlsAvailable: true
    } satisfies CloudAdminUpdateSpacePolicyResponse;

    expect(Object.keys(request).sort()).toEqual([
      'controlPlaneSpaceId',
      'memberLimit',
      'runtimeSpaceId',
      'trialExpiresAt'
    ]);
    expect(response.trialExpiresAt).toBe(request.trialExpiresAt);
    expect(response.memberLimit).toBe(request.memberLimit);
    expect('accountId' in request).toBe(false);
    expect('email' in request).toBe(false);
  });

  it('keeps runtime soft-delete correlated by opaque IDs only', () => {
    const request = {
      controlPlaneSpaceId: 'cloud-space-1',
      runtimeSpaceId: 'runtime-space-1',
      idempotencyKey: 'delete-1',
      reason: 'owner_requested'
    } satisfies CloudAdminSoftDeleteSpaceRequest;

    expect(Object.keys(request).sort()).toEqual([
      'controlPlaneSpaceId',
      'idempotencyKey',
      'reason',
      'runtimeSpaceId'
    ]);
    expect('accountId' in request).toBe(false);
    expect('email' in request).toBe(false);
  });

  it('rejects OAuth and account data in runtime cloud metadata', () => {
    expect(() =>
      assertRuntimeCloudMetadataAllowed({
        source: 'teamem-cloud',
        controlPlaneSpaceId: 'cloud-space-1',
        provisioningRequestId: 'request-1',
        plan: 'free',
        trialExpiresAt: '2026-06-01T00:00:00.000Z',
        memberLimit: 3,
        suspendedAt: null,
        suspensionReason: null
      })
    ).not.toThrow();

    expect(() =>
      assertRuntimeCloudMetadataAllowed({
        source: 'teamem-cloud',
        controlPlaneSpaceId: 'cloud-space-1',
        email: 'owner@example.com'
      })
    ).toThrow('runtime cloud metadata must not include email');
  });
});
