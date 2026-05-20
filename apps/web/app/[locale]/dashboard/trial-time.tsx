'use client';

import { useEffect, useState } from 'react';
import {
  formatClientTrialTime,
  type ClientTrialTimeLabels
} from './trial-time-format';

type TrialTimeProps = {
  expiresAt: string;
  locale: string;
  label: string;
  expiredLabel: string;
};

export function TrialTime({
  expiresAt,
  locale,
  label,
  expiredLabel
}: TrialTimeProps) {
  const [labels, setLabels] = useState<ClientTrialTimeLabels | null>(null);

  useEffect(() => {
    setLabels(formatClientTrialTime(expiresAt, locale, expiredLabel));
  }, [expiredLabel, expiresAt, locale]);

  return (
    <p
      className="text-sm leading-6 text-muted-foreground"
      suppressHydrationWarning
    >
      {label}:{' '}
      <span className="text-foreground">{labels?.relativeLabel ?? '...'}</span>{' '}
      (
      <time dateTime={expiresAt} suppressHydrationWarning>
        {labels?.exactLabel ?? '...'}
      </time>
      )
    </p>
  );
}
