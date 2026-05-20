import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildCloudDashboardExistingSpaceRuntimeView,
  buildCloudDashboardSetupView
} from '../../../src/cloud/dashboard-setup.js';
import { getCloudDashboardRuntimeStatus } from '../../../src/cloud/dashboard-runtime-status.js';
import type {
  CloudDashboardState,
  CloudSpaceRuntimeStatus
} from '../../../src/cloud/index.js';
import { formatClientTrialTime } from '../../../apps/web/app/[locale]/dashboard/trial-time-format.js';

const dashboardSource = readFileSync(
  join(process.cwd(), 'apps/web/app/[locale]/dashboard/page.tsx'),
  'utf8'
);
const copyButtonSource = readFileSync(
  join(process.cwd(), 'apps/web/app/[locale]/dashboard/copy-button.tsx'),
  'utf8'
);
const rotateButtonSource = readFileSync(
  join(
    process.cwd(),
    'apps/web/app/[locale]/dashboard/rotate-room-code-button.tsx'
  ),
  'utf8'
);
const dashboardActionsSource = readFileSync(
  join(process.cwd(), 'apps/web/app/[locale]/dashboard/actions.ts'),
  'utf8'
);
const dashboardRuntimeStatusSource = readFileSync(
  join(process.cwd(), 'apps/web/src/server/dashboard-runtime-status.ts'),
  'utf8'
);
const cloudDashboardRuntimeStatusSource = readFileSync(
  join(process.cwd(), 'src/cloud/dashboard-runtime-status.ts'),
  'utf8'
);
const trialTimeSource = readFileSync(
  join(process.cwd(), 'apps/web/app/[locale]/dashboard/trial-time.tsx'),
  'utf8'
);
const cloudDashboardSetupSource = readFileSync(
  join(process.cwd(), 'src/cloud/dashboard-setup.ts'),
  'utf8'
);
const messagesSource = readFileSync(
  join(process.cwd(), 'apps/web/messages/en.json'),
  'utf8'
);
const koreanMessagesSource = readFileSync(
  join(process.cwd(), 'apps/web/messages/ko.json'),
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
    expect(dashboardSource).toContain(
      'buildCloudDashboardExistingSpaceRuntimeView'
    );
    expect(dashboardSource).toContain('CopyableField');
    expect(dashboardSource).toContain('npm install -g @rubiyh05/teamem');
    expect(dashboardSource).toContain('teamem cc');
    expect(dashboardSource).toContain('/teamem-status');
  });

  it('copies provided field values through the browser clipboard API', () => {
    expect(copyButtonSource).toContain("'use client'");
    expect(copyButtonSource).toContain('navigator.clipboard.writeText(value)');
    expect(copyButtonSource).toContain('disabled={isDisabled}');
    expect(copyButtonSource).toContain('aria-label={ariaLabel}');
    expect(messagesSource).toContain('Copy {label}');
  });

  it('exposes owner-only room-code rotation through a server action with visible form states', () => {
    expect(dashboardSource).toContain('RoomCodeRotationPanel');
    expect(cloudDashboardSetupSource).toContain('state.space.status ===');
    expect(cloudDashboardSetupSource).toContain('state.space.runtimeSpaceId');
    expect(dashboardSource).toContain('copy.statuses.rotate[rotateStatus]');
    expect(dashboardSource).toContain('rotateRoomCodeAction');
    expect(rotateButtonSource).toContain('useFormStatus');
    expect(rotateButtonSource).toContain('pendingLabel');
    expect(messagesSource).toContain('Rotating...');
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
    expect(messagesSource).toContain('Retry provisioning');
    expect(messagesSource).toContain('same Space request and idempotency key');
  });

  it('renders consumed-trial state without create, setup, or active setup controls', () => {
    const consumedStateStart = dashboardSource.indexOf(
      'function FreeTrialConsumedState'
    );
    const retryPanelStart = dashboardSource.indexOf(
      'function RetryProvisioningPanel'
    );
    const consumedStateSource = dashboardSource.slice(
      consumedStateStart,
      retryPanelStart
    );

    expect(dashboardSource).toContain("state.kind === 'free-trial-consumed'");
    expect(consumedStateSource).toContain('copy.quota.consumedTitle');
    expect(consumedStateSource).toContain('copy.quota.consumedText');
    expect(consumedStateSource).not.toContain('CreateFreeSpacePanel');
    expect(consumedStateSource).not.toContain('RoomCodeRotationPanel');
    expect(consumedStateSource).not.toContain('DeleteSpacePanel');
    expect(consumedStateSource).not.toContain('buildCloudDashboardSetupView');
    expect(consumedStateSource).not.toContain('CopyableField');
    expect(consumedStateSource).not.toContain('createFreeSpaceAction');
  });

  it('keeps delete-success copy from implying free quota is restored', () => {
    expect(messagesSource).toContain(
      "This account's one-time free trial remains consumed."
    );
    expect(messagesSource).not.toContain('Free quota is available again');
    expect(messagesSource).not.toContain('release the free quota');
    expect(koreanMessagesSource).toContain('일회성 무료 체험은 사용된 상태');
    expect(koreanMessagesSource).not.toContain(
      '무료 할당량을 다시 사용할 수 있습니다'
    );
  });

  it('fails closed on unavailable runtime status while keeping delete available', () => {
    expect(dashboardSource).toContain('getDashboardRuntimeStatus');
    expect(dashboardRuntimeStatusSource).toContain(
      'getCloudDashboardRuntimeStatus'
    );
    expect(cloudDashboardRuntimeStatusSource).toContain('catch');
    expect(cloudDashboardRuntimeStatusSource).toContain('return null');
    expect(cloudDashboardSetupSource).toContain(
      'runtimeStatus?.setupAvailable === true'
    );
    expect(cloudDashboardSetupSource).toContain(
      'runtimeStatus?.controlsAvailable === true'
    );
    expect(dashboardSource).toContain('copy.trial.runtimeUnavailable');

    const deletePanelStart = dashboardSource.indexOf(
      'function DeleteSpacePanel'
    );
    const copyableFieldStart = dashboardSource.indexOf(
      'function CopyableField'
    );
    const deletePanelSource = dashboardSource.slice(
      deletePanelStart,
      copyableFieldStart
    );
    expect(deletePanelSource).not.toContain('runtimeStatus');
    expect(cloudDashboardSetupSource).toContain("space.status === 'active'");
    expect(deletePanelSource).toContain('deleteSpaceAction');
  });

  it('builds a successful runtime view with setup, member count, and trial time state', () => {
    const runtimeView = buildCloudDashboardExistingSpaceRuntimeView({
      state: sampleExistingSpaceState(),
      runtimeStatus: sampleRuntimeStatus()
    });

    expect(runtimeView.setup?.setupCommand?.command).toBe(
      "teamem init --join --server-url https://runtime.teamem.test --room-code ABCD1234 --member-name '<your-name>'"
    );
    expect(runtimeView.canRotateRoomCode).toBe(true);
    expect(runtimeView.canDeleteSpace).toBe(true);
    expect(runtimeView.freeTrial).toEqual({
      status: 'available',
      trialExpiresAt: '2026-06-01T00:00:00.000Z',
      memberLimit: 3,
      activeUserFacingMemberCount: 2
    });
  });

  it('returns null when the dashboard runtime status client throws', async () => {
    const status = await getCloudDashboardRuntimeStatus({
      state: sampleExistingSpaceState(),
      client: {
        async getSpaceRuntimeStatus() {
          throw new Error('mismatched runtime IDs');
        }
      }
    });

    expect(status).toBeNull();
  });

  it('returns null when the dashboard runtime status client factory throws', async () => {
    const status = await getCloudDashboardRuntimeStatus({
      state: sampleExistingSpaceState(),
      client() {
        throw new Error('runtime provisioning env is missing');
      }
    });

    expect(status).toBeNull();
  });

  it('fails dashboard runtime affordances closed while keeping delete available', () => {
    const runtimeView = buildCloudDashboardExistingSpaceRuntimeView({
      state: sampleExistingSpaceState(),
      runtimeStatus: null
    });

    expect(runtimeView.setup).toBeNull();
    expect(runtimeView.canRotateRoomCode).toBe(false);
    expect(runtimeView.canDeleteSpace).toBe(true);
    expect(runtimeView.freeTrial).toEqual({ status: 'runtime_unavailable' });
  });

  it('formats localized expiry labels through the client formatter used after mount', () => {
    const labels = formatClientTrialTime(
      '2026-06-01T00:00:00.000Z',
      'en',
      'Expired',
      Date.parse('2026-05-30T00:00:00.000Z')
    );

    expect(labels.relativeLabel).toBe('in 2 days');
    expect(labels.exactLabel).toBe(
      new Intl.DateTimeFormat('en', {
        dateStyle: 'medium',
        timeStyle: 'short'
      }).format(new Date('2026-06-01T00:00:00.000Z'))
    );
    expect(trialTimeSource).toContain('useEffect');
    expect(trialTimeSource).toContain('setLabels(formatClientTrialTime');
    expect(trialTimeSource).toContain('suppressHydrationWarning');
    expect(trialTimeSource).toContain("{labels?.exactLabel ?? '...'}");
  });

  it('renders free-trial time and member limit from live runtime status with browser localization', () => {
    expect(dashboardSource).toContain('ExistingFreeTrialStatus');
    expect(dashboardSource).toContain('runtimeView.freeTrial.trialExpiresAt');
    expect(dashboardSource).toContain(
      'runtimeView.freeTrial.activeUserFacingMemberCount'
    );
    expect(dashboardSource).toContain('runtimeView.freeTrial.memberLimit');
    expect(trialTimeSource).toContain("'use client'");
    expect(messagesSource).toContain('"Trial ends"');
    expect(messagesSource).toContain('"Members"');
    expect(koreanMessagesSource).toContain('"체험 종료"');
  });

  it('uses launch-ready Free trial copy without paid-plan upgrade CTAs', () => {
    const englishMessages = JSON.parse(messagesSource) as {
      DashboardPage: {
        trial: { label: string; expired: string };
        quota: {
          title: string;
          blocked: string;
          consumedTitle: string;
          consumedText: string;
          reasons: {
            activeFreeSpaceExists: string;
            freeTrialAlreadyUsed: string;
          };
        };
        statuses: { spacePlan: { free: string } };
      };
    };
    const renderedDashboardCopy = [
      englishMessages.DashboardPage.trial.label,
      englishMessages.DashboardPage.trial.expired,
      englishMessages.DashboardPage.quota.title,
      englishMessages.DashboardPage.quota.blocked,
      englishMessages.DashboardPage.quota.consumedTitle,
      englishMessages.DashboardPage.quota.consumedText,
      englishMessages.DashboardPage.quota.reasons.activeFreeSpaceExists,
      englishMessages.DashboardPage.quota.reasons.freeTrialAlreadyUsed,
      englishMessages.DashboardPage.statuses.spacePlan.free
    ].join('\n');

    expect(renderedDashboardCopy).toContain('Free trial');
    expect(renderedDashboardCopy).toContain('Trial ends');
    expect(renderedDashboardCopy).toContain('Trial ended');
    expect(renderedDashboardCopy).not.toMatch(
      /upgrade|paid|billing|subscribe/i
    );
    expect(dashboardSource).not.toMatch(/upgrade|paid|billing|subscribe/i);
  });

  it('never renders a negative trial countdown after expiry', () => {
    const labels = formatClientTrialTime(
      '2026-06-01T00:00:00.000Z',
      'en',
      'Trial ended',
      Date.parse('2026-06-02T00:00:00.000Z')
    );

    expect(labels.relativeLabel).toBe('Trial ended');
    expect(labels.relativeLabel).not.toMatch(/ago|-1|-\d/);
  });

  it('keeps expiry localization browser-only without location persistence', () => {
    const dashboardAndFormatterSource = [
      dashboardSource,
      trialTimeSource,
      readFileSync(
        join(
          process.cwd(),
          'apps/web/app/[locale]/dashboard/trial-time-format.ts'
        ),
        'utf8'
      )
    ].join('\n');

    expect(trialTimeSource).toContain("'use client'");
    expect(dashboardAndFormatterSource).toContain('Intl.DateTimeFormat');
    expect(dashboardAndFormatterSource).toContain('Intl.RelativeTimeFormat');
    expect(dashboardAndFormatterSource).not.toMatch(
      /country|location|timezone|timeZone/
    );
  });
});

