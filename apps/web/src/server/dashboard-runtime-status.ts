import 'server-only';

import type {
  CloudDashboardState,
  CloudSpaceRuntimeStatus
} from '@teamem/cloud';
import { getCloudDashboardRuntimeStatus } from '@teamem/cloud';
import { createRuntimeAdminProvisioningService } from './provisioning';

export type DashboardRuntimeStatus = CloudSpaceRuntimeStatus | null;

export async function getDashboardRuntimeStatus(
  state: CloudDashboardState
): Promise<DashboardRuntimeStatus> {
  return getCloudDashboardRuntimeStatus({
    state,
    client: () => createRuntimeAdminProvisioningService()
  });
}
