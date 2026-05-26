import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { buildCloudDashboardExistingSpaceRuntimeView } from '@teamem/cloud';
import { auth } from '../../../src/server/auth';
import { getDashboardStateForUser } from '../../../src/server/control-plane';
import {
  getDashboardRuntimeStatus,
  type DashboardRuntimeStatus
} from '../../../src/server/dashboard-runtime-status';
import {
  createFreeSpaceAction,
  deleteSpaceAction,
  rotateRoomCodeAction
} from './actions';
import { CopyButton } from './copy-button';
import { LanguageSwitcher } from '../../../src/components/language-switcher';
import { buildLocalizedMetadata } from '../../../src/i18n/metadata';
import { normalizeLocale } from '../../../src/i18n/return-target';
import { RotateRoomCodeButton } from './rotate-room-code-button';
import { SubmitButton } from './submit-button';
import { TrialTime } from './trial-time';
import { PostHogIdentify } from './posthog-identify';

export const dynamic = 'force-dynamic';

type DashboardState = Awaited<ReturnType<typeof getDashboardStateForUser>>;
type CopyLabels = {
  copy: string;
  copied: string;
  aria: string;
};
type StatusMessages<T extends string> = Record<T, string>;
type DashboardCopy = {
  brand: string;
  webAccountOnly: string;
  eyebrow: string;
  title: string;
  description: string;
  accountTitle: string;
  accountText: string;
  spaceLabel: string;
  setup: {
    runtimeServerLabel: string;
    roomCodeLabel: string;
    title: string;
    bootstrapperPrefix: string;
    setupCommandLabel: string;
    setupCommandUnavailable: string;
    launchPrefix: string;
    launchSuffix: string;
    verifyPrefix: string;
    unavailable: string;
  };
  trial: {
    label: string;
    expired: string;
    members: string;
    runtimeUnavailable: string;
  };
  roomCode: {
    title: string;
    description: string;
    unavailable: string;
    rotateLabel: string;
    rotatePendingLabel: string;
  };
  deleteSpace: {
    title: string;
    description: string;
    confirmLabel: string;
    buttonLabel: string;
    pendingLabel: string;
    unavailable: string;
  };
  quota: {
    title: string;
    blocked: string;
    consumedTitle: string;
    consumedText: string;
    reasons: {
      activeFreeSpaceExists: string;
      freeTrialAlreadyUsed: string;
      unknown: string;
    };
  };
  retry: {
    title: string;
    description: string;
    buttonLabel: string;
    pendingLabel: string;
  };
  create: {
    title: string;
    description: string;
    displayNameLabel: string;
    buttonLabel: string;
    pendingLabel: string;
  };
  copy: CopyLabels;
  statuses: {
    create: StatusMessages<Exclude<CreateStatus, null>>;
    rotate: StatusMessages<Exclude<RotateStatus, null>>;
    delete: StatusMessages<Exclude<DeleteStatus, null>>;
    spaceStatus: Record<string, string>;
    spacePlan: Record<string, string>;
  };
};

export async function generateMetadata({
  params
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale: rawLocale } = await params;
  const locale = normalizeLocale(rawLocale);
  const t = await getTranslations({ locale, namespace: 'Metadata.dashboard' });

  return buildLocalizedMetadata({
    locale,
    path: '/dashboard',
    title: t('title'),
    description: t('description')
  });
}

