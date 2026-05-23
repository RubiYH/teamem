# Teamem Cloud Deployment

This runbook covers the managed Teamem Cloud path: Vercel runs the web control plane, Supabase stores web accounts and Space metadata, and a Teamem runtime provisions Spaces through the cloud-admin API. Users who join through this path do not need to self-host Docker.

## Required Services

- Vercel project for `apps/web`.
- Supabase project with a Postgres database.
- Better Auth secret for web sessions.
- GitHub OAuth app. Google OAuth is optional but must be configured as a complete client-id/client-secret pair if enabled.
- Reachable Teamem runtime URL with cloud-admin provisioning enabled.
- Shared runtime provisioning token, generated once and configured in both the web app and runtime.

## Runtime Environment

Set these variables on the Teamem runtime:

| Variable | Required | Purpose |
| --- | --- | --- |
| `TEAMEM_PUBLIC_URL` | yes | Public runtime origin returned by cloud-admin provisioning and embedded in dashboard setup commands. |
| `TEAMEM_CLOUD_RUNTIME_PROVISIONING_TOKEN` | yes | Shared service token that allows the web control plane to call runtime cloud-admin endpoints. |

`TEAMEM_CLOUD_RUNTIME_URL` in the web app must point at the same origin as the runtime's `TEAMEM_PUBLIC_URL`. If `TEAMEM_PUBLIC_URL` is missing, the runtime falls back to localhost, which makes cloud setup commands unusable for users outside that runtime host.

## Web Environment

Set these variables in Vercel and in local `.env.local` files used by `apps/web`.

| Variable | Required | Purpose |
| --- | --- | --- |
| `TEAMEM_CLOUD_APP_URL` | yes | Canonical web origin, for example `https://cloud.teamem.dev` or `http://localhost:3000`. |
| `BETTER_AUTH_SECRET` | yes | Better Auth session secret. Generate a strong random value. |
| `BETTER_AUTH_URL` | yes | Better Auth base URL. Use the same origin as `TEAMEM_CLOUD_APP_URL`. |
| `GITHUB_CLIENT_ID` | yes | GitHub OAuth app client id. |
| `GITHUB_CLIENT_SECRET` | yes | GitHub OAuth app client secret. |
| `SUPABASE_POSTGRES_URL` | yes | Supabase direct Postgres connection string used by server-side control-plane code. |
| `SUPABASE_POSTGRES_CA_CERT` | no | Supabase Postgres server root certificate contents for Vercel/Node TLS verification when the pooler presents a self-signed chain. Store the full PEM text; escaped `\n` newlines are supported. |
| `SUPABASE_URL` | yes | Supabase project URL for the web app's Supabase client contract. |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Supabase service-role key for trusted server-side operations. Keep it server-only. |
| `TEAMEM_CLOUD_RUNTIME_URL` | yes | Hosted Teamem runtime base URL used by provisioning and displayed setup commands. |
| `TEAMEM_CLOUD_RUNTIME_PROVISIONING_TOKEN` | yes | Shared service token for runtime cloud-admin provisioning. Must match the runtime. |
| `NEXT_PUBLIC_POSTHOG_TOKEN` | yes | PostHog project token used by client and server analytics capture. |
| `NEXT_PUBLIC_POSTHOG_HOST` | yes | PostHog ingestion host, usually `https://us.i.posthog.com` or `https://eu.i.posthog.com`. |
| `GOOGLE_CLIENT_ID` | no | Optional Google OAuth client id. |
| `GOOGLE_CLIENT_SECRET` | no | Optional Google OAuth client secret. |
| `TEAMEM_CLOUD_BETTER_AUTH_TABLES` | no | Comma-separated Better Auth table override for deploy smoke only. Defaults to `user,session,account,verification`. |

The web app proxies client-side PostHog traffic through `/tmem`; keep `NEXT_PUBLIC_POSTHOG_HOST` on the matching US or EU ingestion host so the proxy rewrites target the correct region.

The runtime also needs `TEAMEM_CLOUD_RUNTIME_PROVISIONING_TOKEN` so it can authenticate web provisioning requests. Configure the runtime with the public URL it should return in setup commands.

