import 'server-only';

import { randomUUID } from 'node:crypto';
import type {
  CloudControlPlaneAccountInput,
  DeleteCloudSpaceForOwnerResult
} from '../../../../src/cloud/control-plane';
import { deleteCloudSpaceForOwner } from '../../../../src/cloud/control-plane';
import { getControlPlaneRepository } from './control-plane';
import { createRuntimeAdminProvisioningService } from './provisioning';

export async function deleteSpaceForUser(input: {
  user: CloudControlPlaneAccountInput;
  confirmationAccepted: boolean;
}): Promise<DeleteCloudSpaceForOwnerResult> {
  return deleteCloudSpaceForOwner(
    getControlPlaneRepository(),
    ids,
    clock,
    createRuntimeAdminProvisioningService(),
    {
      ...input.user,
      confirmationAccepted: input.confirmationAccepted
    }
  );
}

const ids = {
  accountId: () => `acct_${randomUUID()}`,
  auditEventId: () => `aud_${randomUUID()}`
};

const clock = {
  now: () => new Date().toISOString()
};
