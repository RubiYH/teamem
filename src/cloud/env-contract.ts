export type TeamemCloudOAuthProviderConfig = {
  clientId: string;
  clientSecret: string;
};

export type TeamemCloudWebEnv = {
  nodeEnv: string;
  appUrl: string;
  betterAuth: {
    secret: string;
    url: string;
  };
  oauth: {
    github: TeamemCloudOAuthProviderConfig;
    google?: TeamemCloudOAuthProviderConfig;
  };
  supabase: {
    postgresUrl: string;
    postgresCaCert?: string;
    url: string;
    serviceRoleKey: string;
  };
  runtime: {
    hostedUrl: string;
    provisioningToken: string;
  };
};

export type TeamemCloudWebEnvResult =
  | { ok: true; value: TeamemCloudWebEnv }
  | { ok: false; missing: string[] };

const REQUIRED_ENV_KEYS = [
  'TEAMEM_CLOUD_APP_URL',
  'BETTER_AUTH_SECRET',
  'BETTER_AUTH_URL',
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
  'SUPABASE_POSTGRES_URL',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'TEAMEM_CLOUD_RUNTIME_URL',
  'TEAMEM_CLOUD_RUNTIME_PROVISIONING_TOKEN'
] as const;

export type TeamemCloudWebEnvKey = (typeof REQUIRED_ENV_KEYS)[number];

export const TEAMEM_CLOUD_WEB_ENV_KEYS: readonly TeamemCloudWebEnvKey[] =
  REQUIRED_ENV_KEYS;

const OPTIONAL_ENV_KEYS = [
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'SUPABASE_POSTGRES_CA_CERT'
] as const;

export type TeamemCloudOptionalWebEnvKey = (typeof OPTIONAL_ENV_KEYS)[number];

export const TEAMEM_CLOUD_OPTIONAL_WEB_ENV_KEYS: readonly TeamemCloudOptionalWebEnvKey[] =
  OPTIONAL_ENV_KEYS;

export function loadTeamemCloudWebEnv(
  env: NodeJS.ProcessEnv = process.env
): TeamemCloudWebEnvResult {
  const missing: string[] = REQUIRED_ENV_KEYS.filter(
    (key) => !env[key]?.trim()
  );
  const hasGoogleClientId = Boolean(env.GOOGLE_CLIENT_ID?.trim());
  const hasGoogleClientSecret = Boolean(env.GOOGLE_CLIENT_SECRET?.trim());
  if (hasGoogleClientId !== hasGoogleClientSecret) {
    missing.push(
      hasGoogleClientId ? 'GOOGLE_CLIENT_SECRET' : 'GOOGLE_CLIENT_ID'
    );
  }
  if (missing.length > 0) {
    return { ok: false, missing };
  }

  const google =
    hasGoogleClientId && hasGoogleClientSecret
      ? {
          clientId: env.GOOGLE_CLIENT_ID!,
          clientSecret: env.GOOGLE_CLIENT_SECRET!
        }
      : undefined;

  return {
    ok: true,
    value: {
      nodeEnv: env.NODE_ENV ?? 'development',
      appUrl: env.TEAMEM_CLOUD_APP_URL!,
      betterAuth: {
        secret: env.BETTER_AUTH_SECRET!,
        url: env.BETTER_AUTH_URL!
      },
      oauth: {
        github: {
          clientId: env.GITHUB_CLIENT_ID!,
          clientSecret: env.GITHUB_CLIENT_SECRET!
        },
        ...(google ? { google } : {})
      },
      supabase: {
        postgresUrl: env.SUPABASE_POSTGRES_URL!,
        ...(env.SUPABASE_POSTGRES_CA_CERT?.trim()
          ? { postgresCaCert: env.SUPABASE_POSTGRES_CA_CERT }
          : {}),
        url: env.SUPABASE_URL!,
        serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY!
      },
      runtime: {
        hostedUrl: env.TEAMEM_CLOUD_RUNTIME_URL!,
        provisioningToken: env.TEAMEM_CLOUD_RUNTIME_PROVISIONING_TOKEN!
      }
    }
  };
}

export function isGoogleOAuthConfigured(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return Boolean(
    env.GOOGLE_CLIENT_ID?.trim() && env.GOOGLE_CLIENT_SECRET?.trim()
  );
}
