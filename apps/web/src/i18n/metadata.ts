import type { Metadata } from 'next';
import { routing, type Locale } from './routing';
import { loadTeamemCloudWebEnv } from '../server/env';

type LocalizedMetadataInput = {
  locale: Locale;
  path?: string;
  title: string;
  description: string;
};

export function buildLocalizedMetadata({
  locale,
  path = '',
  title,
  description
}: LocalizedMetadataInput): Metadata {
  return {
    metadataBase: getMetadataBase(),
    title,
    description,
    alternates: {
      canonical: buildLocalePath(locale, path),
      languages: Object.fromEntries(
        routing.locales.map((alternateLocale) => [
          alternateLocale,
          buildLocalePath(alternateLocale, path)
        ])
      )
    }
  };
}

function buildLocalePath(locale: Locale, path: string): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `/${locale}${normalizedPath === '/' ? '' : normalizedPath}`;
}

function getMetadataBase(): URL {
  const envResult = loadTeamemCloudWebEnv();

  if (!envResult.ok) {
    throw new Error(
      `Teamem Cloud metadata env is missing: ${envResult.missing.join(', ')}`
    );
  }

  try {
    return new URL(envResult.value.appUrl);
  } catch {
    throw new Error(
      'Teamem Cloud metadata env is invalid: TEAMEM_CLOUD_APP_URL must be an absolute URL'
    );
  }
}
