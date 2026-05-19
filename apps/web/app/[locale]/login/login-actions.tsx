'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '../../../src/components/ui/button';
import { authClient } from '../../../src/lib/auth-client';

type OAuthProvider = 'github' | 'google';

export function LoginActions({
  returnTo,
  showGoogle
}: {
  returnTo: string;
  showGoogle: boolean;
}) {
  const t = useTranslations('LoginPage.actions');
  const [pendingProvider, setPendingProvider] = useState<OAuthProvider | null>(
    null
  );

  async function signIn(provider: OAuthProvider) {
    setPendingProvider(provider);
    try {
      await authClient.signIn.social({
        provider,
        callbackURL: returnTo
      });
    } finally {
      setPendingProvider(null);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <Button
        className="w-full"
        disabled={pendingProvider !== null}
        onClick={() => void signIn('github')}
        type="button"
      >
        {pendingProvider === 'github' ? t('github.pending') : t('github.label')}
      </Button>
      {showGoogle ? (
        <Button
          className="w-full"
          disabled={pendingProvider !== null}
          onClick={() => void signIn('google')}
          type="button"
          variant="secondary"
        >
          {pendingProvider === 'google'
            ? t('google.pending')
            : t('google.label')}
        </Button>
      ) : null}
    </div>
  );
}
