'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { auth } from '../../src/server/auth';
import { createFreeSpaceForUser } from '../../src/server/create-free-space';
import { deleteSpaceForUser } from '../../src/server/delete-space';
import { rotateRoomCodeForUser } from '../../src/server/rotate-room-code';

export async function createFreeSpaceAction(formData: FormData) {
  const session = await auth.api.getSession({
    headers: await headers()
  });

  if (!session) {
    redirect('/login?from=/dashboard');
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

  revalidatePath('/dashboard');

  if (result.ok) {
    redirect('/dashboard?created=1');
  }

  if (result.reason === 'active_free_space_exists') {
    redirect('/dashboard?create=quota');
  }
  if (result.reason === 'display_name_required') {
    redirect('/dashboard?create=display-name');
  }
  if (result.reason === 'control_plane_reconciliation_required') {
    redirect('/dashboard?create=reconcile');
  }

  redirect('/dashboard?create=runtime-failed');
}

export async function rotateRoomCodeAction() {
  const session = await auth.api.getSession({
    headers: await headers()
  });

  if (!session) {
    redirect('/login?from=/dashboard');
  }

  const result = await rotateRoomCodeForUser({
    user: {
      betterAuthUserId: session.user.id,
      email: session.user.email,
      displayName: session.user.name || session.user.email
    }
  });

  revalidatePath('/dashboard');

  if (result.ok) {
    redirect('/dashboard?rotate=success');
  }
  if (result.reason === 'space_not_found') {
    redirect('/dashboard?rotate=missing');
  }
  if (result.reason === 'runtime_details_missing') {
    redirect('/dashboard?rotate=unavailable');
  }
  if (result.reason === 'control_plane_reconciliation_required') {
    redirect('/dashboard?rotate=reconcile');
  }

  redirect('/dashboard?rotate=failed');
}

export async function deleteSpaceAction(formData: FormData) {
  const session = await auth.api.getSession({
    headers: await headers()
  });

  if (!session) {
    redirect('/login?from=/dashboard');
  }

  const result = await deleteSpaceForUser({
    user: {
      betterAuthUserId: session.user.id,
      email: session.user.email,
      displayName: session.user.name || session.user.email
    },
    confirmationAccepted: formData.get('confirmDelete') === 'on'
  });

  revalidatePath('/dashboard');

  if (result.ok) {
    redirect('/dashboard?delete=success');
  }
  if (result.reason === 'confirmation_required') {
    redirect('/dashboard?delete=confirm');
  }
  if (result.reason === 'space_not_found') {
    redirect('/dashboard?delete=missing');
  }
  if (result.reason === 'runtime_details_missing') {
    redirect('/dashboard?delete=unavailable');
  }
  if (result.reason === 'control_plane_reconciliation_required') {
    redirect('/dashboard?delete=reconcile');
  }

  redirect('/dashboard?delete=failed');
}
