import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildCloudDashboardSetupView } from '../../../src/cloud/dashboard-setup.js';

const dashboardSource = readFileSync(
  join(process.cwd(), 'apps/web/app/dashboard/page.tsx'),
  'utf8'
);
const copyButtonSource = readFileSync(
  join(process.cwd(), 'apps/web/app/dashboard/copy-button.tsx'),
  'utf8'
);
const rotateButtonSource = readFileSync(
  join(process.cwd(), 'apps/web/app/dashboard/rotate-room-code-button.tsx'),
  'utf8'
);
const dashboardActionsSource = readFileSync(
  join(process.cwd(), 'apps/web/app/dashboard/actions.ts'),
  'utf8'
);

describe('Teamem Cloud dashboard setup view', () => {
  it('renders setup command data from runtime URL and room code', () => {
    const setup = buildCloudDashboardSetupView({
      runtimeServerUrl: 'https://runtime.teamem.test',
      roomCodeDisplayMetadata: {
        code: 'ABCD1234',
        label: null
      }
    });

    expect(setup.runtimeServer).toEqual({
      label: 'Runtime server',
      text: 'https://runtime.teamem.test',
      copyValue: 'https://runtime.teamem.test'
    });
    expect(setup.roomCode).toEqual({
      label: 'Room code',
      text: 'ABCD1234',
      copyValue: 'ABCD1234'
    });
    expect(setup.setupCommand?.argv).toEqual([
      'teamem',
      'init',
      '--join',
      '--server-url',
      'https://runtime.teamem.test',
      '--room-code',
      'ABCD1234',
      '--member-name',
      '<your-name>'
    ]);
    expect(setup.setupCommand?.command).toBe(
      "teamem init --join --server-url https://runtime.teamem.test --room-code ABCD1234 --member-name '<your-name>'"
    );
  });

  it('keeps copy controls disabled and command hidden while provisioning details are missing', () => {
    const setup = buildCloudDashboardSetupView({
      runtimeServerUrl: null,
      roomCodeDisplayMetadata: {
        code: null,
        label: null
      }
    });

    expect(setup.runtimeServer.copyValue).toBeNull();
    expect(setup.runtimeServer.text).toBe(
      'Runtime server URL will appear after provisioning.'
    );
    expect(setup.roomCode.copyValue).toBeNull();
    expect(setup.roomCode.text).toBe(
      'Room-code metadata is not available yet.'
    );
    expect(setup.setupCommand).toBeNull();
  });

  it('wires dashboard setup copy, install, and Claude Code verification hints', () => {
    expect(dashboardSource).toContain('buildCloudDashboardSetupView');
    expect(dashboardSource).toContain('CopyableField');
    expect(dashboardSource).toContain('npm install -g @rubiyh05/teamem');
    expect(dashboardSource).toContain('teamem cc');
    expect(dashboardSource).toContain('/teamem-status');
  });

  it('copies provided field values through the browser clipboard API', () => {
    expect(copyButtonSource).toContain("'use client'");
    expect(copyButtonSource).toContain('navigator.clipboard.writeText(value)');
    expect(copyButtonSource).toContain('disabled={isDisabled}');
    expect(copyButtonSource).toContain('Copy ${label}');
  });

  it('exposes owner-only room-code rotation through a server action with visible form states', () => {
    expect(dashboardSource).toContain('RoomCodeRotationPanel');
    expect(dashboardSource).toContain('state.space.status ===');
    expect(dashboardSource).toContain('state.space.runtimeSpaceId');
    expect(dashboardSource).toContain('rotateStatusMessage');
    expect(dashboardSource).toContain('rotateRoomCodeAction');
    expect(rotateButtonSource).toContain('useFormStatus');
    expect(rotateButtonSource).toContain('Rotating...');
    expect(dashboardActionsSource).toContain('auth.api.getSession');
    expect(dashboardActionsSource).toContain('rotateRoomCodeForUser');
    expect(dashboardActionsSource).toContain(
      'export async function rotateRoomCodeAction()'
    );
    expect(dashboardActionsSource).not.toContain(
      'rotateRoomCodeAction(formData'
    );
  });

  it('exposes retry provisioning for pending Spaces instead of only quota blocking them', () => {
    expect(dashboardSource).toContain(
      'isRetryablePendingProvisioningSpace(state.space)'
    );
    expect(dashboardSource).toContain('RetryProvisioningPanel');
    expect(dashboardSource).toContain(
      "space.status === 'provisioning_pending'"
    );
    expect(dashboardSource).toContain('!space.runtimeSpaceId');
    expect(dashboardSource).toContain('!space.runtimeServerUrl');
    expect(dashboardSource).toContain('action={createFreeSpaceAction}');
    expect(dashboardSource).toContain('value={state.space.displayName}');
    expect(dashboardSource).toContain('Retry provisioning');
    expect(dashboardSource).toContain('same Space request and idempotency key');
  });
});