export default async function DashboardPage({
  params,
  searchParams
}: {
  params: Promise<{ locale: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'DashboardPage' });
  const copy = buildDashboardCopy(t);
  const session = await auth.api.getSession({
    headers: await headers()
  });

  if (!session) {
    redirect(`/${locale}/login?from=/${locale}/dashboard`);
  }

  const displayName = session.user.name || session.user.email;
  const dashboardState = await getDashboardStateForUser({
    betterAuthUserId: session.user.id,
    email: session.user.email,
    displayName
  });
  const runtimeStatus = await getDashboardRuntimeStatus(dashboardState);
  const resolvedSearchParams = await searchParams;
  const createStatus = getCreateStatus(resolvedSearchParams);
  const rotateStatus = getRotateStatus(resolvedSearchParams);
  const deleteStatus = getDeleteStatus(resolvedSearchParams);

  return (
    <main className="min-h-screen bg-background text-foreground">
      <PostHogIdentify userId={session.user.id} email={session.user.email} />
      <section className="mx-auto flex min-h-screen w-full max-w-6xl flex-col px-5 py-5 sm:px-8 lg:px-10">
        <header className="flex items-center justify-between border-b border-border pb-4">
          <a className="text-sm font-semibold" href={`/${locale}`}>
            {copy.brand}
          </a>
          <div className="flex min-w-0 items-center gap-3">
            <LanguageSwitcher />
            <div className="min-w-0 text-right text-sm text-muted-foreground">
              <p className="truncate text-foreground">{displayName}</p>
              <p>{copy.webAccountOnly}</p>
            </div>
          </div>
        </header>

        <div className="flex flex-1 flex-col justify-center gap-6 py-12">
          <div className="max-w-2xl space-y-3">
            <p className="w-fit rounded-sm border border-border bg-muted px-3 py-1 text-xs font-medium uppercase text-muted-foreground">
              {copy.eyebrow}
            </p>
            <h1 className="text-3xl font-semibold sm:text-4xl">{copy.title}</h1>
            <p className="text-base leading-7 text-muted-foreground">
              {copy.description}
            </p>
          </div>

          <DashboardStateView
            state={dashboardState}
            runtimeStatus={runtimeStatus}
            copy={copy}
            locale={locale}
            defaultSpaceDisplayName={t('defaultSpaceDisplayName', {
              displayName
            })}
            createStatus={createStatus}
            rotateStatus={rotateStatus}
            deleteStatus={deleteStatus}
          />
        </div>
      </section>
    </main>
  );
}

function DashboardStateView({
  state,
  runtimeStatus,
  copy,
  locale,
  defaultSpaceDisplayName,
  createStatus,
  rotateStatus,
  deleteStatus
}: {
  state: DashboardState;
  runtimeStatus: DashboardRuntimeStatus;
  copy: DashboardCopy;
  locale: string;
  defaultSpaceDisplayName: string;
  createStatus: CreateStatus;
  rotateStatus: RotateStatus;
  deleteStatus: DeleteStatus;
}) {
  if (state.kind === 'no-space') {
    return (
      <NoSpaceState
        copy={copy}
        defaultSpaceDisplayName={defaultSpaceDisplayName}
        createStatus={createStatus}
      />
    );
  }

  if (state.kind === 'free-trial-consumed') {
    return <FreeTrialConsumedState copy={copy} state={state} />;
  }

  const runtimeView = buildCloudDashboardExistingSpaceRuntimeView({
    state,
    runtimeStatus
  });

  return (
    <section className="grid gap-4 border-t border-border pt-5 lg:grid-cols-[1.2fr_0.8fr]">
      <ExistingSpaceState copy={copy} runtimeView={runtimeView} state={state} />
      <ExistingFreeTrialStatus
        copy={copy}
        locale={locale}
        runtimeView={runtimeView}
      />
      <RoomCodeRotationPanel
        copy={copy}
        runtimeView={runtimeView}
        rotateStatus={rotateStatus}
      />
      <DeleteSpacePanel
        copy={copy}
        runtimeView={runtimeView}
        deleteStatus={deleteStatus}
      />
      {isRetryablePendingProvisioningSpace(state.space) ? (
        <RetryProvisioningPanel
          copy={copy}
          state={state}
          createStatus={createStatus}
        />
      ) : state.quota.canCreateFreeSpace ? (
        <CreateFreeSpacePanel
          copy={copy}
          defaultSpaceDisplayName={defaultSpaceDisplayName}
          createStatus={createStatus}
        />
      ) : (
        <QuotaBlockedState
          copy={copy}
          blockedReason={state.quota.blockedReason}
        />
      )}
    </section>
  );
}

