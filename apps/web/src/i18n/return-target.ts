import { routing, type Locale } from './routing';

const localOrigin = 'https://teamem.local';
const localeLikeSegment = /^[a-z]{2}(?:-[a-z]{2})?$/i;

export function normalizeLocale(value: string): Locale {
  return routing.locales.includes(value as Locale)
    ? (value as Locale)
    : routing.defaultLocale;
}

export function sanitizeReturnTarget(
  rawTarget: string | null | undefined,
  locale: Locale
): string {
  const fallback = `/${locale}/dashboard`;
  const candidate = rawTarget?.trim();

  if (
    !candidate ||
    !candidate.startsWith('/') ||
    candidate.startsWith('//') ||
    candidate.includes('\\')
  ) {
    return fallback;
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate, localOrigin);
  } catch {
    return fallback;
  }

  if (parsed.origin !== localOrigin) {
    return fallback;
  }

  const [, firstSegment, ...remainingSegments] = parsed.pathname.split('/');
  let pathname: string;

  if (isLocale(firstSegment)) {
    pathname = `/${[locale, ...remainingSegments].join('/')}`;
  } else if (firstSegment && localeLikeSegment.test(firstSegment)) {
    return fallback;
  } else if (parsed.pathname === '/') {
    pathname = `/${locale}`;
  } else {
    pathname = `/${locale}${parsed.pathname}`;
  }

  return `${pathname}${parsed.search}${parsed.hash}`;
}

export function rewriteLocaleSensitiveSearch(
  search: string,
  locale: Locale
): string {
  const params = new URLSearchParams(search);
  const returnTarget = params.get('from');

  if (returnTarget !== null) {
    params.set('from', sanitizeReturnTarget(returnTarget, locale));
  }

  return params.toString();
}

function isLocale(value: string | undefined): value is Locale {
  return routing.locales.includes(value as Locale);
}
