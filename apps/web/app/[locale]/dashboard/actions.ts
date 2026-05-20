'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getLocale } from 'next-intl/server';
import { auth } from '../../../src/server/auth';
import { createFreeSpaceForUser } from '../../../src/server/create-free-space';
import { deleteSpaceForUser } from '../../../src/server/delete-space';
import { rotateRoomCodeForUser } from '../../../src/server/rotate-room-code';

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
    redirect(`${dashboardPath.dashboard}?created=1`);
  }

  if (result.reason === 'active_free_space_exists') {
    redirect(`${dashboardPath.dashboard}?create=quota`);
  }
  if (result.reason === 'free_trial_already_used') {
    redirect(`${dashboardPath.dashboard}?create=trial-used`);
  }
  if (result.reason === 'display_name_required') {
    redirect(`${dashboardPath.dashboard}?create=display-name`);
  }
  if (result.reason === 'control_plane_reconciliation_required') {
    redirect(`${dashboardPath.dashboard}?create=reconcile`);
  }

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
    redirect(`${dashboardPath.dashboard}?rotate=success`);
  }
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
    redirect(`${dashboardPath.dashboard}?delete=success`);
  }
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
