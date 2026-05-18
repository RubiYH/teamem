import {
  buildCloudSetupCommand,
  type SetupCommandContract
} from './setup-command.js';

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
