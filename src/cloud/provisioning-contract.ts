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

export type CreateCloudSpaceInput = {
  label: string;
  idempotencyKey: string;
  controlPlaneSpaceId: string;
  provisioningRequestId: string;
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

export type RuntimeProvisioningClient = {
  createSpace(input: CreateCloudSpaceInput): Promise<CreateCloudSpaceResult>;
  rotateRoomCode(
    input: RotateCloudRoomCodeInput
  ): Promise<RotateCloudRoomCodeResult>;
  softDeleteSpace(
    input: SoftDeleteCloudSpaceInput
  ): Promise<SoftDeleteCloudSpaceResult>;
};
