import { LoginActions } from './login-actions';
import { isGoogleOAuthConfigured } from '../../../../src/cloud/env-contract';

export default function LoginPage() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <section className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-5 py-10">
        <div className="space-y-6 rounded-md border border-border bg-panel p-5 shadow-panel">
          <div className="space-y-2">
            <a className="text-sm font-semibold" href="/">
              Teamem Cloud
            </a>
            <h1 className="text-2xl font-semibold">Sign in</h1>
            <p className="text-sm leading-6 text-muted-foreground">
              Use an OAuth account to access the Cloud dashboard. Runtime Teamem
              member identity is still chosen later in the local setup flow.
            </p>
          </div>
          <LoginActions showGoogle={isGoogleOAuthConfigured()} />
        </div>
      </section>
    </main>
  );
}
