'use client';

import { useState } from 'react';
import { Button } from '../../src/components/ui/button';
import { authClient } from '../../src/lib/auth-client';

type OAuthProvider = 'github' | 'google';

export function LoginActions({ showGoogle }: { showGoogle: boolean }) {
  const [pendingProvider, setPendingProvider] = useState<OAuthProvider | null>(
    null
  );

  async function signIn(provider: OAuthProvider) {
    setPendingProvider(provider);
    try {
      await authClient.signIn.social({
        provider,
        callbackURL: '/dashboard'
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
        {pendingProvider === 'github'
          ? 'Opening GitHub...'
          : 'Continue with GitHub'}
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
            ? 'Opening Google...'
            : 'Continue with Google'}
        </Button>
      ) : null}
    </div>
  );
}
