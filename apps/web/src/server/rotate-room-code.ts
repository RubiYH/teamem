import 'server-only';

import { randomUUID } from 'node:crypto';
import type {
  CloudControlPlaneAccountInput,
  RotateCloudRoomCodeForOwnerResult
} from '../../../../src/cloud/control-plane';
import { rotateCloudRoomCodeForOwner } from '../../../../src/cloud/control-plane';
import { getControlPlaneRepository } from './control-plane';
import { createRuntimeAdminProvisioningService } from './provisioning';

export async function rotateRoomCodeForUser(input: {
  user: CloudControlPlaneAccountInput;
}): Promise<RotateCloudRoomCodeForOwnerResult> {
  return rotateCloudRoomCodeForOwner(
    getControlPlaneRepository(),
    ids,
    clock,
    createRuntimeAdminProvisioningService(),
    input.user
  );
}

const ids = {
  accountId: () => `acct_${randomUUID()}`,
  auditEventId: () => `aud_${randomUUID()}`
};

const clock = {
  now: () => new Date().toISOString()
};
