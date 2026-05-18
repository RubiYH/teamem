import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  TEAMEM_CLOUD_AUTH_ACCOUNT_LINKING_POLICY,
  TEAMEM_CLOUD_AUTH_BOUNDARY,
  TEAMEM_CLOUD_OAUTH_PROVIDERS,
  canLinkTeamemCloudOAuthAccount
} from '../../../src/cloud/auth-policy.js';

const authSource = readFileSync(
  join(process.cwd(), 'apps/web/src/server/auth.ts'),
  'utf8'
);
const authCoreSource = readFileSync(
  join(process.cwd(), 'apps/web/src/server/auth-core.ts'),
  'utf8'
);
const authCliSource = readFileSync(
  join(process.cwd(), 'apps/web/auth.cli.ts'),
  'utf8'
);
const routeSource = readFileSync(
  join(process.cwd(), 'apps/web/app/api/auth/[...all]/route.ts'),
  'utf8'
);
const dashboardSource = readFileSync(
  join(process.cwd(), 'apps/web/app/dashboard/page.tsx'),
  'utf8'
);
const loginSource = readFileSync(
  join(process.cwd(), 'apps/web/app/login/login-actions.tsx'),
  'utf8'
);
const loginPageSource = readFileSync(
  join(process.cwd(), 'apps/web/app/login/page.tsx'),
  'utf8'
);

describe('Teamem Cloud OAuth dashboard shell', () => {
  it('wires Better Auth to Supabase Postgres through the scaffold env contract', () => {
    expect(authSource).toContain("import 'server-only'");
    expect(authSource).toContain('createTeamemCloudAuth([nextCookies()])');
    expect(authCoreSource).toContain("import { Pool } from 'pg'");
    expect(authCoreSource).toContain('loadTeamemCloudWebEnv()');
    expect(authSource).toContain('export function getAuth()');
    expect(authCoreSource).toContain(
      'connectionString: env.supabase.postgresUrl'
    );
    expect(authCoreSource).toContain('database');
    expect(authCliSource).toContain('createTeamemCloudAuth()');
    expect(authCliSource).not.toContain('server-only');
  });

  it('keeps auth env validation lazy for build collection but fail-closed at use time', () => {
    expect(authCoreSource).not.toContain(
      'const envResult = loadTeamemCloudWebEnv();\n\nif (!envResult.ok)'
    );
    expect(authCoreSource).toContain(
      'const envResult = loadTeamemCloudWebEnv();'
    );
    expect(authCoreSource).toContain('throw new Error(');
    expect(authCoreSource).toContain('Teamem Cloud web auth env is missing');
    expect(authSource).toContain('handler(request: Request)');
    expect(authSource).toContain('return getAuth().handler(request)');
    expect(authSource).toContain('return getAuth().api');
  });

  it('mounts the Better Auth Next route handler', () => {
    expect(routeSource).toContain('toNextJsHandler(auth)');
    expect(routeSource).toContain('GET');
    expect(routeSource).toContain('POST');
  });

  it('supports GitHub first and optional Google OAuth through one auth model', () => {
    expect(TEAMEM_CLOUD_OAUTH_PROVIDERS).toEqual(['github', 'google']);
    expect(authCoreSource).toContain('github:');
    expect(authCoreSource).toContain('env.oauth.github.clientId');
    expect(authCoreSource).toContain('env.oauth.google');
    expect(authCoreSource).toContain('google:');
    expect(loginSource).toContain("signIn('github')");
    expect(loginSource).toContain("signIn('google')");
    expect(loginPageSource).toContain('isGoogleOAuthConfigured()');
    expect(loginPageSource).toContain('showGoogle=');
    expect(loginSource).toContain('showGoogle ?');
  });

  it('redirects signed-out users away from the dashboard and allows session users through', () => {
    expect(dashboardSource).toContain("dynamic = 'force-dynamic'");
    expect(dashboardSource).toContain('auth.api.getSession');
    expect(dashboardSource).toContain('headers: await headers()');
    expect(dashboardSource).toContain("redirect('/login?from=/dashboard')");
    expect(dashboardSource).toContain('getDashboardStateForUser');
    expect(dashboardSource).toContain('Dashboard');
  });

  it('locks verified-email-only account linking', () => {
    expect(TEAMEM_CLOUD_AUTH_ACCOUNT_LINKING_POLICY).toEqual({
      enabled: true,
      trustedProviders: [],
      allowDifferentEmails: false,
      requireLocalEmailVerified: true
    });
    expect(
      canLinkTeamemCloudOAuthAccount({
        provider: 'github',
        emailVerified: true
      })
    ).toBe(true);
    expect(
      canLinkTeamemCloudOAuthAccount({
        provider: 'google',
        emailVerified: true
      })
    ).toBe(true);
    expect(
      canLinkTeamemCloudOAuthAccount({
        provider: 'github',
        emailVerified: false
      })
    ).toBe(false);
    expect(
      canLinkTeamemCloudOAuthAccount({
        provider: 'google',
        emailVerified: false
      })
    ).toBe(false);
    expect(
      canLinkTeamemCloudOAuthAccount({
        provider: 'discord',
        emailVerified: true
      })
    ).toBe(false);
    expect(authCoreSource).toContain('accountLinking');
    expect(authCoreSource).toContain('trustedProviders');
    expect(authCoreSource).toContain('allowDifferentEmails');
    expect(authCoreSource).toContain('requireLocalEmailVerified');
  });

  it('keeps web login identity separate from Teamem runtime member identity', () => {
    expect(TEAMEM_CLOUD_AUTH_BOUNDARY.webAccountOwns).toEqual([
      'dashboard_access',
      'quota_owner',
      'space_provisioning_requests'
    ]);
    expect(TEAMEM_CLOUD_AUTH_BOUNDARY.runtimeIdentitySources).toEqual([
      'teamem_cli_setup_member_name',
      'teamem_plugin_runtime_principal'
    ]);
    expect(dashboardSource).toContain('runtime member identity');
    expect(authSource).not.toContain('runtimeMemberName');
    expect(authSource).not.toContain('runtimePrincipal');
  });
});
