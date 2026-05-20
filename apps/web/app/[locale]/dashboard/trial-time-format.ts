export type ClientTrialTimeLabels = {
  relativeLabel: string;
  exactLabel: string;
};

export function formatClientTrialTime(
  expiresAt: string,
  locale: string,
  expiredLabel: string,
  now = Date.now()
): ClientTrialTimeLabels {
  const expires = new Date(expiresAt);
  return {
    relativeLabel: formatRelativeTrialTime(expires, locale, expiredLabel, now),
    exactLabel: new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'short'
    }).format(expires)
  };
}

export function formatRelativeTrialTime(
  expires: Date,
  locale: string,
  expiredLabel: string,
  now = Date.now()
): string {
  const diffMs = expires.getTime() - now;
  if (diffMs <= 0) {
    return expiredLabel;
  }

  const dayMs = 24 * 60 * 60 * 1000;
  const hourMs = 60 * 60 * 1000;
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });

  if (diffMs >= dayMs) {
    return formatter.format(Math.ceil(diffMs / dayMs), 'day');
  }

  return formatter.format(Math.ceil(diffMs / hourMs), 'hour');
}
