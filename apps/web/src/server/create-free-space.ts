import 'server-only';

import { randomUUID } from 'node:crypto';
import type {
  CloudControlPlaneAccountInput,
  ProvisionFreeCloudSpaceResult
} from '../../../../src/cloud/control-plane';
import { provisionFreeCloudSpace } from '../../../../src/cloud/control-plane';
import { getControlPlaneRepository } from './control-plane';
import { createRuntimeAdminProvisioningService } from './provisioning';

export async function createFreeSpaceForUser(input: {
  user: CloudControlPlaneAccountInput;
  spaceDisplayName: string;
}): Promise<ProvisionFreeCloudSpaceResult> {
  return provisionFreeCloudSpace(
    getControlPlaneRepository(),
    ids,
    clock,
    createRuntimeAdminProvisioningService(),
    {
      betterAuthUserId: input.user.betterAuthUserId,
      email: input.user.email,
      accountDisplayName: input.user.displayName,
      spaceDisplayName: input.spaceDisplayName
    }
  );
}

const ids = {
  accountId: () => `acct_${randomUUID()}`,
  spaceId: () => `csp_${randomUUID()}`,
  freePlanGrantId: () => `fpg_${randomUUID()}`,
  auditEventId: () => `aud_${randomUUID()}`
};

const clock = {
  now: () => new Date().toISOString()
};
