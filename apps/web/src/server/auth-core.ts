import { betterAuth } from 'better-auth';
import type { PostgresPool } from 'kysely';
import { TEAMEM_CLOUD_AUTH_ACCOUNT_LINKING_POLICY } from '../../../../src/cloud/auth-policy';
import { loadTeamemCloudWebEnv } from '../../../../src/cloud/env-contract';
import { createTeamemCloudPostgresPool } from './postgres';

type BetterAuthOptions = Parameters<typeof betterAuth>[0];
type BetterAuthPlugin = NonNullable<BetterAuthOptions['plugins']>[number];

export function createTeamemCloudAuth(plugins: BetterAuthPlugin[] = []) {
  const envResult = loadTeamemCloudWebEnv();

  if (!envResult.ok) {
    throw new Error(
      `Teamem Cloud web auth env is missing: ${envResult.missing.join(', ')}`
    );
  }

  const env = envResult.value;
  const database = createTeamemCloudPostgresPool(
    env.supabase.postgresUrl
  ) as unknown as PostgresPool;

  return betterAuth({
    appName: 'Teamem Cloud',
    baseURL: env.betterAuth.url,
    secret: env.betterAuth.secret,
    database,
    socialProviders: {
      github: {
        clientId: env.oauth.github.clientId,
        clientSecret: env.oauth.github.clientSecret
      },
      ...(env.oauth.google
        ? {
            google: {
              clientId: env.oauth.google.clientId,
              clientSecret: env.oauth.google.clientSecret
            }
          }
        : {})
    },
    account: {
      accountLinking: {
        enabled: TEAMEM_CLOUD_AUTH_ACCOUNT_LINKING_POLICY.enabled,
        trustedProviders: [
          ...TEAMEM_CLOUD_AUTH_ACCOUNT_LINKING_POLICY.trustedProviders
        ],
        allowDifferentEmails:
          TEAMEM_CLOUD_AUTH_ACCOUNT_LINKING_POLICY.allowDifferentEmails,
        requireLocalEmailVerified:
          TEAMEM_CLOUD_AUTH_ACCOUNT_LINKING_POLICY.requireLocalEmailVerified
      }
    },
    plugins
  });
}
