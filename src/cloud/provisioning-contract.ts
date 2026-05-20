export type CloudSpaceStatus =
  | 'provisioning'
  | 'active'
  | 'delete_pending'
  | 'soft_deleted'
  | 'provisioning_failed';

export type RuntimeCloudCorrelation = {
  source: 'teamem-cloud';
  controlPlaneSpaceId: string;
  provisioningRequestId: string;
};

export type CloudRuntimeSpacePlan = 'free' | 'team' | 'enterprise';

export type CreateCloudSpaceInput = {
  label: string;
  idempotencyKey: string;
  controlPlaneSpaceId: string;
  provisioningRequestId: string;
  plan: CloudRuntimeSpacePlan;
  trialExpiresAt: string | null;
  memberLimit: number | null;
};

export type CreateCloudSpaceResult = {
  controlPlaneSpaceId: string;
  runtimeSpaceId: string;
  runtimeServerUrl: string;
  label: string;
  roomCode: string;
  status: Extract<CloudSpaceStatus, 'active'>;
  correlation: RuntimeCloudCorrelation;
};

export type CreateCloudSpaceTerminalFailureResult = {
  controlPlaneSpaceId: string;
  status: Extract<CloudSpaceStatus, 'provisioning_failed'>;
  reason: string;
  correlation: RuntimeCloudCorrelation;
};

export type CreateCloudSpaceProvisioningResult =
  | CreateCloudSpaceResult
  | CreateCloudSpaceTerminalFailureResult;

export type RotateCloudRoomCodeInput = {
  controlPlaneSpaceId: string;
  runtimeSpaceId: string;
  idempotencyKey: string;
};

export type RotateCloudRoomCodeResult = {
  controlPlaneSpaceId: string;
  runtimeSpaceId: string;
  roomCode: string;
};

export type SoftDeleteCloudSpaceInput = {
  controlPlaneSpaceId: string;
  runtimeSpaceId: string;
  idempotencyKey: string;
  reason: 'owner_requested' | 'quota_reclaim' | 'operator_action';
};

export type SoftDeleteCloudSpaceResult = {
  controlPlaneSpaceId: string;
  runtimeSpaceId: string;
  status: Extract<CloudSpaceStatus, 'soft_deleted'>;
  deletedAt: string;
};

export type GetCloudSpaceRuntimeStatusInput = {
  controlPlaneSpaceId: string;
  runtimeSpaceId: string;
};

export type UpdateCloudSpaceRuntimePolicyInput = {
  controlPlaneSpaceId: string;
  runtimeSpaceId: string;
  trialExpiresAt: string;
  memberLimit: number;
};

export type CloudSpaceRuntimeStatus = {
  controlPlaneSpaceId: string;
  runtimeSpaceId: string;
  plan: CloudRuntimeSpacePlan | null;
  trialExpiresAt: string | null;
  memberLimit: number | null;
  activeUserFacingMemberCount: number;
  suspendedAt: string | null;
  suspensionReason: string | null;
  setupAvailable: boolean;
  controlsAvailable: boolean;
};

export type RuntimeProvisioningClient = {
  createSpace(
    input: CreateCloudSpaceInput
  ): Promise<CreateCloudSpaceProvisioningResult>;
  rotateRoomCode(
    input: RotateCloudRoomCodeInput
  ): Promise<RotateCloudRoomCodeResult>;
  softDeleteSpace(
    input: SoftDeleteCloudSpaceInput
  ): Promise<SoftDeleteCloudSpaceResult>;
};

export type RuntimeStatusClient = {
  getSpaceRuntimeStatus(
    input: GetCloudSpaceRuntimeStatusInput
  ): Promise<CloudSpaceRuntimeStatus>;
};

export type RuntimePolicyClient = {
  updateSpaceRuntimePolicy(
    input: UpdateCloudSpaceRuntimePolicyInput
  ): Promise<CloudSpaceRuntimeStatus>;
};