## Supabase Setup

1. Create a Supabase project for the target environment.
2. Apply the Better Auth Postgres schema with the CLI config that avoids Next's `server-only` runtime guard:

   ```bash
   cd apps/web
   npx auth@latest migrate --config ./auth.cli.ts
   ```

   With the current standard Better Auth pg adapter config, the required tables are `user`, `session`, `account`, and `verification`. If the Better Auth model names are customized later, set `TEAMEM_CLOUD_BETTER_AUTH_TABLES` to the deployed table names before running the deploy smoke.
3. Apply `apps/web/db/migrations/001_control_plane.sql` to the same project database.
4. Copy the project URL into `SUPABASE_URL`.
5. Copy the service-role key into `SUPABASE_SERVICE_ROLE_KEY`.
6. Copy a server-side Postgres connection string into `SUPABASE_POSTGRES_URL`. Include any provider-required SSL mode in the URL.
7. If Vercel login or smoke checks fail with `SELF_SIGNED_CERT_IN_CHAIN`, download Supabase's server root certificate and store its full PEM content in `SUPABASE_POSTGRES_CA_CERT`. The app uses that CA for Better Auth and control-plane Postgres pools.

For local web development, either point `SUPABASE_POSTGRES_URL`, `SUPABASE_URL`, and `SUPABASE_SERVICE_ROLE_KEY` at a hosted Supabase dev project or run an equivalent local Postgres database and apply both the Better Auth schema and the control-plane migration. The current env contract still requires `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` even when only local Postgres is used by the server path, because the web app keeps one deployment env shape across hosted and local development. For a local Postgres-only smoke, set `SUPABASE_POSTGRES_URL` to the local database and set `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` to non-empty local placeholder values so env validation stays deterministic.

## OAuth Setup

Create a GitHub OAuth app with callback URL:

```text
https://<your-web-origin>/api/auth/callback/github
```

For local development, add:

```text
http://localhost:3000/api/auth/callback/github
```

If Google OAuth is enabled, configure the equivalent Google callback:

```text
https://<your-web-origin>/api/auth/callback/google
```

Google credentials are optional, but `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` must be provided together.

## Local Runtime Smoke

To point the web app at a local Teamem runtime during development:

1. Start the runtime locally with cloud-admin provisioning enabled and a generated `TEAMEM_CLOUD_RUNTIME_PROVISIONING_TOKEN`.
2. Set `TEAMEM_CLOUD_RUNTIME_URL` in `apps/web/.env.local` to the local runtime origin, for example `http://localhost:8787`.
3. Set the same `TEAMEM_CLOUD_RUNTIME_PROVISIONING_TOKEN` in `apps/web/.env.local`.
4. Run the web app from `apps/web`:

```bash
bun run dev
```

Create a Space in the dashboard and confirm the setup command displays the local runtime URL. This is the development smoke path for validating the web control plane against a local runtime.

## Deploy Smoke

After configuring env and applying the migration, run:

```bash
bun run web:smoke:deploy
```

Or from `apps/web`:

```bash
bun run smoke:deploy
```

The deploy smoke checks:

- required Teamem Cloud web env presence;
- server-side Postgres connectivity through `SUPABASE_POSTGRES_URL`;
- existence of Better Auth tables, defaulting to `user`, `session`, `account`, and `verification`;
- existence of `cloud_accounts`, `cloud_spaces`, and `cloud_audit_events`.

It does not perform OAuth login or create a Space. Use the manual onboarding smoke in `tests/smoke/teamem-cloud-onboarding.md` for the full user journey.

## Manual Console Steps

These steps remain manual because they require provider-console access:

- Create or update the Vercel project and set all web env vars.
- Create the Supabase project, apply the Better Auth schema plus control-plane migration, and copy the database credentials.
- Create GitHub OAuth credentials and optional Google OAuth credentials with production and local callback URLs.
- Generate and store the shared runtime provisioning token in both the web app and Teamem runtime.
- Deploy or select the Teamem runtime URL, set it as runtime `TEAMEM_PUBLIC_URL`, and set the matching web `TEAMEM_CLOUD_RUNTIME_URL`.
