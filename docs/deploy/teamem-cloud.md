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
3. Apply all control-plane migrations in `apps/web/db/migrations/` to the same project database in filename order:

   - `001_control_plane.sql`
   - `002_issue01_free_trial_policy_and_grants.sql`
   - `003_issue03_cloud_space_policy_metadata.sql`
   - `004_issue07_policy_override_audit_events.sql`

   Existing deployments that already ran an older `001_control_plane.sql` must not rerun it. Run each additive/backfill migration that has not already been applied before deploying web code that depends on the new tables, fields, or audit event types.
4. Copy the project URL into `SUPABASE_URL`.
5. Copy the service-role key into `SUPABASE_SERVICE_ROLE_KEY`.
6. Copy a server-side Postgres connection string into `SUPABASE_POSTGRES_URL`. Include any provider-required SSL mode in the URL.
7. If Vercel login or smoke checks fail with `SELF_SIGNED_CERT_IN_CHAIN`, download Supabase's server root certificate and store its full PEM content in `SUPABASE_POSTGRES_CA_CERT`. The app uses that CA for Better Auth and control-plane Postgres pools.

For local web development, either point `SUPABASE_POSTGRES_URL`, `SUPABASE_URL`, and `SUPABASE_SERVICE_ROLE_KEY` at a hosted Supabase dev project or run an equivalent local Postgres database and apply both the Better Auth schema and all control-plane migrations. The current env contract still requires `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` even when only local Postgres is used by the server path, because the web app keeps one deployment env shape across hosted and local development. For a local Postgres-only smoke, set `SUPABASE_POSTGRES_URL` to the local database and set `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` to non-empty local placeholder values so env validation stays deterministic.

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

## Free Trial Policy

Teamem Cloud currently offers one Free trial Space per web account. The active control-plane policy is stored in `cloud_plan_policies` and resolves to a 14-day trial, three user-facing runtime members, and `one_lifetime_space` quota semantics. The grant is consumed when the control plane accepts a Space request and creates `cloud_free_plan_grants`; deleting a successfully provisioned Space does not restore the grant.

Terminal runtime provisioning failures are the exception. If the runtime returns a confirmed `provisioning_failed` result, the control plane marks the Space failed and voids the reserved grant so the account can retry. Existing terminal `provisioning_failed` records from before the policy copy do not consume a free grant and do not require runtime enforcement metadata.

The resolved policy is copied into two places:

- Control plane: `cloud_spaces.trial_expires_at`, `cloud_spaces.member_limit`, and suspension metadata.
- Runtime: `spaces.cloud_trial_expires_at`, `spaces.cloud_member_limit`, and suspension metadata, keyed only by opaque Cloud Space IDs.

Backfills must keep this copy deterministic. For existing control-plane Spaces, use `requested_at` when present and fall back to `created_at` to calculate `trial_expires_at`. For existing runtime Spaces, use the control-plane creation/request timestamp when it is available to the migration or reconciliation input; otherwise use the runtime `spaces.created_at` timestamp. Existing Spaces older than 14 days are not proactively swept by the dashboard migration; they suspend lazily on the next control-plane dashboard request or runtime request.

Operator overrides are an explicit two-phase operation: update the runtime policy through the cloud-admin API first, then commit the resolved control-plane fields and audit event. Extending an expired trial into the future clears `free_trial_expired` suspension in both places; shortening a trial or lowering the member limit takes effect on the next runtime status, join, or authenticated runtime request.

## Deploy Smoke

After configuring env and applying the migrations, run:

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

For free-trial launch hardening, the automated smoke coverage lives in the focused Cloud tests: control-plane tests cover create, deleted trial consumption, terminal provisioning-failed retry, migration/backfill behavior, and runtime-status-unavailable dashboard behavior; runtime integration tests cover join under limit, full-space join failure, expiry suspension, override propagation, and suspended runtime request failures.

## Manual Console Steps

These steps remain manual because they require provider-console access:

- Create or update the Vercel project and set all web env vars.
- Create the Supabase project, apply the Better Auth schema plus all control-plane migrations, and copy the database credentials.
- Create GitHub OAuth credentials and optional Google OAuth credentials with production and local callback URLs.
- Generate and store the shared runtime provisioning token in both the web app and Teamem runtime.
- Deploy or select the Teamem runtime URL, set it as runtime `TEAMEM_PUBLIC_URL`, and set the matching web `TEAMEM_CLOUD_RUNTIME_URL`.
