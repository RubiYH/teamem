export const supportedLocales = ['en', 'ko'] as const;

export type Locale = (typeof supportedLocales)[number];

export const defaultLocale: Locale = 'en';
