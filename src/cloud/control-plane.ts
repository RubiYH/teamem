import type {
  CreateCloudSpaceResult,
  CreateCloudSpaceTerminalFailureResult
} from './provisioning-contract.js';

export const CLOUD_CONTROL_PLANE_ACTIVE_FREE_SPACE_STATUSES = [
  'provisioning_pending',
  'active',
  'delete_pending'
] as const;

export type CloudControlPlaneSpacePlan = 'free' | 'team' | 'enterprise';

export type CloudControlPlaneSpaceStatus =
  | 'provisioning_pending'
  | 'active'
  | 'suspended'
  | 'delete_pending'
  | 'deleted'
  | 'provisioning_failed';

export type CloudControlPlaneAuditEventType =
  | 'cloud_space_create_attempted'
  | 'cloud_space_create_quota_rejected'
  | 'cloud_space_create_succeeded'
  | 'cloud_space_create_failed'
  | 'cloud_space_suspended'
  | 'cloud_space_policy_override_attempted'
  | 'cloud_space_policy_override_succeeded'
  | 'cloud_space_policy_override_failed'
  | 'cloud_space_room_code_rotate_attempted'
  | 'cloud_space_room_code_rotate_succeeded'
  | 'cloud_space_room_code_rotate_failed'
  | 'cloud_space_delete_attempted'
  | 'cloud_space_delete_succeeded'
  | 'cloud_space_delete_failed';

export type CloudRoomCodeDisplayMetadata = {
  code: string | null;
  label: string | null;
  lastRotatedAt: string | null;
};