function isRetryablePendingProvisioningSpace(
  space: Extract<DashboardState, { kind: 'existing-space' }>['space']
): boolean {
  return (
    space.status === 'provisioning_pending' &&
    !space.runtimeSpaceId &&
    !space.runtimeServerUrl
  );
}

function NoSpaceState({
  copy,
  defaultSpaceDisplayName,
  createStatus
}: {
  copy: DashboardCopy;
  defaultSpaceDisplayName: string;
  createStatus: CreateStatus;
}) {
  return (
    <section className="grid gap-4 border-t border-border pt-5 lg:grid-cols-[0.8fr_1.2fr]">
      <DashboardPanel label={copy.accountTitle} text={copy.accountText} />
      <CreateFreeSpacePanel
        copy={copy}
        defaultSpaceDisplayName={defaultSpaceDisplayName}
        createStatus={createStatus}
      />
    </section>
  );
}

function ExistingSpaceState({
  copy,
  state,
  runtimeView
}: {
  copy: DashboardCopy;
  state: Extract<DashboardState, { kind: 'existing-space' }>;
  runtimeView: ReturnType<typeof buildCloudDashboardExistingSpaceRuntimeView>;
}) {
  return (
    <article className="space-y-5 border-l border-border pl-4">
      <div>
        <h2 className="text-sm font-semibold">{state.space.displayName}</h2>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">
          {formatSpacePlan(state.space.plan, copy)} {copy.spaceLabel} /{' '}
          {formatSpaceStatus(state.space.status, copy)}
        </p>
      </div>
      {runtimeView.setup ? (
        <>
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <CopyableField
              copy={copy.copy}
              field={{
                ...runtimeView.setup.runtimeServer,
                label: copy.setup.runtimeServerLabel
              }}
            />
            <CopyableField
              copy={copy.copy}
              field={{
                ...runtimeView.setup.roomCode,
                label: copy.setup.roomCodeLabel
              }}
            />
          </dl>
          <div className="space-y-3 border-t border-border pt-4">
            <div>
              <h3 className="text-sm font-semibold">{copy.setup.title}</h3>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">
                {copy.setup.bootstrapperPrefix}
                <code className="ml-1 break-words text-foreground">
                  npm install -g @rubiyh05/teamem
                </code>
              </p>
            </div>
            {runtimeView.setup.setupCommand ? (
              <div className="space-y-2">
                <div className="flex items-start justify-between gap-3">
                  <p className="text-xs font-medium uppercase text-muted-foreground">
                    {copy.setup.setupCommandLabel}
                  </p>
                  <CopyButton
                    ariaLabel={copy.copy.aria.replace(
                      '{label}',
                      copy.setup.setupCommandLabel
                    )}
                    copiedLabel={copy.copy.copied}
                    copyLabel={copy.copy.copy}
                    value={runtimeView.setup.setupCommand.command}
                  />
                </div>
                <pre className="overflow-x-auto border border-border bg-muted p-3 text-sm text-foreground">
                  <code>{runtimeView.setup.setupCommand.command}</code>
                </pre>
              </div>
            ) : (
              <p className="text-sm leading-6 text-muted-foreground">
                {copy.setup.setupCommandUnavailable}
              </p>
            )}
            <p className="text-sm leading-6 text-muted-foreground">
              {copy.setup.launchPrefix}
              <code className="mx-1 text-foreground">
                teamem claude install
              </code>
              {copy.setup.launchSuffix}
              <code className="mx-1 text-foreground">claude</code>
              {copy.setup.verifyPrefix}
              <code className="ml-1 text-foreground">/teamem-status</code>.
            </p>
          </div>
        </>
      ) : (
        <p className="text-sm leading-6 text-muted-foreground">
          {copy.setup.unavailable}
        </p>
      )}
    </article>
  );
}

