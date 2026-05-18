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
});