function sampleExistingSpaceState(): Extract<
  CloudDashboardState,
  { kind: 'existing-space' }
> {
  return {
    kind: 'existing-space',
    account: {
      id: 'account-1',
      betterAuthUserId: 'user-1',
      email: 'user@example.com',
      displayName: 'User',
      createdAt: '2026-05-20T00:00:00.000Z',
      updatedAt: '2026-05-20T00:00:00.000Z'
    },
    space: {
      id: 'csp-1',
      ownerAccountId: 'account-1',
      displayName: 'Launch Space',
      plan: 'free',
      status: 'active',
      trialExpiresAt: '2026-06-01T00:00:00.000Z',
      memberLimit: 3,
      runtimeSpaceId: 'runtime-1',
      runtimeServerUrl: 'https://runtime.teamem.test',
      roomCodeDisplayMetadata: {
        code: 'ABCD1234',
        label: null,
        lastRotatedAt: null
      },
      requestedAt: '2026-05-20T00:00:00.000Z',
      provisionedAt: '2026-05-20T00:00:00.000Z',
      suspendedAt: null,
      suspensionReason: null,
      deletedAt: null,
      createdAt: '2026-05-20T00:00:00.000Z',
      updatedAt: '2026-05-20T00:00:00.000Z'
    },
    quota: {
      canCreateFreeSpace: false,
      blockedReason: 'active_free_space_exists'
    }
  };
}

function sampleRuntimeStatus(): CloudSpaceRuntimeStatus {
  return {
    controlPlaneSpaceId: 'csp-1',
    runtimeSpaceId: 'runtime-1',
    plan: 'free',
    trialExpiresAt: '2026-06-01T00:00:00.000Z',
    memberLimit: 3,
    activeUserFacingMemberCount: 2,
    suspendedAt: null,
    suspensionReason: null,
    setupAvailable: true,
    controlsAvailable: true
  };
}