function ExistingFreeTrialStatus({
  copy,
  locale,
  runtimeView
}: {
  copy: DashboardCopy;
  locale: string;
  runtimeView: ReturnType<typeof buildCloudDashboardExistingSpaceRuntimeView>;
}) {
  if (!runtimeView.freeTrial) {
    return null;
  }

  if (runtimeView.freeTrial.status === 'runtime_unavailable') {
    return (
      <article className="space-y-2 border-l border-border pl-4">
        <h2 className="text-sm font-semibold">
          {copy.statuses.spacePlan.free}
        </h2>
        <p className="text-sm leading-6 text-muted-foreground">
          {copy.trial.runtimeUnavailable}
        </p>
      </article>
    );
  }

  return (
    <article className="space-y-2 border-l border-border pl-4">
      <h2 className="text-sm font-semibold">{copy.statuses.spacePlan.free}</h2>
      {runtimeView.freeTrial.trialExpiresAt ? (
        <TrialTime
          expiredLabel={copy.trial.expired}
          expiresAt={runtimeView.freeTrial.trialExpiresAt}
          label={copy.trial.label}
          locale={locale}
        />
      ) : null}
      {runtimeView.freeTrial.memberLimit === null ? null : (
        <p className="text-sm leading-6 text-muted-foreground">
          {copy.trial.members}:{' '}
          <span className="text-foreground">
            {runtimeView.freeTrial.activeUserFacingMemberCount} /{' '}
            {runtimeView.freeTrial.memberLimit}
          </span>
        </p>
      )}
    </article>
  );
}

function RoomCodeRotationPanel({
  copy,
  runtimeView,
  rotateStatus
}: {
  copy: DashboardCopy;
  runtimeView: ReturnType<typeof buildCloudDashboardExistingSpaceRuntimeView>;
  rotateStatus: RotateStatus;
}) {
  return (
    <article className="space-y-3 border-l border-border pl-4">
      <div>
        <h2 className="text-sm font-semibold">{copy.roomCode.title}</h2>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">
          {copy.roomCode.description}
        </p>
      </div>
      {rotateStatus ? (
        <p className="text-sm leading-6 text-muted-foreground">
          {copy.statuses.rotate[rotateStatus]}
        </p>
      ) : null}
      {runtimeView.canRotateRoomCode ? (
        <form action={rotateRoomCodeAction}>
          <RotateRoomCodeButton
            label={copy.roomCode.rotateLabel}
            pendingLabel={copy.roomCode.rotatePendingLabel}
          />
        </form>
      ) : (
        <p className="text-sm leading-6 text-muted-foreground">
          {copy.roomCode.unavailable}
        </p>
      )}
    </article>
  );
}

function DeleteSpacePanel({
  copy,
  runtimeView,
  deleteStatus
}: {
  copy: DashboardCopy;
  runtimeView: ReturnType<typeof buildCloudDashboardExistingSpaceRuntimeView>;
  deleteStatus: DeleteStatus;
}) {
  return (
    <article className="space-y-3 border-l border-border pl-4">
      <div>
        <h2 className="text-sm font-semibold">{copy.deleteSpace.title}</h2>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">
          {copy.deleteSpace.description}
        </p>
      </div>
      {deleteStatus ? (
        <p className="text-sm leading-6 text-muted-foreground">
          {copy.statuses.delete[deleteStatus]}
        </p>
      ) : null}
      {runtimeView.canDeleteSpace ? (
        <form action={deleteSpaceAction} className="max-w-sm space-y-3">
          <label className="flex items-start gap-2 text-sm leading-6 text-muted-foreground">
            <input
              className="mt-1 h-4 w-4 border border-border"
              name="confirmDelete"
              required
              type="checkbox"
            />
            <span>{copy.deleteSpace.confirmLabel}</span>
          </label>
          <SubmitButton
            className="border border-border px-4 py-2 text-sm font-semibold text-foreground"
            label={copy.deleteSpace.buttonLabel}
            pendingLabel={copy.deleteSpace.pendingLabel}
          />
        </form>
      ) : (
        <p className="text-sm leading-6 text-muted-foreground">
          {copy.deleteSpace.unavailable}
        </p>
      )}
    </article>
  );
}

