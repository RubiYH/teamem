import { defineRouting } from 'next-intl/routing';
import { defaultLocale, supportedLocales } from './locales';

export const routing = defineRouting({
  locales: supportedLocales,
  defaultLocale
});

export type { Locale } from './locales';
