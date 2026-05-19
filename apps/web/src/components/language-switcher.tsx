'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { Link, usePathname } from '../i18n/navigation';
import { cn } from '../lib/cn';
import type { Locale } from '../i18n/routing';
import { rewriteLocaleSensitiveSearch } from '../i18n/return-target';

const localeOptions: Array<{ locale: Locale; shortLabel: string }> = [
  { locale: 'en', shortLabel: 'EN' },
  { locale: 'ko', shortLabel: 'KO' }
];

export function LanguageSwitcher({ className }: { className?: string }) {
  const currentLocale = useLocale() as Locale;
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const t = useTranslations('LocaleSwitcher');

  return (
    <nav
      aria-label={t('label')}
      className={cn(
        'inline-flex h-9 shrink-0 items-center rounded-md border border-border bg-muted p-0.5 text-xs font-semibold text-muted-foreground',
        className
      )}
    >
      {localeOptions.map((option) => {
        const isActive = option.locale === currentLocale;
        const search = rewriteLocaleSensitiveSearch(
          searchParams.toString(),
          option.locale
        );
        const href = search ? `${pathname}?${search}` : pathname;

        return (
          <Link
            aria-current={isActive ? 'true' : undefined}
            aria-label={t(
              option.locale === 'en' ? 'switchToEnglish' : 'switchToKorean'
            )}
            className={cn(
              'inline-flex h-7 min-w-9 items-center justify-center rounded-sm px-2 transition-colors hover:text-foreground',
              isActive
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground'
            )}
            href={href}
            key={option.locale}
            locale={option.locale}
            prefetch={false}
          >
            {option.shortLabel}
          </Link>
        );
      })}
    </nav>
  );
}
