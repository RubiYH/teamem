import type { NextConfig } from 'next';
import { PHASE_PRODUCTION_BUILD } from 'next/constants';
import createNextIntlPlugin from 'next-intl/plugin';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTeamemCloudWebEnv } from '../../src/cloud/env-contract';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const withNextIntl = createNextIntlPlugin();
const posthogProxyPath = '/tmem';
const posthogIngestionHost =
  process.env.NEXT_PUBLIC_POSTHOG_HOST ?? 'https://us.i.posthog.com';
const posthogAssetHost = posthogIngestionHost.includes('eu.')
  ? 'https://eu-assets.i.posthog.com'
  : 'https://us-assets.i.posthog.com';

const nextConfig: NextConfig = {
  outputFileTracingRoot: repoRoot,
  reactStrictMode: true,
  skipTrailingSlashRedirect: true,
  async rewrites() {
    return [
      {
        source: `${posthogProxyPath}/static/:path*`,
        destination: `${posthogAssetHost}/static/:path*`
      },
      {
        source: `${posthogProxyPath}/array/:path*`,
        destination: `${posthogAssetHost}/array/:path*`
      },
      {
        source: `${posthogProxyPath}/:path*`,
        destination: `${posthogIngestionHost}/:path*`
      }
    ];
  },
  webpack(config) {
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js']
    };
    return config;
  }
};

function validateTeamemCloudAppUrlForBuild() {
  const envResult = loadTeamemCloudWebEnv();

  if (!envResult.ok) {
    throw new Error(
      `Teamem Cloud build env is missing: ${envResult.missing.join(', ')}`
    );
  }

  try {
    new URL(envResult.value.appUrl);
  } catch {
    throw new Error(
      'Teamem Cloud build env is invalid: TEAMEM_CLOUD_APP_URL must be an absolute URL'
    );
  }
}

export default function createConfig(phase: string) {
  if (phase === PHASE_PRODUCTION_BUILD) {
    validateTeamemCloudAppUrlForBuild();
  }

  return withNextIntl(nextConfig);
}
