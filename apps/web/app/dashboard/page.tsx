import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { buildCloudDashboardSetupView } from '@teamem/cloud';
import { auth } from '../../src/server/auth';
import { getDashboardStateForUser } from '../../src/server/control-plane';
import {
  createFreeSpaceAction,
  deleteSpaceAction,
  rotateRoomCodeAction
} from './actions';
import { CopyButton } from './copy-button';
import { RotateRoomCodeButton } from './rotate-room-code-button';

export const dynamic = 'force-dynamic';

type DashboardState = Awaited<ReturnType<typeof getDashboardStateForUser>>;

export default async function DashboardPage({
  searchParams
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await auth.api.getSession({
    headers: await headers()
  });

  if (!session) {
    redirect('/login?from=/dashboard');
  }

  const displayName = session.user.name || session.user.email;
  const dashboardState = await getDashboardStateForUser({
    betterAuthUserId: session.user.id,
    email: session.user.email,
    displayName
  });
  const resolvedSearchParams = await searchParams;
  const createStatus = getCreateStatus(resolvedSearchParams);
  const rotateStatus = getRotateStatus(resolvedSearchParams);
  const deleteStatus = getDeleteStatus(resolvedSearchParams);

  return (
    <main className="min-h-screen bg-background text-foreground">
      <section className="mx-auto flex min-h-screen w-full max-w-6xl flex-col px-5 py-5 sm:px-8 lg:px-10">
        <header className="flex items-center justify-between border-b border-border pb-4">
          <a className="text-sm font-semibold" href="/">
            Teamem Cloud
          </a>
          <div className="text-right text-sm text-muted-foreground">
            <p className="text-foreground">{displayName}</p>
            <p>Web account only</p>
          </div>
        </header>

        <div className="flex flex-1 flex-col justify-center gap-6 py-12">
          <div className="max-w-2xl space-y-3">
            <p className="w-fit rounded-sm border border-border bg-muted px-3 py-1 text-xs font-medium uppercase text-muted-foreground">
              Control plane
            </p>
            <h1 className="text-3xl font-semibold sm:text-4xl">Dashboard</h1>
            <p className="text-base leading-7 text-muted-foreground">
              You are signed in. This view creates and displays your Teamem
              Cloud Space while keeping web account identity separate from
              runtime member identity.
            </p>
          </div>

          <DashboardStateView
            state={dashboardState}
            defaultSpaceDisplayName={defaultSpaceDisplayName(displayName)}
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
  defaultSpaceDisplayName,
  createStatus,
  rotateStatus,
  deleteStatus
}: {
  state: DashboardState;
  defaultSpaceDisplayName: string;
  createStatus: CreateStatus;
  rotateStatus: RotateStatus;
  deleteStatus: DeleteStatus;
}) {
  if (state.kind === 'no-space') {
    return (
      <NoSpaceState
        defaultSpaceDisplayName={defaultSpaceDisplayName}
        createStatus={createStatus}
      />
    );
  }

  return (
    <section className="grid gap-4 border-t border-border pt-5 lg:grid-cols-[1.2fr_0.8fr]">
      <ExistingSpaceState state={state} />
      <RoomCodeRotationPanel state={state} rotateStatus={rotateStatus} />
      <DeleteSpacePanel state={state} deleteStatus={deleteStatus} />
      {isRetryablePendingProvisioningSpace(state.space) ? (
        <RetryProvisioningPanel state={state} createStatus={createStatus} />
      ) : state.quota.canCreateFreeSpace ? (
        <CreateFreeSpacePanel
          defaultSpaceDisplayName={defaultSpaceDisplayName}
          createStatus={createStatus}
        />
      ) : (
        <QuotaBlockedState blockedReason={state.quota.blockedReason} />
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
  defaultSpaceDisplayName,
  createStatus
}: {
  defaultSpaceDisplayName: string;
  createStatus: CreateStatus;
}) {
  return (
    <section className="grid gap-4 border-t border-border pt-5 lg:grid-cols-[0.8fr_1.2fr]">
      <DashboardPanel
        label="Account"
        text="OAuth session is active for dashboard access."
      />
      <CreateFreeSpacePanel
        defaultSpaceDisplayName={defaultSpaceDisplayName}
        createStatus={createStatus}
      />
    </section>
  );
}

function ExistingSpaceState({
  state
}: {
  state: Extract<DashboardState, { kind: 'existing-space' }>;
}) {
  const canShowSetup =
    state.space.status === 'active' &&
    Boolean(state.space.runtimeServerUrl) &&
    Boolean(state.space.roomCodeDisplayMetadata.code);
  const setup = canShowSetup
    ? buildCloudDashboardSetupView({
        runtimeServerUrl: state.space.runtimeServerUrl,
        roomCodeDisplayMetadata: state.space.roomCodeDisplayMetadata
      })
    : null;

  return (
    <article className="space-y-5 border-l border-border pl-4">
      <div>
        <h2 className="text-sm font-semibold">{state.space.displayName}</h2>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">
          {state.space.plan} Space / {state.space.status}
        </p>
      </div>
      {setup ? (
        <>
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <CopyableField field={setup.runtimeServer} />
            <CopyableField field={setup.roomCode} />
          </dl>
          <div className="space-y-3 border-t border-border pt-4">
            <div>
              <h3 className="text-sm font-semibold">Set up a teammate</h3>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">
                Install the bootstrapper first if needed:
                <code className="ml-1 break-words text-foreground">
                  npm install -g @rubiyh05/teamem
                </code>
              </p>
            </div>
            {setup.setupCommand ? (
              <div className="space-y-2">
                <div className="flex items-start justify-between gap-3">
                  <p className="text-xs font-medium uppercase text-muted-foreground">
                    Setup command
                  </p>
                  <CopyButton
                    label="setup command"
                    value={setup.setupCommand.command}
                  />
                </div>
                <pre className="overflow-x-auto border border-border bg-muted p-3 text-sm text-foreground">
                  <code>{setup.setupCommand.command}</code>
                </pre>
              </div>
            ) : (
              <p className="text-sm leading-6 text-muted-foreground">
                Setup command will appear when runtime provisioning finishes.
              </p>
            )}
            <p className="text-sm leading-6 text-muted-foreground">
              After setup, launch Claude Code with
              <code className="mx-1 text-foreground">teamem cc</code>
              and verify from Claude with
              <code className="ml-1 text-foreground">/teamem-status</code>.
            </p>
          </div>
        </>
      ) : (
        <p className="text-sm leading-6 text-muted-foreground">
          Active setup details are unavailable while this Space is not active.
        </p>
      )}
    </article>
  );
}

function RoomCodeRotationPanel({
  state,
  rotateStatus
}: {
  state: Extract<DashboardState, { kind: 'existing-space' }>;
  rotateStatus: RotateStatus;
}) {
  const canRotate =
    state.space.status === 'active' &&
    Boolean(state.space.runtimeSpaceId) &&
    Boolean(state.space.runtimeServerUrl);

  return (
    <article className="space-y-3 border-l border-border pl-4">
      <div>
        <h2 className="text-sm font-semibold">Room code</h2>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">
          Rotate the invite code for this Space.
        </p>
      </div>
      {rotateStatus ? (
        <p className="text-sm leading-6 text-muted-foreground">
          {rotateStatusMessage(rotateStatus)}
        </p>
      ) : null}
      {canRotate ? (
        <form action={rotateRoomCodeAction}>
          <RotateRoomCodeButton />
        </form>
      ) : (
        <p className="text-sm leading-6 text-muted-foreground">
          Room-code rotation will be available when runtime provisioning
          finishes.
        </p>
      )}
    </article>
  );
}

function DeleteSpacePanel({
  state,
  deleteStatus
}: {
  state: Extract<DashboardState, { kind: 'existing-space' }>;
  deleteStatus: DeleteStatus;
}) {
  const canDelete =
    state.space.status === 'active' || state.space.status === 'delete_pending';

  return (
    <article className="space-y-3 border-l border-border pl-4">
      <div>
        <h2 className="text-sm font-semibold">Delete Space</h2>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">
          Soft-delete this runtime Space and release the free quota only after
          the runtime confirms deletion.
        </p>
      </div>
      {deleteStatus ? (
        <p className="text-sm leading-6 text-muted-foreground">
          {deleteStatusMessage(deleteStatus)}
        </p>
      ) : null}
      {canDelete ? (
        <form action={deleteSpaceAction} className="max-w-sm space-y-3">
          <label className="flex items-start gap-2 text-sm leading-6 text-muted-foreground">
            <input
              className="mt-1 h-4 w-4 border border-border"
              name="confirmDelete"
              required
              type="checkbox"
            />
            <span>
              I understand this will disable active setup for this Space.
            </span>
          </label>
          <button
            className="border border-border px-4 py-2 text-sm font-semibold text-foreground"
            type="submit"
          >
            Delete Space
          </button>
        </form>
      ) : (
        <p className="text-sm leading-6 text-muted-foreground">
          Delete is available after runtime provisioning finishes.
        </p>
      )}
    </article>
  );
}

function CopyableField({
  field
}: {
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
        <CopyButton label={field.label.toLowerCase()} value={field.copyValue} />
      </dt>
      <dd className="mt-1 break-words text-foreground">{field.text}</dd>
    </div>
  );
}

function QuotaBlockedState({ blockedReason }: { blockedReason: string }) {
  return (
    <article className="space-y-2 border-l border-border pl-4">
      <h2 className="text-sm font-semibold">Free quota</h2>
      <p className="text-sm leading-6 text-muted-foreground">
        This account already has an active free Space, so creating another free
        Space is blocked by the control plane.
      </p>
      <p className="text-xs uppercase text-muted-foreground">{blockedReason}</p>
    </article>
  );
}

function RetryProvisioningPanel({
  state,
  createStatus
}: {
  state: Extract<DashboardState, { kind: 'existing-space' }>;
  createStatus: CreateStatus;
}) {
  return (
    <article className="space-y-4 border-l border-border pl-4">
      <div>
        <h2 className="text-sm font-semibold">Retry provisioning</h2>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">
          Teamem kept this Space request reserved after an uncertain runtime
          response. Retry uses the same Space request and idempotency key.
        </p>
      </div>
      {createStatus ? (
        <p className="text-sm leading-6 text-muted-foreground">
          {createStatusMessage(createStatus)}
        </p>
      ) : null}
      <form action={createFreeSpaceAction} className="max-w-sm space-y-3">
        <input
          name="spaceDisplayName"
          type="hidden"
          value={state.space.displayName}
        />
        <button
          className="border border-foreground bg-foreground px-4 py-2 text-sm font-semibold text-background"
          type="submit"
        >
          Retry provisioning
        </button>
      </form>
    </article>
  );
}

function CreateFreeSpacePanel({
  defaultSpaceDisplayName,
  createStatus
}: {
  defaultSpaceDisplayName: string;
  createStatus: CreateStatus;
}) {
  return (
    <article className="space-y-4 border-l border-border pl-4">
      <div>
        <h2 className="text-sm font-semibold">Create free Space</h2>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">
          Name the Space before provisioning starts.
        </p>
      </div>
      {createStatus ? (
        <p className="text-sm leading-6 text-muted-foreground">
          {createStatusMessage(createStatus)}
        </p>
      ) : null}
      <form action={createFreeSpaceAction} className="max-w-sm space-y-3">
        <label
          className="block text-xs font-medium uppercase text-muted-foreground"
          htmlFor="spaceDisplayName"
        >
          Space display name
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
        <button
          className="border border-foreground bg-foreground px-4 py-2 text-sm font-semibold text-background"
          type="submit"
        >
          Create free Space
        </button>
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

function createStatusMessage(status: Exclude<CreateStatus, null>): string {
  if (status === 'created') {
    return 'Your free Space is active.';
  }
  if (status === 'quota') {
    return 'This account already has an active free Space.';
  }
  if (status === 'display-name') {
    return 'Enter a Space display name before creating the Space.';
  }
  if (status === 'reconcile') {
    return 'Runtime provisioning did not return a confirmed result. Free quota remains reserved while Teamem retries with the same Space request.';
  }
  return 'Runtime provisioning failed with a confirmed terminal result. Try creating the Space again.';
}

function rotateStatusMessage(status: Exclude<RotateStatus, null>): string {
  if (status === 'success') {
    return 'Room code rotated.';
  }
  if (status === 'missing') {
    return 'No active Space was found for this account.';
  }
  if (status === 'unavailable') {
    return 'Runtime details are not ready for this Space.';
  }
  if (status === 'reconcile') {
    return 'Runtime rotated the room code, but dashboard metadata could not be fully saved.';
  }
  return 'Room-code rotation failed. The current code was not changed.';
}

function deleteStatusMessage(status: Exclude<DeleteStatus, null>): string {
  if (status === 'success') {
    return 'Space deleted. Free quota is available again.';
  }
  if (status === 'confirm') {
    return 'Confirm deletion before submitting.';
  }
  if (status === 'missing') {
    return 'No active Space was found for this account.';
  }
  if (status === 'unavailable') {
    return 'Runtime details are not ready for this Space.';
  }
  if (status === 'reconcile') {
    return 'Runtime deletion may have completed, but the dashboard could not fully save the result.';
  }
  return 'Runtime deletion failed. Free quota remains reserved for this Space.';
}

function defaultSpaceDisplayName(displayName: string): string {
  return `${displayName}'s Space`;
}
