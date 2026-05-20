import type { CloudDashboardState } from './control-plane.js';
import type {
  CloudSpaceRuntimeStatus,
  RuntimeStatusClient
} from './provisioning-contract.js';

export type CloudDashboardRuntimeStatus = CloudSpaceRuntimeStatus | null;
type RuntimeStatusClientInput =
  | RuntimeStatusClient
  | (() => RuntimeStatusClient);

export async function getCloudDashboardRuntimeStatus(input: {
  state: CloudDashboardState;
  client: RuntimeStatusClientInput;
}): Promise<CloudDashboardRuntimeStatus> {
  const { state } = input;
  if (
    state.kind !== 'existing-space' ||
    !state.space.runtimeSpaceId ||
    !state.space.runtimeServerUrl
  ) {
    return null;
  }

  try {
    const client =
      typeof input.client === 'function' ? input.client() : input.client;

    return await client.getSpaceRuntimeStatus({
      controlPlaneSpaceId: state.space.id,
      runtimeSpaceId: state.space.runtimeSpaceId
    });
  } catch {
    return null;
  }
}
