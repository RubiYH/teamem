import type { NextConfig } from 'next';
import { PHASE_PRODUCTION_BUILD } from 'next/constants';
import createNextIntlPlugin from 'next-intl/plugin';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTeamemCloudWebEnv } from '../../src/cloud/env-contract';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const withNextIntl = createNextIntlPlugin();

const nextConfig: NextConfig = {
  outputFileTracingRoot: repoRoot,
  reactStrictMode: true,
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
