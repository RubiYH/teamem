import {
  CLOUD_ADMIN_AUTH_HEADER,
  CLOUD_ADMIN_AUTH_SCHEME,
  CLOUD_ADMIN_ENDPOINTS,
  CLOUD_ADMIN_HTTP_METHODS
} from './runtime-admin-contract.js';
import type {
  CreateCloudSpaceInput,
  CreateCloudSpaceResult,
  RotateCloudRoomCodeInput,
  RotateCloudRoomCodeResult,
  RuntimeProvisioningClient,
  SoftDeleteCloudSpaceInput,
  SoftDeleteCloudSpaceResult
} from './provisioning-contract.js';

export function createHttpRuntimeAdminProvisioningClient(input: {
  runtimeUrl: string;
  provisioningToken: string;
  fetchImpl: typeof fetch;
}): RuntimeProvisioningClient {
  return {
    async createSpace(
      createInput: CreateCloudSpaceInput
    ): Promise<CreateCloudSpaceResult> {
      const response = await input.fetchImpl(
        new URL(CLOUD_ADMIN_ENDPOINTS.createSpace, input.runtimeUrl),
        {
          method: CLOUD_ADMIN_HTTP_METHODS.createSpace,
          headers: {
            'Content-Type': 'application/json',
            [CLOUD_ADMIN_AUTH_HEADER]: `${CLOUD_ADMIN_AUTH_SCHEME} ${input.provisioningToken}`
          },
          body: JSON.stringify(createInput)
        }
      );

      if (!response.ok) {
        throw new Error(`runtime admin create failed: HTTP ${response.status}`);
      }

      const body = (await response.json()) as unknown;
      if (!isCreateCloudSpaceResult(body)) {
        throw new Error('runtime admin create returned invalid response');
      }

      return body;
    },
    async rotateRoomCode(
      rotateInput: RotateCloudRoomCodeInput
    ): Promise<RotateCloudRoomCodeResult> {
      const response = await input.fetchImpl(
        new URL(
          CLOUD_ADMIN_ENDPOINTS.rotateRoomCode.replace(
            ':runtimeSpaceId',
            encodeURIComponent(rotateInput.runtimeSpaceId)
          ),
          input.runtimeUrl
        ),
        {
          method: CLOUD_ADMIN_HTTP_METHODS.rotateRoomCode,
          headers: {
            'Content-Type': 'application/json',
            [CLOUD_ADMIN_AUTH_HEADER]: `${CLOUD_ADMIN_AUTH_SCHEME} ${input.provisioningToken}`
          },
          body: JSON.stringify(rotateInput)
        }
      );

      if (!response.ok) {
        throw new Error(
          `runtime admin room-code rotation failed: HTTP ${response.status}`
        );
      }

      const body = (await response.json()) as unknown;
      if (!isRotateCloudRoomCodeResult(body)) {
        throw new Error(
          'runtime admin room-code rotation returned invalid response'
        );
      }

      return body;
    },
    async softDeleteSpace(
      deleteInput: SoftDeleteCloudSpaceInput
    ): Promise<SoftDeleteCloudSpaceResult> {
      const response = await input.fetchImpl(
        new URL(
          CLOUD_ADMIN_ENDPOINTS.softDeleteSpace.replace(
            ':runtimeSpaceId',
            encodeURIComponent(deleteInput.runtimeSpaceId)
          ),
          input.runtimeUrl
        ),
        {
          method: CLOUD_ADMIN_HTTP_METHODS.softDeleteSpace,
          headers: {
            'Content-Type': 'application/json',
            [CLOUD_ADMIN_AUTH_HEADER]: `${CLOUD_ADMIN_AUTH_SCHEME} ${input.provisioningToken}`
          },
          body: JSON.stringify(deleteInput)
        }
      );

      if (!response.ok) {
        throw new Error(
          `runtime admin soft-delete failed: HTTP ${response.status}`
        );
      }

      const body = (await response.json()) as unknown;
      if (!isSoftDeleteCloudSpaceResult(body)) {
        throw new Error('runtime admin soft-delete returned invalid response');
      }

      return body;
    }
  };
}

function isRotateCloudRoomCodeResult(
  value: unknown
): value is RotateCloudRoomCodeResult {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.controlPlaneSpaceId === 'string' &&
    typeof value.runtimeSpaceId === 'string' &&
    typeof value.roomCode === 'string'
  );
}

function isCreateCloudSpaceResult(
  value: unknown
): value is CreateCloudSpaceResult {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.controlPlaneSpaceId === 'string' &&
    typeof value.runtimeSpaceId === 'string' &&
    typeof value.runtimeServerUrl === 'string' &&
    typeof value.label === 'string' &&
    typeof value.roomCode === 'string' &&
    value.status === 'active' &&
    isRecord(value.correlation) &&
    value.correlation.source === 'teamem-cloud' &&
    typeof value.correlation.controlPlaneSpaceId === 'string' &&
    typeof value.correlation.provisioningRequestId === 'string'
  );
}

function isSoftDeleteCloudSpaceResult(
  value: unknown
): value is SoftDeleteCloudSpaceResult {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.controlPlaneSpaceId === 'string' &&
    typeof value.runtimeSpaceId === 'string' &&
    value.status === 'soft_deleted' &&
    typeof value.deletedAt === 'string'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