export type CloudControlPlaneAccount = {
  id: string;
  betterAuthUserId: string;
  email: string | null;
  displayName: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CloudControlPlaneFreePlanPolicy = {
  id: string;
  plan: 'free';
  active: true;
  trialDays: number;
  memberLimit: number;
  quotaMode: 'one_lifetime_space';
  createdAt: string;
  updatedAt: string;
};

export type CloudControlPlaneSpace = {
  id: string;
  ownerAccountId: string;
  displayName: string;
  plan: CloudControlPlaneSpacePlan;
  status: CloudControlPlaneSpaceStatus;
  trialExpiresAt: string | null;
  memberLimit: number | null;
  runtimeSpaceId: string | null;
  runtimeServerUrl: string | null;
  roomCodeDisplayMetadata: CloudRoomCodeDisplayMetadata;
  requestedAt: string;
  provisionedAt: string | null;
  suspendedAt: string | null;
  suspensionReason: string | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CloudControlPlaneFreePlanGrant = {
  id: string;
  accountId: string;
  policyId: string;
  acceptedCloudSpaceId: string;
  grantedAt: string;
  voidedAt: string | null;
  voidReason: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CloudControlPlaneAuditEvent = {
  id: string;
  accountId: string;
  cloudSpaceId: string | null;
  eventType: CloudControlPlaneAuditEventType;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type CloudControlPlaneAccountInput = {
  betterAuthUserId: string;
  email: string | null;
  displayName: string | null;
};

export type CloudControlPlaneIds = {
  accountId(): string;
  spaceId(): string;
  auditEventId(): string;
  freePlanGrantId(): string;
};

export type CloudControlPlaneClock = {
  now(): string;
};

export type RuntimeCloudSpaceProvisioningResult = CreateCloudSpaceResult;
export type RuntimeCloudSpaceTerminalFailureResult =
  CreateCloudSpaceTerminalFailureResult;

export type CreateFreeCloudSpaceInput = {
  betterAuthUserId: string;
  email: string | null;
  accountDisplayName: string | null;
  spaceDisplayName: string;
};

export type CreateFreeCloudSpaceResult =
  | {
      ok: true;
      account: CloudControlPlaneAccount;
      space: CloudControlPlaneSpace;
    }
  | {
      ok: false;
      reason: 'active_free_space_exists' | 'free_trial_already_used';
      account: CloudControlPlaneAccount;
      existingSpace?: CloudControlPlaneSpace;
      grant?: CloudControlPlaneFreePlanGrant;
    };

export type ProvisionFreeCloudSpaceInput = CreateFreeCloudSpaceInput;

export type ProvisionFreeCloudSpaceResult =
  | {
      ok: true;
      account: CloudControlPlaneAccount;
      space: CloudControlPlaneSpace;
    }
  | {
      ok: false;
      reason: 'display_name_required';
    }
  | {
      ok: false;
      reason: 'active_free_space_exists' | 'free_trial_already_used';
      account: CloudControlPlaneAccount;
      existingSpace?: CloudControlPlaneSpace;
      grant?: CloudControlPlaneFreePlanGrant;
    }
  | {
      ok: false;
      reason: 'runtime_provisioning_failed';
      account: CloudControlPlaneAccount;
      space: CloudControlPlaneSpace;
      error: unknown;
    }
  | {
      ok: false;
      reason: 'control_plane_reconciliation_required';
      account: CloudControlPlaneAccount;
      space: CloudControlPlaneSpace;
      error: unknown;
    };

export type RotateCloudRoomCodeForOwnerInput = CloudControlPlaneAccountInput;

export type RotateCloudRoomCodeForOwnerResult =
  | {
      ok: true;
      account: CloudControlPlaneAccount;
      space: CloudControlPlaneSpace;
    }
  | {
      ok: false;
      reason: 'space_not_found' | 'runtime_details_missing';
      account: CloudControlPlaneAccount;
      space: CloudControlPlaneSpace | null;
    }
  | {
      ok: false;
      reason: 'runtime_rotation_failed';
      account: CloudControlPlaneAccount;
      space: CloudControlPlaneSpace;
      error: unknown;
    }
  | {
      ok: false;
      reason: 'control_plane_reconciliation_required';
      account: CloudControlPlaneAccount;
      space: CloudControlPlaneSpace;
      rotatedRoomCode: string;
      error: unknown;
    };

export type DeleteCloudSpaceForOwnerInput = CloudControlPlaneAccountInput & {
  confirmationAccepted: boolean;
};

export type DeleteCloudSpaceForOwnerResult =
  | {
      ok: true;
      account: CloudControlPlaneAccount;
      space: CloudControlPlaneSpace;
    }
  | {
      ok: false;
      reason:
        | 'confirmation_required'
        | 'space_not_found'
        | 'runtime_details_missing'
        | 'runtime_soft_delete_failed'
        | 'control_plane_reconciliation_required';
      account: CloudControlPlaneAccount;
      space: CloudControlPlaneSpace | null;
      error?: unknown;
    };

export type OverrideFreeCloudSpacePolicyInput = {
  cloudSpaceId: string;
  trialExpiresAt: string;
  memberLimit: number;
};

export type OverrideFreeCloudSpacePolicyResult =
  | {
      ok: true;
      space: CloudControlPlaneSpace;
    }
  | {
      ok: false;
      reason:
        | 'space_not_found'
        | 'runtime_details_missing'
        | 'runtime_policy_update_failed'
        | 'control_plane_reconciliation_required'
        | 'invalid_policy_metadata';
      space: CloudControlPlaneSpace | null;
      error?: unknown;
    };

export type CreateCloudSpaceInsertResult =
  | { ok: true; space: CloudControlPlaneSpace }
  | {
      ok: false;
      reason: 'active_free_space_exists' | 'free_trial_already_used';
    };

export type CreateFreeCloudSpaceGrantInput = {
  space: CloudControlPlaneSpace;
  grant: CloudControlPlaneFreePlanGrant;
  attemptAuditEvent: CloudControlPlaneAuditEvent;
};

export type CloudDashboardState =
  | {
      kind: 'no-space';
      account: CloudControlPlaneAccount;
      quota: { canCreateFreeSpace: true };
    }
  | {
      kind: 'free-trial-consumed';
      account: CloudControlPlaneAccount;
      grant: CloudControlPlaneFreePlanGrant;
      quota: {
        canCreateFreeSpace: false;
        blockedReason: 'free_trial_already_used';
      };
    }
  | {
      kind: 'existing-space';
      account: CloudControlPlaneAccount;
      space: CloudControlPlaneSpace;
      quota:
        | { canCreateFreeSpace: true }
        | {
            canCreateFreeSpace: false;
            blockedReason:
              | 'active_free_space_exists'
              | 'free_trial_already_used';
          };
    };

export type CloudControlPlaneRepository = {
  ensureAccount(input: {
    id: string;
    betterAuthUserId: string;
    email: string | null;
    displayName: string | null;
    now: string;
  }): Promise<CloudControlPlaneAccount>;
  resolveActiveFreePlanPolicy(): Promise<CloudControlPlaneFreePlanPolicy>;
  findPrimarySpaceForAccount(
    accountId: string
  ): Promise<CloudControlPlaneSpace | null>;
  findCloudSpaceById(spaceId: string): Promise<CloudControlPlaneSpace | null>;
  findActiveFreeSpaceForAccount(
    accountId: string
  ): Promise<CloudControlPlaneSpace | null>;
  findNonVoidedFreePlanGrantForAccount(
    accountId: string
  ): Promise<CloudControlPlaneFreePlanGrant | null>;
  insertCloudSpace(
    space: CloudControlPlaneSpace
  ): Promise<CreateCloudSpaceInsertResult>;
  createFreeCloudSpaceGrant(
    input: CreateFreeCloudSpaceGrantInput
  ): Promise<CreateCloudSpaceInsertResult>;
  markCloudSpaceProvisioned(input: {
    spaceId: string;
    runtimeSpaceId: string;
    runtimeServerUrl: string;
    roomCodeDisplayMetadata: CloudRoomCodeDisplayMetadata;
    now: string;
  }): Promise<CloudControlPlaneSpace>;
  markCloudSpaceProvisioningFailed(input: {
    spaceId: string;
    now: string;
  }): Promise<CloudControlPlaneSpace>;
  markCloudSpaceProvisioningFailedAndVoidGrant(input: {
    spaceId: string;
    now: string;
    voidReason: string;
    failureAuditEvent: CloudControlPlaneAuditEvent;
  }): Promise<CloudControlPlaneSpace>;
  markCloudSpaceDeletePending(input: {
    spaceId: string;
    now: string;
  }): Promise<CloudControlPlaneSpace>;
  markExpiredFreeCloudSpaceSuspended(input: {
    spaceId: string;
    suspendedAt: string;
    now: string;
    suspensionAuditEvent: CloudControlPlaneAuditEvent;
  }): Promise<CloudControlPlaneSpace>;
  markCloudSpaceDeletedWithAudit(input: {
    spaceId: string;
    deletedAt: string;
    now: string;
    successAuditEvent: CloudControlPlaneAuditEvent;
  }): Promise<CloudControlPlaneSpace>;
  updateRoomCodeDisplayMetadataWithAudit(input: {
    spaceId: string;
    roomCodeDisplayMetadata: CloudRoomCodeDisplayMetadata;
    now: string;
    successAuditEvent: CloudControlPlaneAuditEvent;
  }): Promise<CloudControlPlaneSpace>;
  updateCloudSpaceResolvedPolicyWithAudit(input: {
    spaceId: string;
    trialExpiresAt: string;
    memberLimit: number;
    now: string;
    successAuditEvent: CloudControlPlaneAuditEvent;
  }): Promise<CloudControlPlaneSpace>;
  appendAuditEvent(event: CloudControlPlaneAuditEvent): Promise<void>;
};

export function isActiveFreeControlPlaneSpace(
  space: Pick<CloudControlPlaneSpace, 'plan' | 'status'>
): boolean {
  return (
    space.plan === 'free' &&
    CLOUD_CONTROL_PLANE_ACTIVE_FREE_SPACE_STATUSES.includes(
      space.status as (typeof CLOUD_CONTROL_PLANE_ACTIVE_FREE_SPACE_STATUSES)[number]
    )
  );
}

export async function getCloudDashboardState(
  repository: CloudControlPlaneRepository,
  ids: Pick<CloudControlPlaneIds, 'accountId' | 'auditEventId'>,
  clock: CloudControlPlaneClock,
  input: CloudControlPlaneAccountInput
): Promise<CloudDashboardState> {
  const account = await repository.ensureAccount({
    id: ids.accountId(),
    betterAuthUserId: input.betterAuthUserId,
    email: input.email,
    displayName: input.displayName,
    now: clock.now()
  });
  const primarySpace = await repository.findPrimarySpaceForAccount(account.id);
  const space = primarySpace
    ? await suspendExpiredFreeCloudSpaceForDashboard(
        repository,
        ids,
        clock,
        primarySpace
      )
    : null;

  if (!space) {
    const grant = await repository.findNonVoidedFreePlanGrantForAccount(
      account.id
    );
    if (grant) {
      return {
        kind: 'free-trial-consumed',
        account,
        grant,
        quota: {
          canCreateFreeSpace: false,
          blockedReason: 'free_trial_already_used'
        }
      };
    }

    return {
      kind: 'no-space',
      account,
      quota: { canCreateFreeSpace: true }
    };
  }

  const activeFreeSpace = await repository.findActiveFreeSpaceForAccount(
    account.id
  );
  const freeTrialGrant = activeFreeSpace
    ? null
    : await repository.findNonVoidedFreePlanGrantForAccount(account.id);

  return {
    kind: 'existing-space',
    account,
    space,
    quota: activeFreeSpace
      ? {
          canCreateFreeSpace: false,
          blockedReason: 'active_free_space_exists'
        }
      : freeTrialGrant
        ? {
            canCreateFreeSpace: false,
            blockedReason: 'free_trial_already_used'
          }
        : { canCreateFreeSpace: true }
  };
}

async function suspendExpiredFreeCloudSpaceForDashboard(
  repository: CloudControlPlaneRepository,
  ids: Pick<CloudControlPlaneIds, 'auditEventId'>,
  clock: CloudControlPlaneClock,
  space: CloudControlPlaneSpace
): Promise<CloudControlPlaneSpace> {
  const now = clock.now();
  if (!shouldSuspendExpiredFreeControlPlaneSpace(space, now)) {
    return space;
  }

  return repository.markExpiredFreeCloudSpaceSuspended({
    spaceId: space.id,
    suspendedAt: now,
    now,
    suspensionAuditEvent: {
      id: ids.auditEventId(),
      accountId: space.ownerAccountId,
      cloudSpaceId: space.id,
      eventType: 'cloud_space_suspended',
      metadata: {
        reason: 'free_trial_expired',
        plan: space.plan,
        trialExpiresAt: space.trialExpiresAt
      },
      createdAt: now
    }
  });
}

function shouldSuspendExpiredFreeControlPlaneSpace(
  space: CloudControlPlaneSpace,
  now: string
): boolean {
  return (
    space.plan === 'free' &&
    (space.status === 'active' || space.status === 'provisioning_pending') &&
    typeof space.trialExpiresAt === 'string' &&
    Number.isFinite(Date.parse(space.trialExpiresAt)) &&
    new Date(space.trialExpiresAt) <= new Date(now)
  );
}

export async function requestFreeCloudSpace(
  repository: CloudControlPlaneRepository,
  ids: CloudControlPlaneIds,
  clock: CloudControlPlaneClock,
  input: CreateFreeCloudSpaceInput
): Promise<CreateFreeCloudSpaceResult> {
  const now = clock.now();
  const account = await repository.ensureAccount({
    id: ids.accountId(),
    betterAuthUserId: input.betterAuthUserId,
    email: input.email,
    displayName: input.accountDisplayName,
    now
  });
  const policy = await repository.resolveActiveFreePlanPolicy();

  const attemptAuditEvent = {
    id: ids.auditEventId(),
    accountId: account.id,
    cloudSpaceId: null,
    eventType: 'cloud_space_create_attempted',
    metadata: { plan: 'free', displayName: input.spaceDisplayName },
    createdAt: now
  } satisfies CloudControlPlaneAuditEvent;

  const existingSpace = await repository.findActiveFreeSpaceForAccount(
    account.id
  );
  if (existingSpace) {
    await repository.appendAuditEvent(attemptAuditEvent);
    await writeQuotaRejectedAuditEvent(repository, ids, clock, {
      accountId: account.id,
      cloudSpaceId: existingSpace.id,
      reason: 'active_free_space_exists'
    });
    return {
      ok: false,
      reason: 'active_free_space_exists',
      account,
      existingSpace
    };
  }

  const existingGrant = await repository.findNonVoidedFreePlanGrantForAccount(
    account.id
  );
  if (existingGrant) {
    await repository.appendAuditEvent(attemptAuditEvent);
    await writeQuotaRejectedAuditEvent(repository, ids, clock, {
      accountId: account.id,
      cloudSpaceId: existingGrant.acceptedCloudSpaceId,
      reason: 'free_trial_already_used'
    });
    return {
      ok: false,
      reason: 'free_trial_already_used',
      account,
      grant: existingGrant
    };
  }

  const space = buildPendingFreeSpace({
    id: ids.spaceId(),
    accountId: account.id,
    displayName: input.spaceDisplayName,
    policy,
    now
  });
  const grant = buildFreePlanGrant({
    id: ids.freePlanGrantId(),
    accountId: account.id,
    policyId: policy.id,
    acceptedCloudSpaceId: space.id,
    now
  });
  const insertResult = await repository.createFreeCloudSpaceGrant({
    space,
    grant,
    attemptAuditEvent
  });

  if (!insertResult.ok) {
    await repository.appendAuditEvent(attemptAuditEvent);
    const concurrentSpace = await repository.findActiveFreeSpaceForAccount(
      account.id
    );
    const concurrentGrant =
      await repository.findNonVoidedFreePlanGrantForAccount(account.id);
    const reason = insertResult.reason;
    await writeQuotaRejectedAuditEvent(repository, ids, clock, {
      accountId: account.id,
      cloudSpaceId:
        concurrentSpace?.id ?? concurrentGrant?.acceptedCloudSpaceId ?? null,
      reason
    });
    return {
      ok: false,
      reason,
      account,
      ...(concurrentSpace ? { existingSpace: concurrentSpace } : {}),
      ...(concurrentGrant ? { grant: concurrentGrant } : {})
    };
  }

  return { ok: true, account, space: insertResult.space };
}

export async function provisionFreeCloudSpace(
  repository: CloudControlPlaneRepository,
  ids: CloudControlPlaneIds,
  clock: CloudControlPlaneClock,
  provisioningClient: {
    createSpace(input: {
      label: string;
      idempotencyKey: string;
      controlPlaneSpaceId: string;
      provisioningRequestId: string;
      plan: 'free';
      trialExpiresAt: string;
      memberLimit: number;
    }): Promise<
      | RuntimeCloudSpaceProvisioningResult
      | RuntimeCloudSpaceTerminalFailureResult
    >;
  },
  input: ProvisionFreeCloudSpaceInput
): Promise<ProvisionFreeCloudSpaceResult> {
  const spaceDisplayName = input.spaceDisplayName.trim();
  if (!spaceDisplayName) {
    const now = clock.now();
    const account = await repository.ensureAccount({
      id: ids.accountId(),
      betterAuthUserId: input.betterAuthUserId,
      email: input.email,
      displayName: input.accountDisplayName,
      now
    });

    await repository.appendAuditEvent({
      id: ids.auditEventId(),
      accountId: account.id,
      cloudSpaceId: null,
      eventType: 'cloud_space_create_attempted',
      metadata: { plan: 'free', displayName: input.spaceDisplayName },
      createdAt: now
    });
    await writeCreateFailedAuditEvent(repository, ids, clock, {
      accountId: account.id,
      cloudSpaceId: null,
      reason: 'display_name_required'
    });

    return { ok: false, reason: 'display_name_required' };
  }

  const requested = await getOrCreateProvisioningSpace(repository, ids, clock, {
    ...input,
    spaceDisplayName
  });
  if (!requested.ok) {
    return requested;
  }

  const provisioningRequestId = requested.space.id;
  let provisioned:
    | RuntimeCloudSpaceProvisioningResult
    | RuntimeCloudSpaceTerminalFailureResult;
  try {
    provisioned = await provisioningClient.createSpace({
      label: requested.space.displayName,
      idempotencyKey: requested.space.id,
      controlPlaneSpaceId: requested.space.id,
      provisioningRequestId,
      plan: 'free',
      trialExpiresAt: requireResolvedFreePolicyField(
        requested.space.trialExpiresAt,
        'trialExpiresAt'
      ),
      memberLimit: requireResolvedFreePolicyField(
        requested.space.memberLimit,
        'memberLimit'
      )
    });
  } catch (error) {
    const now = clock.now();
    await repository.appendAuditEvent({
      id: ids.auditEventId(),
      accountId: requested.account.id,
      cloudSpaceId: requested.space.id,
      eventType: 'cloud_space_create_failed',
      metadata: {
        plan: 'free',
        reason: 'control_plane_reconciliation_required',
        message: error instanceof Error ? error.message : String(error)
      },
      createdAt: now
    });

    return {
      ok: false,
      reason: 'control_plane_reconciliation_required',
      account: requested.account,
      space: requested.space,
      error
    };
  }

  if (
    isRuntimeTerminalProvisioningFailure(provisioned, {
      controlPlaneSpaceId: requested.space.id,
      provisioningRequestId
    })
  ) {
    const now = clock.now();
    const space = await repository.markCloudSpaceProvisioningFailedAndVoidGrant(
      {
        spaceId: requested.space.id,
        now,
        voidReason: provisioned.reason,
        failureAuditEvent: {
          id: ids.auditEventId(),
          accountId: requested.account.id,
          cloudSpaceId: requested.space.id,
          eventType: 'cloud_space_create_failed',
          metadata: {
            plan: 'free',
            reason: 'runtime_provisioning_failed',
            runtimeReason: provisioned.reason
          },
          createdAt: now
        }
      }
    );

    return {
      ok: false,
      reason: 'runtime_provisioning_failed',
      account: requested.account,
      space,
      error: new Error(provisioned.reason)
    };
  }

  const responseValidationError = validateRuntimeProvisioningResult(
    provisioned,
    {
      controlPlaneSpaceId: requested.space.id,
      provisioningRequestId
    }
  );
  if (responseValidationError) {
    const now = clock.now();
    await repository.appendAuditEvent({
      id: ids.auditEventId(),
      accountId: requested.account.id,
      cloudSpaceId: requested.space.id,
      eventType: 'cloud_space_create_failed',
      metadata: {
        plan: 'free',
        reason: 'control_plane_reconciliation_required',
        message: responseValidationError.message
      },
      createdAt: now
    });

    return {
      ok: false,
      reason: 'control_plane_reconciliation_required',
      account: requested.account,
      space: requested.space,
      error: responseValidationError
    };
  }

  const now = clock.now();
  const space = await repository.markCloudSpaceProvisioned({
    spaceId: requested.space.id,
    runtimeSpaceId: provisioned.runtimeSpaceId,
    runtimeServerUrl: provisioned.runtimeServerUrl,
    roomCodeDisplayMetadata: {
      code: provisioned.roomCode,
      label: null,
      lastRotatedAt: now
    },
    now
  });

  await repository.appendAuditEvent({
    id: ids.auditEventId(),
    accountId: requested.account.id,
    cloudSpaceId: space.id,
    eventType: 'cloud_space_create_succeeded',
    metadata: {
      plan: 'free',
      runtimeSpaceId: provisioned.runtimeSpaceId,
      runtimeServerUrl: provisioned.runtimeServerUrl
    },
    createdAt: now
  });

  return { ok: true, account: requested.account, space };
}

export async function overrideFreeCloudSpacePolicyForOperator(
  repository: CloudControlPlaneRepository,
  ids: Pick<CloudControlPlaneIds, 'auditEventId'>,
  clock: CloudControlPlaneClock,
  runtimeClient: {
    updateSpaceRuntimePolicy(input: {
      controlPlaneSpaceId: string;
      runtimeSpaceId: string;
      trialExpiresAt: string;
      memberLimit: number;
    }): Promise<{
      controlPlaneSpaceId: string;
      runtimeSpaceId: string;
      trialExpiresAt: string | null;
      memberLimit: number | null;
    }>;
  },
  input: OverrideFreeCloudSpacePolicyInput
): Promise<OverrideFreeCloudSpacePolicyResult> {
  if (!isValidOperatorResolvedFreePolicy(input)) {
    return {
      ok: false,
      reason: 'invalid_policy_metadata',
      space: null
    };
  }

  const space = await repository.findCloudSpaceById(input.cloudSpaceId);
  if (!space || space.plan !== 'free' || space.status === 'deleted') {
    return { ok: false, reason: 'space_not_found', space: null };
  }

  await repository.appendAuditEvent({
    id: ids.auditEventId(),
    accountId: space.ownerAccountId,
    cloudSpaceId: space.id,
    eventType: 'cloud_space_policy_override_attempted',
    metadata: {
      plan: space.plan,
      status: space.status,
      trialExpiresAt: input.trialExpiresAt,
      memberLimit: input.memberLimit
    },
    createdAt: clock.now()
  });

  if (!space.runtimeSpaceId || !space.runtimeServerUrl) {
    await writePolicyOverrideFailedAuditEvent(repository, ids, clock, {
      accountId: space.ownerAccountId,
      cloudSpaceId: space.id,
      reason: 'runtime_details_missing',
      status: space.status
    });
    return {
      ok: false,
      reason: 'runtime_details_missing',
      space
    };
  }

  try {
    const runtimeStatus = await runtimeClient.updateSpaceRuntimePolicy({
      controlPlaneSpaceId: space.id,
      runtimeSpaceId: space.runtimeSpaceId,
      trialExpiresAt: input.trialExpiresAt,
      memberLimit: input.memberLimit
    });
    if (
      runtimeStatus.controlPlaneSpaceId !== space.id ||
      runtimeStatus.runtimeSpaceId !== space.runtimeSpaceId ||
      runtimeStatus.trialExpiresAt !== input.trialExpiresAt ||
      runtimeStatus.memberLimit !== input.memberLimit
    ) {
      throw new Error('runtime policy update response did not match override');
    }
  } catch (error) {
    await writePolicyOverrideFailedAuditEvent(repository, ids, clock, {
      accountId: space.ownerAccountId,
      cloudSpaceId: space.id,
      reason: 'runtime_policy_update_failed',
      message: error instanceof Error ? error.message : String(error)
    });
    return {
      ok: false,
      reason: 'runtime_policy_update_failed',
      space,
      error
    };
  }

  try {
    const now = clock.now();
    const updatedSpace =
      await repository.updateCloudSpaceResolvedPolicyWithAudit({
        spaceId: space.id,
        trialExpiresAt: input.trialExpiresAt,
        memberLimit: input.memberLimit,
        now,
        successAuditEvent: {
          id: ids.auditEventId(),
          accountId: space.ownerAccountId,
          cloudSpaceId: space.id,
          eventType: 'cloud_space_policy_override_succeeded',
          metadata: {
            runtimeSpaceId: space.runtimeSpaceId,
            runtimeServerUrl: space.runtimeServerUrl,
            trialExpiresAt: input.trialExpiresAt,
            memberLimit: input.memberLimit
          },
          createdAt: now
        }
      });

    return { ok: true, space: updatedSpace };
  } catch (error) {
    await appendBestEffortAuditEvent(repository, {
      id: ids.auditEventId(),
      accountId: space.ownerAccountId,
      cloudSpaceId: space.id,
      eventType: 'cloud_space_policy_override_failed',
      metadata: {
        reason: 'control_plane_reconciliation_required',
        runtimeSpaceId: space.runtimeSpaceId,
        message: error instanceof Error ? error.message : String(error)
      },
      createdAt: clock.now()
    });
    return {
      ok: false,
      reason: 'control_plane_reconciliation_required',
      space,
      error
    };
  }
}

async function getOrCreateProvisioningSpace(
  repository: CloudControlPlaneRepository,
  ids: CloudControlPlaneIds,
  clock: CloudControlPlaneClock,
  input: CreateFreeCloudSpaceInput
): Promise<CreateFreeCloudSpaceResult> {
  const now = clock.now();
  const account = await repository.ensureAccount({
    id: ids.accountId(),
    betterAuthUserId: input.betterAuthUserId,
    email: input.email,
    displayName: input.accountDisplayName,
    now
  });
  const policy = await repository.resolveActiveFreePlanPolicy();

  const attemptAuditEvent = {
    id: ids.auditEventId(),
    accountId: account.id,
    cloudSpaceId: null,
    eventType: 'cloud_space_create_attempted',
    metadata: { plan: 'free', displayName: input.spaceDisplayName },
    createdAt: now
  } satisfies CloudControlPlaneAuditEvent;

  const existingSpace = await repository.findActiveFreeSpaceForAccount(
    account.id
  );
  if (existingSpace) {
    if (
      existingSpace.status === 'provisioning_pending' &&
      existingSpace.displayName === input.spaceDisplayName &&
      !existingSpace.runtimeSpaceId &&
      !existingSpace.runtimeServerUrl
    ) {
      await repository.appendAuditEvent(attemptAuditEvent);
      return { ok: true, account, space: existingSpace };
    }

    await repository.appendAuditEvent(attemptAuditEvent);
    await writeQuotaRejectedAuditEvent(repository, ids, clock, {
      accountId: account.id,
      cloudSpaceId: existingSpace.id,
      reason: 'active_free_space_exists'
    });
    return {
      ok: false,
      reason: 'active_free_space_exists',
      account,
      existingSpace
    };
  }

  const existingGrant = await repository.findNonVoidedFreePlanGrantForAccount(
    account.id
  );
  if (existingGrant) {
    await repository.appendAuditEvent(attemptAuditEvent);
    await writeQuotaRejectedAuditEvent(repository, ids, clock, {
      accountId: account.id,
      cloudSpaceId: existingGrant.acceptedCloudSpaceId,
      reason: 'free_trial_already_used'
    });
    return {
      ok: false,
      reason: 'free_trial_already_used',
      account,
      grant: existingGrant
    };
  }

  const space = buildPendingFreeSpace({
    id: ids.spaceId(),
    accountId: account.id,
    displayName: input.spaceDisplayName,
    policy,
    now
  });
  const grant = buildFreePlanGrant({
    id: ids.freePlanGrantId(),
    accountId: account.id,
    policyId: policy.id,
    acceptedCloudSpaceId: space.id,
    now
  });
  const insertResult = await repository.createFreeCloudSpaceGrant({
    space,
    grant,
    attemptAuditEvent
  });

  if (!insertResult.ok) {
    await repository.appendAuditEvent(attemptAuditEvent);
    const concurrentSpace = await repository.findActiveFreeSpaceForAccount(
      account.id
    );
    const concurrentGrant =
      await repository.findNonVoidedFreePlanGrantForAccount(account.id);
    const reason = insertResult.reason;
    await writeQuotaRejectedAuditEvent(repository, ids, clock, {
      accountId: account.id,
      cloudSpaceId:
        concurrentSpace?.id ?? concurrentGrant?.acceptedCloudSpaceId ?? null,
      reason
    });
    return {
      ok: false,
      reason,
      account,
      ...(concurrentSpace ? { existingSpace: concurrentSpace } : {}),
      ...(concurrentGrant ? { grant: concurrentGrant } : {})
    };
  }

  return { ok: true, account, space: insertResult.space };
}

export async function rotateCloudRoomCodeForOwner(
  repository: CloudControlPlaneRepository,
  ids: Pick<CloudControlPlaneIds, 'accountId' | 'auditEventId'>,
  clock: CloudControlPlaneClock,
  provisioningClient: {
    rotateRoomCode(input: {
      controlPlaneSpaceId: string;
      runtimeSpaceId: string;
      idempotencyKey: string;
    }): Promise<{
      controlPlaneSpaceId: string;
      runtimeSpaceId: string;
      roomCode: string;
    }>;
  },
  input: RotateCloudRoomCodeForOwnerInput
): Promise<RotateCloudRoomCodeForOwnerResult> {
  const account = await repository.ensureAccount({
    id: ids.accountId(),
    betterAuthUserId: input.betterAuthUserId,
    email: input.email,
    displayName: input.displayName,
    now: clock.now()
  });
  const space = await repository.findPrimarySpaceForAccount(account.id);

  if (!space) {
    return { ok: false, reason: 'space_not_found', account, space: null };
  }

  await repository.appendAuditEvent({
    id: ids.auditEventId(),
    accountId: account.id,
    cloudSpaceId: space.id,
    eventType: 'cloud_space_room_code_rotate_attempted',
    metadata: { plan: space.plan, status: space.status },
    createdAt: clock.now()
  });

  if (
    space.status !== 'active' ||
    !space.runtimeSpaceId ||
    !space.runtimeServerUrl
  ) {
    await repository.appendAuditEvent({
      id: ids.auditEventId(),
      accountId: account.id,
      cloudSpaceId: space.id,
      eventType: 'cloud_space_room_code_rotate_failed',
      metadata: {
        reason: 'runtime_details_missing',
        status: space.status
      },
      createdAt: clock.now()
    });
    return {
      ok: false,
      reason: 'runtime_details_missing',
      account,
      space
    };
  }

  let rotated: {
    controlPlaneSpaceId: string;
    runtimeSpaceId: string;
    roomCode: string;
  };
  try {
    rotated = await provisioningClient.rotateRoomCode({
      controlPlaneSpaceId: space.id,
      runtimeSpaceId: space.runtimeSpaceId,
      idempotencyKey: buildRoomCodeRotationIdempotencyKey(space)
    });
    if (
      rotated.controlPlaneSpaceId !== space.id ||
      rotated.runtimeSpaceId !== space.runtimeSpaceId
    ) {
      throw new Error(
        'runtime room-code rotation response did not match Space'
      );
    }
  } catch (error) {
    await repository.appendAuditEvent({
      id: ids.auditEventId(),
      accountId: account.id,
      cloudSpaceId: space.id,
      eventType: 'cloud_space_room_code_rotate_failed',
      metadata: {
        reason: 'runtime_rotation_failed',
        message: error instanceof Error ? error.message : String(error)
      },
      createdAt: clock.now()
    });
    return {
      ok: false,
      reason: 'runtime_rotation_failed',
      account,
      space,
      error
    };
  }

  try {
    const now = clock.now();
    const updatedSpace =
      await repository.updateRoomCodeDisplayMetadataWithAudit({
        spaceId: space.id,
        roomCodeDisplayMetadata: {
          code: rotated.roomCode,
          label: space.roomCodeDisplayMetadata.label,
          lastRotatedAt: now
        },
        now,
        successAuditEvent: {
          id: ids.auditEventId(),
          accountId: account.id,
          cloudSpaceId: space.id,
          eventType: 'cloud_space_room_code_rotate_succeeded',
          metadata: {
            runtimeSpaceId: rotated.runtimeSpaceId,
            runtimeServerUrl: space.runtimeServerUrl
          },
          createdAt: now
        }
      });

    return { ok: true, account, space: updatedSpace };
  } catch (error) {
    await appendBestEffortAuditEvent(repository, {
      id: ids.auditEventId(),
      accountId: account.id,
      cloudSpaceId: space.id,
      eventType: 'cloud_space_room_code_rotate_failed',
      metadata: {
        reason: 'control_plane_reconciliation_required',
        runtimeSpaceId: rotated.runtimeSpaceId,
        message: error instanceof Error ? error.message : String(error)
      },
      createdAt: clock.now()
    });
    return {
      ok: false,
      reason: 'control_plane_reconciliation_required',
      account,
      space,
      rotatedRoomCode: rotated.roomCode,
      error
    };
  }
}

export async function deleteCloudSpaceForOwner(
  repository: CloudControlPlaneRepository,
  ids: Pick<CloudControlPlaneIds, 'accountId' | 'auditEventId'>,
  clock: CloudControlPlaneClock,
  provisioningClient: {
    softDeleteSpace(input: {
      controlPlaneSpaceId: string;
      runtimeSpaceId: string;
      idempotencyKey: string;
      reason: 'owner_requested';
    }): Promise<{
      controlPlaneSpaceId: string;
      runtimeSpaceId: string;
      status: 'soft_deleted';
      deletedAt: string;
    }>;
  },
  input: DeleteCloudSpaceForOwnerInput
): Promise<DeleteCloudSpaceForOwnerResult> {
  const account = await repository.ensureAccount({
    id: ids.accountId(),
    betterAuthUserId: input.betterAuthUserId,
    email: input.email,
    displayName: input.displayName,
    now: clock.now()
  });

  if (!input.confirmationAccepted) {
    return { ok: false, reason: 'confirmation_required', account, space: null };
  }

  const space = await repository.findPrimarySpaceForAccount(account.id);
  if (!space) {
    return { ok: false, reason: 'space_not_found', account, space: null };
  }

  await repository.appendAuditEvent({
    id: ids.auditEventId(),
    accountId: account.id,
    cloudSpaceId: space.id,
    eventType: 'cloud_space_delete_attempted',
    metadata: { plan: space.plan, status: space.status },
    createdAt: clock.now()
  });

  if (!space.runtimeSpaceId || !space.runtimeServerUrl) {
    await writeDeleteFailedAuditEvent(repository, ids, clock, {
      accountId: account.id,
      cloudSpaceId: space.id,
      reason: 'runtime_details_missing',
      status: space.status
    });
    return {
      ok: false,
      reason: 'runtime_details_missing',
      account,
      space
    };
  }

  let pendingSpace = space;
  try {
    pendingSpace = await repository.markCloudSpaceDeletePending({
      spaceId: space.id,
      now: clock.now()
    });
  } catch (error) {
    await appendBestEffortAuditEvent(repository, {
      id: ids.auditEventId(),
      accountId: account.id,
      cloudSpaceId: space.id,
      eventType: 'cloud_space_delete_failed',
      metadata: {
        reason: 'control_plane_reconciliation_required',
        phase: 'mark_delete_pending',
        message: error instanceof Error ? error.message : String(error)
      },
      createdAt: clock.now()
    });
    return {
      ok: false,
      reason: 'control_plane_reconciliation_required',
      account,
      space,
      error
    };
  }

  let deleted: {
    controlPlaneSpaceId: string;
    runtimeSpaceId: string;
    status: 'soft_deleted';
    deletedAt: string;
  };
  try {
    deleted = await provisioningClient.softDeleteSpace({
      controlPlaneSpaceId: space.id,
      runtimeSpaceId: space.runtimeSpaceId,
      idempotencyKey: buildSoftDeleteIdempotencyKey(space),
      reason: 'owner_requested'
    });
    if (
      deleted.controlPlaneSpaceId !== space.id ||
      deleted.runtimeSpaceId !== space.runtimeSpaceId ||
      deleted.status !== 'soft_deleted'
    ) {
      throw new Error('runtime soft-delete response did not match Space');
    }
  } catch (error) {
    await writeDeleteFailedAuditEvent(repository, ids, clock, {
      accountId: account.id,
      cloudSpaceId: space.id,
      reason: 'runtime_soft_delete_failed',
      message: error instanceof Error ? error.message : String(error)
    });
    return {
      ok: false,
      reason: 'runtime_soft_delete_failed',
      account,
      space: pendingSpace,
      error
    };
  }

  let deletedSpace = pendingSpace;
  try {
    const now = clock.now();
    deletedSpace = await repository.markCloudSpaceDeletedWithAudit({
      spaceId: space.id,
      deletedAt: deleted.deletedAt,
      now,
      successAuditEvent: {
        id: ids.auditEventId(),
        accountId: account.id,
        cloudSpaceId: space.id,
        eventType: 'cloud_space_delete_succeeded',
        metadata: {
          runtimeSpaceId: deleted.runtimeSpaceId,
          runtimeServerUrl: pendingSpace.runtimeServerUrl,
          deletedAt: deleted.deletedAt
        },
        createdAt: now
      }
    });
  } catch (error) {
    await appendBestEffortAuditEvent(repository, {
      id: ids.auditEventId(),
      accountId: account.id,
      cloudSpaceId: space.id,
      eventType: 'cloud_space_delete_failed',
      metadata: {
        reason: 'control_plane_reconciliation_required',
        runtimeSpaceId: deleted.runtimeSpaceId,
        message: error instanceof Error ? error.message : String(error)
      },
      createdAt: clock.now()
    });
    return {
      ok: false,
      reason: 'control_plane_reconciliation_required',
      account,
      space: deletedSpace,
      error
    };
  }

  return { ok: true, account, space: deletedSpace };
}

function validateRuntimeProvisioningResult(
  provisioned:
    | RuntimeCloudSpaceProvisioningResult
    | RuntimeCloudSpaceTerminalFailureResult
    | unknown,
  expected: {
    controlPlaneSpaceId: string;
    provisioningRequestId: string;
  }
): Error | null {
  if (
    typeof provisioned !== 'object' ||
    provisioned === null ||
    !('controlPlaneSpaceId' in provisioned) ||
    !('status' in provisioned) ||
    !('correlation' in provisioned) ||
    typeof provisioned.correlation !== 'object' ||
    provisioned.correlation === null ||
    !('source' in provisioned.correlation) ||
    !('controlPlaneSpaceId' in provisioned.correlation) ||
    !('provisioningRequestId' in provisioned.correlation)
  ) {
    return new Error('runtime provisioning response did not match request');
  }

  if (
    provisioned.controlPlaneSpaceId !== expected.controlPlaneSpaceId ||
    provisioned.status !== 'active' ||
    provisioned.correlation.source !== 'teamem-cloud' ||
    provisioned.correlation.controlPlaneSpaceId !==
      expected.controlPlaneSpaceId ||
    provisioned.correlation.provisioningRequestId !==
      expected.provisioningRequestId
  ) {
    return new Error('runtime provisioning response did not match request');
  }

  return null;
}

function isRuntimeTerminalProvisioningFailure(
  provisioned:
    | RuntimeCloudSpaceProvisioningResult
    | RuntimeCloudSpaceTerminalFailureResult,
  expected: {
    controlPlaneSpaceId: string;
    provisioningRequestId: string;
  }
): provisioned is RuntimeCloudSpaceTerminalFailureResult {
  return (
    provisioned.status === 'provisioning_failed' &&
    provisioned.controlPlaneSpaceId === expected.controlPlaneSpaceId &&
    typeof provisioned.correlation === 'object' &&
    provisioned.correlation !== null &&
    provisioned.correlation.source === 'teamem-cloud' &&
    provisioned.correlation.controlPlaneSpaceId ===
      expected.controlPlaneSpaceId &&
    provisioned.correlation.provisioningRequestId ===
      expected.provisioningRequestId
  );
}

function buildRoomCodeRotationIdempotencyKey(
  space: CloudControlPlaneSpace
): string {
  return `${space.id}:room-code:${space.roomCodeDisplayMetadata.code ?? 'unset'}`;
}

function buildSoftDeleteIdempotencyKey(space: CloudControlPlaneSpace): string {
  return `${space.id}:soft-delete:${space.runtimeSpaceId ?? 'unset'}`;
}

async function appendBestEffortAuditEvent(
  repository: Pick<CloudControlPlaneRepository, 'appendAuditEvent'>,
  event: CloudControlPlaneAuditEvent
): Promise<void> {
  try {
    await repository.appendAuditEvent(event);
  } catch {
    // The caller already returns a reconciliation-needed result. Do not mask it
    // with a second audit-write failure.
  }
}

function buildPendingFreeSpace(input: {
  id: string;
  accountId: string;
  displayName: string;
  policy: CloudControlPlaneFreePlanPolicy;
  now: string;
}): CloudControlPlaneSpace {
  return {
    id: input.id,
    ownerAccountId: input.accountId,
    displayName: input.displayName,
    plan: 'free',
    status: 'provisioning_pending',
    trialExpiresAt: addDaysToIsoTimestamp(input.now, input.policy.trialDays),
    memberLimit: input.policy.memberLimit,
    runtimeSpaceId: null,
    runtimeServerUrl: null,
    roomCodeDisplayMetadata: {
      code: null,
      label: null,
      lastRotatedAt: null
    },
    requestedAt: input.now,
    provisionedAt: null,
    suspendedAt: null,
    suspensionReason: null,
    deletedAt: null,
    createdAt: input.now,
    updatedAt: input.now
  };
}

function addDaysToIsoTimestamp(timestamp: string, days: number): string {
  const time = Date.parse(timestamp);
  if (!Number.isFinite(time)) {
    throw new Error('cannot resolve trial expiry from invalid request time');
  }
  return new Date(time + days * 24 * 60 * 60 * 1000).toISOString();
}

function requireResolvedFreePolicyField<T>(
  value: T | null,
  fieldName: string
): T {
  if (value === null) {
    throw new Error(`pending free Space is missing resolved ${fieldName}`);
  }
  return value;
}

function isValidOperatorResolvedFreePolicy(input: {
  trialExpiresAt: string;
  memberLimit: number;
}): boolean {
  return (
    typeof input.trialExpiresAt === 'string' &&
    Number.isFinite(Date.parse(input.trialExpiresAt)) &&
    Number.isInteger(input.memberLimit) &&
    input.memberLimit > 0
  );
}

function buildFreePlanGrant(input: {
  id: string;
  accountId: string;
  policyId: string;
  acceptedCloudSpaceId: string;
  now: string;
}): CloudControlPlaneFreePlanGrant {
  return {
    id: input.id,
    accountId: input.accountId,
    policyId: input.policyId,
    acceptedCloudSpaceId: input.acceptedCloudSpaceId,
    grantedAt: input.now,
    voidedAt: null,
    voidReason: null,
    createdAt: input.now,
    updatedAt: input.now
  };
}

async function writeQuotaRejectedAuditEvent(
  repository: Pick<CloudControlPlaneRepository, 'appendAuditEvent'>,
  ids: Pick<CloudControlPlaneIds, 'auditEventId'>,
  clock: CloudControlPlaneClock,
  input: {
    accountId: string;
    cloudSpaceId: string | null;
    reason: 'active_free_space_exists' | 'free_trial_already_used';
  }
): Promise<void> {
  await repository.appendAuditEvent({
    id: ids.auditEventId(),
    accountId: input.accountId,
    cloudSpaceId: input.cloudSpaceId,
    eventType: 'cloud_space_create_quota_rejected',
    metadata: {
      plan: 'free',
      reason: input.reason
    },
    createdAt: clock.now()
  });
}

async function writeCreateFailedAuditEvent(
  repository: Pick<CloudControlPlaneRepository, 'appendAuditEvent'>,
  ids: Pick<CloudControlPlaneIds, 'auditEventId'>,
  clock: CloudControlPlaneClock,
  input: { accountId: string; cloudSpaceId: string | null; reason: string }
): Promise<void> {
  await repository.appendAuditEvent({
    id: ids.auditEventId(),
    accountId: input.accountId,
    cloudSpaceId: input.cloudSpaceId,
    eventType: 'cloud_space_create_failed',
    metadata: {
      plan: 'free',
      reason: input.reason
    },
    createdAt: clock.now()
  });
}

async function writeDeleteFailedAuditEvent(
  repository: Pick<CloudControlPlaneRepository, 'appendAuditEvent'>,
  ids: Pick<CloudControlPlaneIds, 'auditEventId'>,
  clock: CloudControlPlaneClock,
  input: {
    accountId: string;
    cloudSpaceId: string;
    reason: string;
    status?: string;
    message?: string;
  }
): Promise<void> {
  await repository.appendAuditEvent({
    id: ids.auditEventId(),
    accountId: input.accountId,
    cloudSpaceId: input.cloudSpaceId,
    eventType: 'cloud_space_delete_failed',
    metadata: {
      reason: input.reason,
      ...(input.status ? { status: input.status } : {}),
      ...(input.message ? { message: input.message } : {})
    },
    createdAt: clock.now()
  });
}

async function writePolicyOverrideFailedAuditEvent(
  repository: Pick<CloudControlPlaneRepository, 'appendAuditEvent'>,
  ids: Pick<CloudControlPlaneIds, 'auditEventId'>,
  clock: CloudControlPlaneClock,
  input: {
    accountId: string;
    cloudSpaceId: string;
    reason: string;
    status?: string;
    message?: string;
  }
): Promise<void> {
  await repository.appendAuditEvent({
    id: ids.auditEventId(),
    accountId: input.accountId,
    cloudSpaceId: input.cloudSpaceId,
    eventType: 'cloud_space_policy_override_failed',
    metadata: {
      reason: input.reason,
      ...(input.status ? { status: input.status } : {}),
      ...(input.message ? { message: input.message } : {})
    },
    createdAt: clock.now()
  });
}