function CopyableField({
  copy,
  field
}: {
  copy: CopyLabels;
  field: {
    label: string;
    text: string;
    copyValue: string | null;
  };
}) {
  return (
    <div>
      <dt className="flex items-center justify-between gap-3 text-muted-foreground">
        <span>{field.label}</span>
        <CopyButton
          ariaLabel={copy.aria.replace('{label}', field.label)}
          copiedLabel={copy.copied}
          copyLabel={copy.copy}
          value={field.copyValue}
        />
      </dt>
      <dd className="mt-1 break-words text-foreground">{field.text}</dd>
    </div>
  );
}

function QuotaBlockedState({
  blockedReason,
  copy
}: {
  blockedReason: string;
  copy: DashboardCopy;
}) {
  return (
    <article className="space-y-2 border-l border-border pl-4">
      <h2 className="text-sm font-semibold">{copy.quota.title}</h2>
      <p className="text-sm leading-6 text-muted-foreground">
        {copy.quota.blocked}
      </p>
      <p className="text-xs uppercase text-muted-foreground">
        {formatQuotaReason(blockedReason, copy)}
      </p>
    </article>
  );
}

function FreeTrialConsumedState({
  copy,
  state
}: {
  copy: DashboardCopy;
  state: Extract<DashboardState, { kind: 'free-trial-consumed' }>;
}) {
  return (
    <section className="grid gap-4 border-t border-border pt-5 lg:grid-cols-[0.8fr_1.2fr]">
      <DashboardPanel label={copy.accountTitle} text={copy.accountText} />
      <article className="space-y-2 border-l border-border pl-4">
        <h2 className="text-sm font-semibold">{copy.quota.consumedTitle}</h2>
        <p className="text-sm leading-6 text-muted-foreground">
          {copy.quota.consumedText}
        </p>
        <p className="text-xs uppercase text-muted-foreground">
          {formatQuotaReason(state.quota.blockedReason, copy)}
        </p>
      </article>
    </section>
  );
}

function RetryProvisioningPanel({
  copy,
  state,
  createStatus
}: {
  copy: DashboardCopy;
  state: Extract<DashboardState, { kind: 'existing-space' }>;
  createStatus: CreateStatus;
}) {
  return (
    <article className="space-y-4 border-l border-border pl-4">
      <div>
        <h2 className="text-sm font-semibold">{copy.retry.title}</h2>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">
          {copy.retry.description}
        </p>
      </div>
      {createStatus ? (
        <p className="text-sm leading-6 text-muted-foreground">
          {copy.statuses.create[createStatus]}
        </p>
      ) : null}
      <form action={createFreeSpaceAction} className="max-w-sm space-y-3">
        <input
          name="spaceDisplayName"
          type="hidden"
          value={state.space.displayName}
        />
        <SubmitButton
          className="border border-foreground bg-foreground px-4 py-2 text-sm font-semibold text-background"
          label={copy.retry.buttonLabel}
          pendingLabel={copy.retry.pendingLabel}
        />
      </form>
    </article>
  );
}

