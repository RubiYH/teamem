export const TEAMEM_CLOUD_BOUNDARIES = {
  runtimeOwns: [
    'spaces',
    'room_codes',
    'runtime_members',
    'runtime_jwts',
    'claims',
    'briefings',
    'decisions',
    'discussions',
    'space_rules'
  ],
  controlPlaneOwns: [
    'oauth_accounts',
    'sessions',
    'cloud_accounts',
    'quota',
    'dashboard_state',
    'audit_events',
    'provisioning_records'
  ],
  runtimeForbiddenCloudFields: [
    'email',
    'user_email',
    'oauth_provider',
    'oauth_provider_id',
    'better_auth_user_id',
    'cloud_account_id'
  ]
} as const;

export type RuntimeCloudMetadata = {
  source: 'teamem-cloud';
  controlPlaneSpaceId: string;
  provisioningRequestId: string;
};

export function assertRuntimeCloudMetadataAllowed(
  metadata: Record<string, unknown>
): void {
  for (const key of TEAMEM_CLOUD_BOUNDARIES.runtimeForbiddenCloudFields) {
    if (key in metadata) {
      throw new Error(`runtime cloud metadata must not include ${key}`);
    }
  }
}
