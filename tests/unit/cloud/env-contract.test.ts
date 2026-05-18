import { describe, expect, it } from 'bun:test';
import {
  TEAMEM_CLOUD_OPTIONAL_WEB_ENV_KEYS,
  TEAMEM_CLOUD_WEB_ENV_KEYS,
  isGoogleOAuthConfigured,
  loadTeamemCloudWebEnv
} from '../../../src/cloud/env-contract.js';

const completeEnv = {
  TEAMEM_CLOUD_APP_URL: 'https://cloud.teamem.dev',
  BETTER_AUTH_SECRET: 'secret',
  BETTER_AUTH_URL: 'https://cloud.teamem.dev',
  GITHUB_CLIENT_ID: 'github-id',
  GITHUB_CLIENT_SECRET: 'github-secret',
  GOOGLE_CLIENT_ID: 'google-id',
  GOOGLE_CLIENT_SECRET: 'google-secret',
  SUPABASE_POSTGRES_URL: 'postgres://example',
  SUPABASE_URL: 'https://supabase.example',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role',
  TEAMEM_CLOUD_RUNTIME_URL: 'https://runtime.teamem.dev',
  TEAMEM_CLOUD_RUNTIME_PROVISIONING_TOKEN: 'runtime-token'
};

describe('loadTeamemCloudWebEnv', () => {
  it('declares the full Teamem Cloud deployment contract', () => {
    expect(TEAMEM_CLOUD_WEB_ENV_KEYS).toEqual([
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
    ]);
    expect(TEAMEM_CLOUD_OPTIONAL_WEB_ENV_KEYS).toEqual([
      'GOOGLE_CLIENT_ID',
      'GOOGLE_CLIENT_SECRET'
    ]);
  });

  it('loads Better Auth, OAuth, Supabase, and runtime provisioning settings', () => {
    const result = loadTeamemCloudWebEnv(completeEnv);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('expected valid env');
    }
    expect(result.value.oauth.github.clientId).toBe('github-id');
    expect(result.value.oauth.google?.clientSecret).toBe('google-secret');
    expect(result.value.supabase.postgresUrl).toBe('postgres://example');
    expect(result.value.runtime.provisioningToken).toBe('runtime-token');
  });

  it('allows Google OAuth credentials to be absent as a pair', () => {
    const result = loadTeamemCloudWebEnv({
      ...completeEnv,
      GOOGLE_CLIENT_ID: '',
      GOOGLE_CLIENT_SECRET: ''
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('expected valid env');
    }
    expect(result.value.oauth.github.clientId).toBe('github-id');
    expect(result.value.oauth.google).toBeUndefined();
    expect(
      isGoogleOAuthConfigured({
        ...completeEnv,
        GOOGLE_CLIENT_ID: '',
        GOOGLE_CLIENT_SECRET: ''
      })
    ).toBe(false);
  });

  it('exposes Google login availability from the optional env pair', () => {
    expect(isGoogleOAuthConfigured(completeEnv)).toBe(true);
    expect(
      isGoogleOAuthConfigured({
        ...completeEnv,
        GOOGLE_CLIENT_SECRET: ''
      })
    ).toBe(false);
  });

  it('requires Google OAuth credentials to be provided as a complete pair', () => {
    const result = loadTeamemCloudWebEnv({
      ...completeEnv,
      GOOGLE_CLIENT_SECRET: ''
    });

    expect(result).toEqual({
      ok: false,
      missing: ['GOOGLE_CLIENT_SECRET']
    });
  });

  it('reports every missing required key deterministically', () => {
    const result = loadTeamemCloudWebEnv({
      ...completeEnv,
      GITHUB_CLIENT_SECRET: '',
      GOOGLE_CLIENT_ID: '',
      GOOGLE_CLIENT_SECRET: '',
      TEAMEM_CLOUD_RUNTIME_URL: ' '
    });

    expect(result).toEqual({
      ok: false,
      missing: ['GITHUB_CLIENT_SECRET', 'TEAMEM_CLOUD_RUNTIME_URL']
    });
  });
});
