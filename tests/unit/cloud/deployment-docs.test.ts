import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  TEAMEM_CLOUD_OPTIONAL_WEB_ENV_KEYS,
  TEAMEM_CLOUD_WEB_ENV_KEYS
} from '../../../src/cloud/env-contract.js';

const repoRoot = process.cwd();

function readText(path: string): string {
  return readFileSync(join(repoRoot, path), 'utf8');
}

describe('Teamem Cloud deployment documentation', () => {
  it('documents every web env key from the deployment contract', () => {
    const doc = readText('docs/deploy/teamem-cloud.md');
    for (const key of [
      ...TEAMEM_CLOUD_WEB_ENV_KEYS,
      ...TEAMEM_CLOUD_OPTIONAL_WEB_ENV_KEYS
    ]) {
      expect(doc).toContain(`\`${key}\``);
    }
  });

  it('keeps deploy smoke scripts wired from root and apps/web', () => {
    const rootPackage = JSON.parse(readText('package.json')) as {
      scripts: Record<string, string>;
    };
    const webPackage = JSON.parse(readText('apps/web/package.json')) as {
      scripts: Record<string, string>;
    };
    const smokeScript = readText('apps/web/scripts/deploy-smoke.ts');

    expect(rootPackage.scripts['web:smoke:deploy']).toBe(
      'cd apps/web && bun run smoke:deploy'
    );
    expect(webPackage.scripts['smoke:deploy']).toBe(
      'bun run scripts/deploy-smoke.ts'
    );
    expect(smokeScript).toContain('loadTeamemCloudWebEnv');
    expect(smokeScript).toContain('SELECT 1 AS ok');
    expect(smokeScript).toContain('cloud_accounts');
    expect(smokeScript).toContain('cloud_spaces');
    expect(smokeScript).toContain('cloud_audit_events');
    expect(smokeScript).toContain('DEFAULT_BETTER_AUTH_TABLES');
    expect(smokeScript).toContain('TEAMEM_CLOUD_BETTER_AUTH_TABLES');
  });

  it('documents no-Docker onboarding and local runtime smoke coverage', () => {
    const deployDoc = readText('docs/deploy/teamem-cloud.md');
    const smokeDoc = readText('tests/smoke/teamem-cloud-onboarding.md');

    expect(deployDoc).toContain('do not need to self-host Docker');
    expect(deployDoc).toContain('hosted Supabase dev project');
    expect(deployDoc).toContain('local Postgres');
    expect(deployDoc).toContain('local placeholder values');
    expect(deployDoc).toContain('all control-plane migrations');
    expect(deployDoc).toContain('`001_control_plane.sql`');
    expect(deployDoc).toContain(
      '`002_issue01_free_trial_policy_and_grants.sql`'
    );
    expect(deployDoc).toContain(
      '`003_issue03_cloud_space_policy_metadata.sql`'
    );
    expect(deployDoc).toContain(
      '`004_issue07_policy_override_audit_events.sql`'
    );
    expect(deployDoc).toContain('must not rerun it');
    expect(deployDoc).toContain('additive/backfill migration');
    expect(deployDoc).toContain('local Teamem runtime');
    expect(deployDoc).toContain('`TEAMEM_PUBLIC_URL`');
    expect(deployDoc).toContain('must point at the same origin as the runtime');
    expect(deployDoc).toContain(
      '`user`, `session`, `account`, and `verification`'
    );
    expect(smokeDoc).toContain('without asking the user to self-host Docker');
    expect(smokeDoc).toContain('teamem init --join --server-url');
    expect(smokeDoc).toContain('teamem cc');
  });

  it('documents free-trial policy, grant, runtime copy, and override semantics', () => {
    const deployDoc = readText('docs/deploy/teamem-cloud.md');

    expect(deployDoc).toContain('one Free trial Space per web account');
    expect(deployDoc).toContain('14-day trial');
    expect(deployDoc).toContain('three user-facing runtime members');
    expect(deployDoc).toContain('deleting a successfully provisioned Space');
    expect(deployDoc).toContain('does not restore the grant');
    expect(deployDoc).toContain('provisioning_failed');
    expect(deployDoc).toContain('voids the reserved grant');
    expect(deployDoc).toContain('control-plane creation/request timestamp');
    expect(deployDoc).toContain('runtime `spaces.created_at` timestamp');
    expect(deployDoc).toContain('suspend lazily');
    expect(deployDoc).toContain('cloud-admin API first');
    expect(deployDoc).toContain('clears `free_trial_expired` suspension');
  });
});
