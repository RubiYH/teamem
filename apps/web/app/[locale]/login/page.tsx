import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { LoginActions } from './login-actions';
import { LanguageSwitcher } from '../../../src/components/language-switcher';
import { buildLocalizedMetadata } from '../../../src/i18n/metadata';
import {
  normalizeLocale,
  sanitizeReturnTarget
} from '../../../src/i18n/return-target';
import { isGoogleOAuthConfigured } from '../../../../../src/cloud/env-contract';

export async function generateMetadata({
  params
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale: rawLocale } = await params;
  const locale = normalizeLocale(rawLocale);
  const t = await getTranslations({ locale, namespace: 'Metadata.login' });

  return buildLocalizedMetadata({
    locale,
    path: '/login',
    title: t('title'),
    description: t('description')
  });
}

export default async function LoginPage({
  params,
  searchParams
}: {
  params: Promise<{ locale: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale: rawLocale } = await params;
  const locale = normalizeLocale(rawLocale);
  const t = await getTranslations({ locale, namespace: 'LoginPage' });
  const resolvedSearchParams = await searchParams;
  const returnTo = sanitizeReturnTarget(
    getSingleSearchParam(resolvedSearchParams?.from),
    locale
  );
  const hasAuthError =
    typeof resolvedSearchParams?.error === 'string' ||
    typeof resolvedSearchParams?.callbackError === 'string';

  return (
    <main className="min-h-screen bg-background text-foreground">
      <section className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-5 py-10">
        <div className="space-y-6 rounded-md border border-border bg-panel p-5 shadow-panel">
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <a className="text-sm font-semibold" href={`/${locale}`}>
                {t('brand')}
              </a>
              <LanguageSwitcher />
            </div>
            <h1 className="text-2xl font-semibold">{t('title')}</h1>
            <p className="text-sm leading-6 text-muted-foreground">
              {t('description')}
            </p>
            {hasAuthError ? (
              <p className="text-sm leading-6 text-muted-foreground">
                {t('authError')}
              </p>
            ) : null}
          </div>
          <LoginActions
            returnTo={returnTo}
            showGoogle={isGoogleOAuthConfigured()}
          />
        </div>
      </section>
    </main>
  );
}

function getSingleSearchParam(value: string | string[] | undefined) {
  return typeof value === 'string' ? value : undefined;
}
