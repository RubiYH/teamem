'use client';

import posthog from 'posthog-js';
import { Button } from '../../src/components/ui/button';

export function LandingPrimaryCta({
  href,
  children,
  className
}: {
  href: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Button
      asChild
      className={className}
      href={href}
      onClick={() => posthog.capture('landing_cta_clicked', { cta: 'primary' })}
    >
      {children}
    </Button>
  );
}

export function LandingSecondaryCta({
  href,
  children,
  className
}: {
  href: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Button
      asChild
      className={className}
      href={href}
      variant="secondary"
      onClick={() =>
        posthog.capture('landing_github_clicked', { cta: 'secondary' })
      }
    >
      {children}
    </Button>
  );
}
