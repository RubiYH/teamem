import {
  CLOUD_ADMIN_AUTH_HEADER,
  CLOUD_ADMIN_AUTH_SCHEME,
  CLOUD_ADMIN_ENDPOINTS,
  CLOUD_ADMIN_HTTP_METHODS
} from './runtime-admin-contract.js';
import type {
  CloudSpaceRuntimeStatus,
  CreateCloudSpaceInput,
  CreateCloudSpaceProvisioningResult,
  CreateCloudSpaceResult,
  CreateCloudSpaceTerminalFailureResult,
  GetCloudSpaceRuntimeStatusInput,
  RotateCloudRoomCodeInput,
  RotateCloudRoomCodeResult,
  RuntimePolicyClient,
  RuntimeProvisioningClient,
  RuntimeStatusClient,
  SoftDeleteCloudSpaceInput,
  SoftDeleteCloudSpaceResult,
  UpdateCloudSpaceRuntimePolicyInput
} from './provisioning-contract.js';

export function createHttpRuntimeAdminProvisioningClient(input: {
  runtimeUrl: string;
  provisioningToken: string;
  fetchImpl: typeof fetch;
}): RuntimeProvisioningClient & RuntimeStatusClient & RuntimePolicyClient {
  return {
    async createSpace(
      createInput: CreateCloudSpaceInput
    ): Promise<CreateCloudSpaceProvisioningResult> {
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
      if (!isCreateCloudSpaceProvisioningResult(body)) {
        throw new Error('runtime admin create returned invalid response');
      }

      return body;
    },
    async getSpaceRuntimeStatus(
      statusInput: GetCloudSpaceRuntimeStatusInput
    ): Promise<CloudSpaceRuntimeStatus> {
      const url = new URL(
        CLOUD_ADMIN_ENDPOINTS.spaceStatus.replace(
          ':runtimeSpaceId',
          encodeURIComponent(statusInput.runtimeSpaceId)
        ),
        input.runtimeUrl
      );
      url.searchParams.set(
        'controlPlaneSpaceId',
        statusInput.controlPlaneSpaceId
      );

      const response = await input.fetchImpl(url, {
        method: CLOUD_ADMIN_HTTP_METHODS.spaceStatus,
        headers: {
          [CLOUD_ADMIN_AUTH_HEADER]: `${CLOUD_ADMIN_AUTH_SCHEME} ${input.provisioningToken}`
        }
      });

      if (!response.ok) {
        throw new Error(`runtime admin status failed: HTTP ${response.status}`);
      }

      const body = (await response.json()) as unknown;
      if (!isCloudSpaceRuntimeStatus(body)) {
        throw new Error('runtime admin status returned invalid response');
      }
      if (
        body.controlPlaneSpaceId !== statusInput.controlPlaneSpaceId ||
        body.runtimeSpaceId !== statusInput.runtimeSpaceId
      ) {
        throw new Error('runtime admin status returned mismatched space IDs');
      }

      return body;
    },
    async updateSpaceRuntimePolicy(
      policyInput: UpdateCloudSpaceRuntimePolicyInput
    ): Promise<CloudSpaceRuntimeStatus> {
      const response = await input.fetchImpl(
        new URL(
          CLOUD_ADMIN_ENDPOINTS.updateSpacePolicy.replace(
            ':runtimeSpaceId',
            encodeURIComponent(policyInput.runtimeSpaceId)
          ),
          input.runtimeUrl
        ),
        {
          method: CLOUD_ADMIN_HTTP_METHODS.updateSpacePolicy,
          headers: {
            'Content-Type': 'application/json',
            [CLOUD_ADMIN_AUTH_HEADER]: `${CLOUD_ADMIN_AUTH_SCHEME} ${input.provisioningToken}`
          },
          body: JSON.stringify(policyInput)
        }
      );

      if (!response.ok) {
        throw new Error(
          `runtime admin policy update failed: HTTP ${response.status}`
        );
      }

      const body = (await response.json()) as unknown;
      if (!isCloudSpaceRuntimeStatus(body)) {
        throw new Error(
          'runtime admin policy update returned invalid response'
        );
      }
      if (
        body.controlPlaneSpaceId !== policyInput.controlPlaneSpaceId ||
        body.runtimeSpaceId !== policyInput.runtimeSpaceId ||
        body.trialExpiresAt !== policyInput.trialExpiresAt ||
        body.memberLimit !== policyInput.memberLimit
      ) {
        throw new Error(
          'runtime admin policy update returned mismatched state'
        );
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

function isCloudSpaceRuntimeStatus(
  value: unknown
): value is CloudSpaceRuntimeStatus {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.controlPlaneSpaceId === 'string' &&
    typeof value.runtimeSpaceId === 'string' &&
    (value.plan === null ||
      value.plan === 'free' ||
      value.plan === 'team' ||
      value.plan === 'enterprise') &&
    (value.trialExpiresAt === null ||
      typeof value.trialExpiresAt === 'string') &&
    (value.memberLimit === null || typeof value.memberLimit === 'number') &&
    typeof value.activeUserFacingMemberCount === 'number' &&
    Number.isInteger(value.activeUserFacingMemberCount) &&
    value.activeUserFacingMemberCount >= 0 &&
    (value.suspendedAt === null || typeof value.suspendedAt === 'string') &&
    (value.suspensionReason === null ||
      typeof value.suspensionReason === 'string') &&
    typeof value.setupAvailable === 'boolean' &&
    typeof value.controlsAvailable === 'boolean'
  );
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

function isCreateCloudSpaceTerminalFailureResult(
  value: unknown
): value is CreateCloudSpaceTerminalFailureResult {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.controlPlaneSpaceId === 'string' &&
    value.status === 'provisioning_failed' &&
    typeof value.reason === 'string' &&
    isRecord(value.correlation) &&
    value.correlation.source === 'teamem-cloud' &&
    typeof value.correlation.controlPlaneSpaceId === 'string' &&
    typeof value.correlation.provisioningRequestId === 'string'
  );
}

function isCreateCloudSpaceProvisioningResult(
  value: unknown
): value is CreateCloudSpaceProvisioningResult {
  return (
    isCreateCloudSpaceResult(value) ||
    isCreateCloudSpaceTerminalFailureResult(value)
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
