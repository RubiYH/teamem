export const TEAMEM_CLOUD_OAUTH_PROVIDERS = ['github', 'google'] as const;

export type TeamemCloudOAuthProvider =
  (typeof TEAMEM_CLOUD_OAUTH_PROVIDERS)[number];

type TeamemCloudOAuthLinkingCandidate = {
  provider: string;
  emailVerified: boolean;
};

export function canLinkTeamemCloudOAuthAccount(
  candidate: TeamemCloudOAuthLinkingCandidate
): boolean {
  return (
    TEAMEM_CLOUD_OAUTH_PROVIDERS.some(
      (provider) => provider === candidate.provider
    ) && candidate.emailVerified
  );
}

export const TEAMEM_CLOUD_AUTH_ACCOUNT_LINKING_POLICY = {
  enabled: true,
  trustedProviders: [],
  allowDifferentEmails: false,
  requireLocalEmailVerified: true
} as const;

export const TEAMEM_CLOUD_AUTH_BOUNDARY = {
  webAccountOwns: [
    'dashboard_access',
    'quota_owner',
    'space_provisioning_requests'
  ],
  runtimeIdentitySources: [
    'teamem_cli_setup_member_name',
    'teamem_plugin_runtime_principal'
  ],
  forbiddenWebAccountRuntimeFields: [
    'runtimeMemberName',
    'runtimePrincipal',
    'memberIdentity'
  ]
} as const;
