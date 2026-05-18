import { describe, expect, it } from 'bun:test';
import {
  CLOUD_ADMIN_API_CONTRACT,
  CLOUD_ADMIN_API_PREFIX,
  type CloudAdminCreateSpaceRequest,
  type CloudAdminRotateRoomCodeRequest,
  type CloudAdminSoftDeleteSpaceRequest
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
        rotateRoomCode: '/cloud-admin/v1/spaces/:runtimeSpaceId/room-code',
        softDeleteSpace: '/cloud-admin/v1/spaces/:runtimeSpaceId/soft-delete'
      },
      methods: {
        createSpace: 'POST',
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
      provisioningRequestId: 'request-1'
    } satisfies CloudAdminCreateSpaceRequest;

    expect(Object.keys(request).sort()).toEqual([
      'controlPlaneSpaceId',
      'idempotencyKey',
      'label',
      'provisioningRequestId'
    ]);
    expect('accountId' in request).toBe(false);
    expect('email' in request).toBe(false);
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
        provisioningRequestId: 'request-1'
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
