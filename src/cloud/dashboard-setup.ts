import {
  buildCloudSetupCommand,
  type SetupCommandContract
} from './setup-command.js';
import type {
  CloudControlPlaneSpace,
  CloudDashboardState
} from './control-plane.js';
import type { CloudSpaceRuntimeStatus } from './provisioning-contract.js';

export type CloudDashboardSetupInput = {
  runtimeServerUrl: string | null;
  roomCodeDisplayMetadata: {
    code: string | null;
    label: string | null;
  };
};

export type CopyableCloudSetupField = {
  label: string;
  text: string;
  copyValue: string | null;
};

export type CloudDashboardSetupViewModel = {
  runtimeServer: CopyableCloudSetupField;
  roomCode: CopyableCloudSetupField;
  setupCommand: SetupCommandContract | null;
};

export type CloudDashboardExistingSpaceRuntimeView = {
  setup: CloudDashboardSetupViewModel | null;
  canRotateRoomCode: boolean;
  canDeleteSpace: boolean;
  freeTrial:
    | null
    | {
        status: 'runtime_unavailable';
      }
    | {
        status: 'available';
        trialExpiresAt: string | null;
        memberLimit: number | null;
        activeUserFacingMemberCount: number;
      };
};

const MEMBER_NAME_PLACEHOLDER = '<your-name>';

export function buildCloudDashboardSetupView(
  input: CloudDashboardSetupInput
): CloudDashboardSetupViewModel {
  const roomCode = input.roomCodeDisplayMetadata.code;
  const runtimeServerUrl = input.runtimeServerUrl;

  return {
    runtimeServer: {
      label: 'Runtime server',
      text:
        runtimeServerUrl ??
        'Runtime server URL will appear after provisioning.',
      copyValue: runtimeServerUrl
    },
    roomCode: {
      label: 'Room code',
      text:
        input.roomCodeDisplayMetadata.label ??
        roomCode ??
        'Room-code metadata is not available yet.',
      copyValue: roomCode
    },
    setupCommand:
      runtimeServerUrl && roomCode
        ? buildCloudSetupCommand({
            serverUrl: runtimeServerUrl,
            roomCode,
            memberNamePlaceholder: MEMBER_NAME_PLACEHOLDER
          })
        : null
  };
}

export function buildCloudDashboardExistingSpaceRuntimeView(input: {
  state: Extract<CloudDashboardState, { kind: 'existing-space' }>;
  runtimeStatus: CloudSpaceRuntimeStatus | null;
}): CloudDashboardExistingSpaceRuntimeView {
  const { runtimeStatus, state } = input;
  const setup =
    state.space.status === 'active' &&
    runtimeStatus?.setupAvailable === true &&
    Boolean(state.space.runtimeServerUrl) &&
    Boolean(state.space.roomCodeDisplayMetadata.code)
      ? buildCloudDashboardSetupView({
          runtimeServerUrl: state.space.runtimeServerUrl,
          roomCodeDisplayMetadata: state.space.roomCodeDisplayMetadata
        })
      : null;

  return {
    setup,
    canRotateRoomCode:
      state.space.status === 'active' &&
      runtimeStatus?.controlsAvailable === true &&
      Boolean(state.space.runtimeSpaceId) &&
      Boolean(state.space.runtimeServerUrl),
    canDeleteSpace: canDeleteCloudDashboardSpace(state.space),
    freeTrial: buildCloudDashboardFreeTrialRuntimeView({
      space: state.space,
      runtimeStatus
    })
  };
}

function buildCloudDashboardFreeTrialRuntimeView(input: {
  space: CloudControlPlaneSpace;
  runtimeStatus: CloudSpaceRuntimeStatus | null;
}): CloudDashboardExistingSpaceRuntimeView['freeTrial'] {
  if (
    input.space.plan !== 'free' ||
    (input.space.status !== 'active' && input.space.status !== 'suspended')
  ) {
    return null;
  }

  if (!input.runtimeStatus) {
    return { status: 'runtime_unavailable' };
  }

  return {
    status: 'available',
    trialExpiresAt: input.runtimeStatus.trialExpiresAt,
    memberLimit: input.runtimeStatus.memberLimit,
    activeUserFacingMemberCount: input.runtimeStatus.activeUserFacingMemberCount
  };
}

function canDeleteCloudDashboardSpace(space: CloudControlPlaneSpace): boolean {
  return (
    space.status === 'active' ||
    space.status === 'suspended' ||
    space.status === 'delete_pending'
  );
}