function CreateFreeSpacePanel({
  copy,
  defaultSpaceDisplayName,
  createStatus
}: {
  copy: DashboardCopy;
  defaultSpaceDisplayName: string;
  createStatus: CreateStatus;
}) {
  return (
    <article className="space-y-4 border-l border-border pl-4">
      <div>
        <h2 className="text-sm font-semibold">{copy.create.title}</h2>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">
          {copy.create.description}
        </p>
      </div>
      {createStatus ? (
        <p className="text-sm leading-6 text-muted-foreground">
          {copy.statuses.create[createStatus]}
        </p>
      ) : null}
      <form action={createFreeSpaceAction} className="max-w-sm space-y-3">
        <label
          className="block text-xs font-medium uppercase text-muted-foreground"
          htmlFor="spaceDisplayName"
        >
          {copy.create.displayNameLabel}
        </label>
        <input
          className="w-full border border-border bg-background px-3 py-2 text-sm text-foreground outline-none"
          defaultValue={defaultSpaceDisplayName}
          id="spaceDisplayName"
          maxLength={80}
          minLength={1}
          name="spaceDisplayName"
          required
          type="text"
        />
        <SubmitButton
          className="border border-foreground bg-foreground px-4 py-2 text-sm font-semibold text-background"
          label={copy.create.buttonLabel}
          pendingLabel={copy.create.pendingLabel}
        />
      </form>
    </article>
  );
}

function DashboardPanel({ label, text }: { label: string; text: string }) {
  return (
    <article className="space-y-2 border-l border-border pl-4">
      <h2 className="text-sm font-semibold">{label}</h2>
      <p className="text-sm leading-6 text-muted-foreground">{text}</p>
    </article>
  );
}

type CreateStatus =
  | 'created'
  | 'quota'
  | 'trial-used'
  | 'display-name'
  | 'reconcile'
  | 'runtime-failed'
  | null;

type RotateStatus =
  | 'success'
  | 'missing'
  | 'unavailable'
  | 'reconcile'
  | 'failed'
  | null;

type DeleteStatus =
  | 'success'
  | 'confirm'
  | 'missing'
  | 'unavailable'
  | 'reconcile'
  | 'failed'
  | null;

function getCreateStatus(
  searchParams?: Record<string, string | string[] | undefined>
): CreateStatus {
  if (searchParams?.created === '1') {
    return 'created';
  }
  const status = searchParams?.create;
  if (
    status === 'quota' ||
    status === 'trial-used' ||
    status === 'display-name' ||
    status === 'reconcile' ||
    status === 'runtime-failed'
  ) {
    return status;
  }
  return null;
}

function getRotateStatus(
  searchParams?: Record<string, string | string[] | undefined>
): RotateStatus {
  const status = searchParams?.rotate;
  if (
    status === 'success' ||
    status === 'missing' ||
    status === 'unavailable' ||
    status === 'reconcile' ||
    status === 'failed'
  ) {
    return status;
  }
  return null;
}

function getDeleteStatus(
  searchParams?: Record<string, string | string[] | undefined>
): DeleteStatus {
  const status = searchParams?.delete;
  if (
    status === 'success' ||
    status === 'confirm' ||
    status === 'missing' ||
    status === 'unavailable' ||
    status === 'reconcile' ||
    status === 'failed'
  ) {
    return status;
  }
  return null;
}

