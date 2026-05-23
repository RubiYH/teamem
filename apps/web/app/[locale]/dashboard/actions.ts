'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getLocale } from 'next-intl/server';
import { auth } from '../../../src/server/auth';
import { createFreeSpaceForUser } from '../../../src/server/create-free-space';
import { deleteSpaceForUser } from '../../../src/server/delete-space';
import { rotateRoomCodeForUser } from '../../../src/server/rotate-room-code';
import { capturePostHogServerEvent } from '../../../src/lib/posthog-server';

export async function createFreeSpaceAction(formData: FormData) {
  const dashboardPath = await getDashboardPath();
  const session = await auth.api.getSession({
    headers: await headers()
  });

  if (!session) {
    redirect(`${dashboardPath.login}?from=${dashboardPath.dashboard}`);
  }

  const spaceDisplayName = String(formData.get('spaceDisplayName') ?? '');
  const result = await createFreeSpaceForUser({
    user: {
      betterAuthUserId: session.user.id,
      email: session.user.email,
      displayName: session.user.name || session.user.email
    },
    spaceDisplayName
  });

  revalidatePath(dashboardPath.dashboard);

  if (result.ok) {
    await capturePostHogServerEvent({
      distinctId: session.user.id,
      event: 'space_created',
      properties: {
        space_display_name: spaceDisplayName,
        email: session.user.email
      }
    });
    redirect(`${dashboardPath.dashboard}?created=1`);
  }

  if (result.reason === 'active_free_space_exists') {
    await capturePostHogServerEvent({
      distinctId: session.user.id,
      event: 'space_creation_failed',
      properties: { reason: 'quota', email: session.user.email }
    });
    redirect(`${dashboardPath.dashboard}?create=quota`);
  }
  if (result.reason === 'free_trial_already_used') {
    redirect(`${dashboardPath.dashboard}?create=trial-used`);
  }
  if (result.reason === 'display_name_required') {
    await capturePostHogServerEvent({
      distinctId: session.user.id,
      event: 'space_creation_failed',
      properties: {
        reason: 'display_name_required',
        email: session.user.email
      }
    });
    redirect(`${dashboardPath.dashboard}?create=display-name`);
  }
  if (result.reason === 'control_plane_reconciliation_required') {
    await capturePostHogServerEvent({
      distinctId: session.user.id,
      event: 'space_creation_failed',
      properties: { reason: 'reconcile', email: session.user.email }
    });
    redirect(`${dashboardPath.dashboard}?create=reconcile`);
  }

  await capturePostHogServerEvent({
    distinctId: session.user.id,
    event: 'space_creation_failed',
    properties: { reason: 'runtime_failed', email: session.user.email }
  });
  redirect(`${dashboardPath.dashboard}?create=runtime-failed`);
}

export async function rotateRoomCodeAction() {
  const dashboardPath = await getDashboardPath();
  const session = await auth.api.getSession({
    headers: await headers()
  });

  if (!session) {
    redirect(`${dashboardPath.login}?from=${dashboardPath.dashboard}`);
  }

  const result = await rotateRoomCodeForUser({
    user: {
      betterAuthUserId: session.user.id,
      email: session.user.email,
      displayName: session.user.name || session.user.email
    }
  });

  revalidatePath(dashboardPath.dashboard);

  if (result.ok) {
    await capturePostHogServerEvent({
      distinctId: session.user.id,
      event: 'room_code_rotated',
      properties: { email: session.user.email }
    });
    redirect(`${dashboardPath.dashboard}?rotate=success`);
  }
  const rotateReason =
    result.reason === 'space_not_found' ? 'missing'
    : result.reason === 'runtime_details_missing' ? 'unavailable'
    : result.reason === 'control_plane_reconciliation_required' ? 'reconcile'
    : 'failed';
  await capturePostHogServerEvent({
    distinctId: session.user.id,
    event: 'room_code_rotation_failed',
    properties: { reason: rotateReason, email: session.user.email }
  });
  if (result.reason === 'space_not_found') {
    redirect(`${dashboardPath.dashboard}?rotate=missing`);
  }
  if (result.reason === 'runtime_details_missing') {
    redirect(`${dashboardPath.dashboard}?rotate=unavailable`);
  }
  if (result.reason === 'control_plane_reconciliation_required') {
    redirect(`${dashboardPath.dashboard}?rotate=reconcile`);
  }

  redirect(`${dashboardPath.dashboard}?rotate=failed`);
}

export async function deleteSpaceAction(formData: FormData) {
  const dashboardPath = await getDashboardPath();
  const session = await auth.api.getSession({
    headers: await headers()
  });

  if (!session) {
    redirect(`${dashboardPath.login}?from=${dashboardPath.dashboard}`);
  }

  const result = await deleteSpaceForUser({
    user: {
      betterAuthUserId: session.user.id,
      email: session.user.email,
      displayName: session.user.name || session.user.email
    },
    confirmationAccepted: formData.get('confirmDelete') === 'on'
  });

  revalidatePath(dashboardPath.dashboard);

  if (result.ok) {
    await capturePostHogServerEvent({
      distinctId: session.user.id,
      event: 'space_deleted',
      properties: { email: session.user.email }
    });
    redirect(`${dashboardPath.dashboard}?delete=success`);
  }
  const deleteReason =
    result.reason === 'confirmation_required' ? 'confirm'
    : result.reason === 'space_not_found' ? 'missing'
    : result.reason === 'runtime_details_missing' ? 'unavailable'
    : result.reason === 'control_plane_reconciliation_required' ? 'reconcile'
    : 'failed';
  await capturePostHogServerEvent({
    distinctId: session.user.id,
    event: 'space_deletion_failed',
    properties: { reason: deleteReason, email: session.user.email }
  });
  if (result.reason === 'confirmation_required') {
    redirect(`${dashboardPath.dashboard}?delete=confirm`);
  }
  if (result.reason === 'space_not_found') {
    redirect(`${dashboardPath.dashboard}?delete=missing`);
  }
  if (result.reason === 'runtime_details_missing') {
    redirect(`${dashboardPath.dashboard}?delete=unavailable`);
  }
  if (result.reason === 'control_plane_reconciliation_required') {
    redirect(`${dashboardPath.dashboard}?delete=reconcile`);
  }

  redirect(`${dashboardPath.dashboard}?delete=failed`);
}

async function getDashboardPath() {
  const locale = await getLocale();

  return {
    dashboard: `/${locale}/dashboard`,
    login: `/${locale}/login`
  };
}
