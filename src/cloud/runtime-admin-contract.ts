import type {
  CloudSpaceRuntimeStatus,
  CloudRuntimeSpacePlan,
  CreateCloudSpaceProvisioningResult
} from './provisioning-contract.js';
import type { RotateCloudRoomCodeResult } from './provisioning-contract.js';
import type { SoftDeleteCloudSpaceResult } from './provisioning-contract.js';

export const CLOUD_ADMIN_AUTH_HEADER = 'authorization';
export const CLOUD_ADMIN_AUTH_SCHEME = 'Bearer';
export const CLOUD_ADMIN_API_PREFIX = '/cloud-admin/v1';

export const CLOUD_ADMIN_ENDPOINTS = {
  createSpace: `${CLOUD_ADMIN_API_PREFIX}/spaces`,
  spaceStatus: `${CLOUD_ADMIN_API_PREFIX}/spaces/:runtimeSpaceId/status`,
  updateSpacePolicy: `${CLOUD_ADMIN_API_PREFIX}/spaces/:runtimeSpaceId/policy`,
  rotateRoomCode: `${CLOUD_ADMIN_API_PREFIX}/spaces/:runtimeSpaceId/room-code`,
  softDeleteSpace: `${CLOUD_ADMIN_API_PREFIX}/spaces/:runtimeSpaceId/soft-delete`
} as const;

export const CLOUD_ADMIN_HTTP_METHODS = {
  createSpace: 'POST',
  spaceStatus: 'GET',
  updateSpacePolicy: 'POST',
  rotateRoomCode: 'POST',
  softDeleteSpace: 'POST'
} as const;

export type CloudAdminCreateSpaceRequest = {
  label: string;
  idempotencyKey: string;
  controlPlaneSpaceId: string;
  provisioningRequestId: string;
  plan: CloudRuntimeSpacePlan;
  trialExpiresAt: string | null;
  memberLimit: number | null;
};
export type CloudAdminCreateSpaceResponse = CreateCloudSpaceProvisioningResult;

export type CloudAdminGetSpaceStatusRequest = {
  controlPlaneSpaceId: string;
  runtimeSpaceId: string;
};
export type CloudAdminGetSpaceStatusResponse = CloudSpaceRuntimeStatus;

export type CloudAdminUpdateSpacePolicyRequest = {
  controlPlaneSpaceId: string;
  runtimeSpaceId: string;
  trialExpiresAt: string;
  memberLimit: number;
};
export type CloudAdminUpdateSpacePolicyResponse = CloudSpaceRuntimeStatus;

export type CloudAdminRotateRoomCodeRequest = {
  controlPlaneSpaceId: string;
  runtimeSpaceId: string;
  idempotencyKey: string;
};
export type CloudAdminRotateRoomCodeResponse = RotateCloudRoomCodeResult;

export type CloudAdminSoftDeleteSpaceRequest = {
  controlPlaneSpaceId: string;
  runtimeSpaceId: string;
  idempotencyKey: string;
  reason: 'owner_requested' | 'quota_reclaim' | 'operator_action';
};
export type CloudAdminSoftDeleteSpaceResponse = SoftDeleteCloudSpaceResult;

export type CloudAdminApiContract = {
  auth: {
    header: typeof CLOUD_ADMIN_AUTH_HEADER;
    scheme: typeof CLOUD_ADMIN_AUTH_SCHEME;
  };
  endpoints: typeof CLOUD_ADMIN_ENDPOINTS;
  methods: typeof CLOUD_ADMIN_HTTP_METHODS;
};

export const CLOUD_ADMIN_API_CONTRACT: CloudAdminApiContract = {
  auth: {
    header: CLOUD_ADMIN_AUTH_HEADER,
    scheme: CLOUD_ADMIN_AUTH_SCHEME
  },
  endpoints: CLOUD_ADMIN_ENDPOINTS,
  methods: CLOUD_ADMIN_HTTP_METHODS
};