function buildDashboardCopy(
  t: Awaited<ReturnType<typeof getTranslations>>
): DashboardCopy {
  return {
    brand: t('brand'),
    webAccountOnly: t('webAccountOnly'),
    eyebrow: t('eyebrow'),
    title: t('title'),
    description: t('description'),
    accountTitle: t('account.title'),
    accountText: t('account.text'),
    spaceLabel: t('space.label'),
    setup: {
      runtimeServerLabel: t('setup.runtimeServerLabel'),
      roomCodeLabel: t('setup.roomCodeLabel'),
      title: t('setup.title'),
      bootstrapperPrefix: t('setup.bootstrapperPrefix'),
      setupCommandLabel: t('setup.setupCommandLabel'),
      setupCommandUnavailable: t('setup.setupCommandUnavailable'),
      launchPrefix: t('setup.launchPrefix'),
      launchSuffix: t('setup.launchSuffix'),
      verifyPrefix: t('setup.verifyPrefix'),
      unavailable: t('setup.unavailable')
    },
    trial: {
      label: t('trial.label'),
      expired: t('trial.expired'),
      members: t('trial.members'),
      runtimeUnavailable: t('trial.runtimeUnavailable')
    },
    roomCode: {
      title: t('roomCode.title'),
      description: t('roomCode.description'),
      unavailable: t('roomCode.unavailable'),
      rotateLabel: t('roomCode.rotateLabel'),
      rotatePendingLabel: t('roomCode.rotatePendingLabel')
    },
    deleteSpace: {
      title: t('delete.title'),
      description: t('delete.description'),
      confirmLabel: t('delete.confirmLabel'),
      buttonLabel: t('delete.buttonLabel'),
      pendingLabel: t('delete.pendingLabel'),
      unavailable: t('delete.unavailable')
    },
    quota: {
      title: t('quota.title'),
      blocked: t('quota.blocked'),
      consumedTitle: t('quota.consumedTitle'),
      consumedText: t('quota.consumedText'),
      reasons: {
        activeFreeSpaceExists: t('quota.reasons.activeFreeSpaceExists'),
        freeTrialAlreadyUsed: t('quota.reasons.freeTrialAlreadyUsed'),
        unknown: t('quota.reasons.unknown')
      }
    },
    retry: {
      title: t('retry.title'),
      description: t('retry.description'),
      buttonLabel: t('retry.buttonLabel'),
      pendingLabel: t('retry.pendingLabel')
    },
    create: {
      title: t('create.title'),
      description: t('create.description'),
      displayNameLabel: t('create.displayNameLabel'),
      buttonLabel: t('create.buttonLabel'),
      pendingLabel: t('create.pendingLabel')
    },
    copy: {
      copy: t('copy.copy'),
      copied: t('copy.copied'),
      aria: t('copy.aria', { label: '{label}' })
    },
    statuses: {
      create: {
        created: t('statuses.create.created'),
        quota: t('statuses.create.quota'),
        'trial-used': t('statuses.create.trialUsed'),
        'display-name': t('statuses.create.displayName'),
        reconcile: t('statuses.create.reconcile'),
        'runtime-failed': t('statuses.create.runtimeFailed')
      },
      rotate: {
        success: t('statuses.rotate.success'),
        missing: t('statuses.rotate.missing'),
        unavailable: t('statuses.rotate.unavailable'),
        reconcile: t('statuses.rotate.reconcile'),
        failed: t('statuses.rotate.failed')
      },
      delete: {
        success: t('statuses.delete.success'),
        confirm: t('statuses.delete.confirm'),
        missing: t('statuses.delete.missing'),
        unavailable: t('statuses.delete.unavailable'),
        reconcile: t('statuses.delete.reconcile'),
        failed: t('statuses.delete.failed')
      },
      spaceStatus: {
        active: t('statuses.spaceStatus.active'),
        provisioning_pending: t('statuses.spaceStatus.provisioningPending'),
        delete_pending: t('statuses.spaceStatus.deletePending'),
        suspended: t('statuses.spaceStatus.suspended'),
        provisioning_failed: t('statuses.spaceStatus.provisioningFailed')
      },
      spacePlan: {
        free: t('statuses.spacePlan.free')
      }
    }
  };
}

function formatSpacePlan(plan: string, copy: DashboardCopy): string {
  return copy.statuses.spacePlan[plan] ?? plan;
}

function formatSpaceStatus(status: string, copy: DashboardCopy): string {
  return copy.statuses.spaceStatus[status] ?? status;
}

function formatQuotaReason(reason: string, copy: DashboardCopy): string {
  if (reason === 'active_free_space_exists') {
    return copy.quota.reasons.activeFreeSpaceExists;
  }
  if (reason === 'free_trial_already_used') {
    return copy.quota.reasons.freeTrialAlreadyUsed;
  }

  return copy.quota.reasons.unknown;
}
