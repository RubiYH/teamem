import type {
  RuntimeProvisioningClient,
  CreateCloudSpaceInput,
  CreateCloudSpaceResult,
  RotateCloudRoomCodeInput,
  RotateCloudRoomCodeResult,
  SoftDeleteCloudSpaceInput,
  SoftDeleteCloudSpaceResult
} from '../../../../src/cloud/provisioning-contract';
import { createHttpRuntimeAdminProvisioningClient } from '../../../../src/cloud/runtime-admin-client';
import { loadTeamemCloudWebEnv } from './env';

export type CloudProvisioningService = RuntimeProvisioningClient;

export function createContractOnlyProvisioningService(): CloudProvisioningService {
  return {
    createSpace(input: CreateCloudSpaceInput): Promise<CreateCloudSpaceResult> {
      return Promise.resolve(contractOnly(input));
    },
    rotateRoomCode(
      input: RotateCloudRoomCodeInput
    ): Promise<RotateCloudRoomCodeResult> {
      return Promise.resolve(contractOnly(input));
    },
    softDeleteSpace(
      input: SoftDeleteCloudSpaceInput
    ): Promise<SoftDeleteCloudSpaceResult> {
      return Promise.resolve(contractOnly(input));
    }
  };
}

export function createRuntimeAdminProvisioningService(): CloudProvisioningService {
  const envResult = loadTeamemCloudWebEnv();
  if (!envResult.ok) {
    throw new Error(
      `Teamem Cloud runtime provisioning env is missing: ${envResult.missing.join(', ')}`
    );
  }

  return createHttpRuntimeAdminProvisioningService({
    runtimeUrl: envResult.value.runtime.hostedUrl,
    provisioningToken: envResult.value.runtime.provisioningToken,
    fetchImpl: fetch
  });
}

export function createHttpRuntimeAdminProvisioningService(input: {
  runtimeUrl: string;
  provisioningToken: string;
  fetchImpl: typeof fetch;
}): CloudProvisioningService {
  return createHttpRuntimeAdminProvisioningClient(input);
}

function contractOnly(_input: unknown): never {
  throw new Error(
    'Teamem Cloud provisioning service is contract-only in Issue 01'
  );
}
