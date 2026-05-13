/**
 * Slice #36 — list_claims tool integration tests.
 *
 * AC coverage:
 *  - scope="self" returns only the principal's active+paused claims, excludes released
 *  - scope="space" returns every member's active+paused claims
 *  - paused claims show status="paused", paused_at, paused_reason
 *  - empty list returns {claims:[]} gracefully
 *  - released claims excluded
 *  - invalid scope returns error
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import { createSqliteClient } from '../../../src/infra/db/sqlite-client.js';
import { SqliteEventStore } from '../../../src/infra/db/sqlite-event-store.js';
import { createTeamemTools } from '../../../src/server/tools/index.js';
import { runAllMigrations } from '../../helpers/migrations.js';
import type { Database } from 'bun:sqlite';

function setup(): {
  db: Database;
  tools: ReturnType<typeof createTeamemTools>;
} {
  const db = createSqliteClient(':memory:');
  runAllMigrations(db);
  const store = new SqliteEventStore(db);
  const tools = createTeamemTools({ db, store });
  return { db, tools };
}

const SPACE = 'space-lc-01';
const REPO = 'github.com/org/repo';
const BRANCH = 'feature/alice';
const ALICE = 'alice';
const BOB = 'bob';

function seedClaim(
  tools: ReturnType<typeof createTeamemTools>,
  path: string,
  principal = ALICE,
  mode: 'on_commit' | 'manual_only' | 'ttl' = 'on_commit'
): string {
  const result = tools.claimScope({
    space_id: SPACE,
    principal,
    actor: principal,
    delegation: `${principal}->${principal}`,
    scope: { paths: [path] },
    repo_id: REPO,
    branch: BRANCH,
    auto_release_mode: mode
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`seed claim failed for ${path}`);
  return (result.data as { claim_id: string }).claim_id;
}

describe('list_claims tool (slice #36)', () => {
  let tools: ReturnType<typeof createTeamemTools>;

  beforeEach(() => {
    ({ tools } = setup());
  });

  it("scope=self: returns only principal's active claims with correct shape", () => {
    seedClaim(tools, 'src/Form.tsx');
    seedClaim(tools, 'src/Button.tsx');
    seedClaim(tools, 'src/Other.tsx', BOB);

    const result = tools.listClaims({
      space_id: SPACE,
      principal: ALICE,
      scope: 'self'
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { claims } = result.data as { claims: unknown[] };
    expect(claims).toHaveLength(2);
    for (const c of claims as Array<Record<string, unknown>>) {
      expect(c.principal).toBe(ALICE);
      expect(c.repo_id).toBe(REPO);
      expect(c.branch).toBe(BRANCH);
      expect(typeof c.claim_id).toBe('string');
      expect(typeof c.path).toBe('string');
      expect(typeof c.mode).toBe('string');
      expect(typeof c.status).toBe('string');
      expect(typeof c.created_at).toBe('string');
    }
  });

  it('scope=space: returns claims from all principals', () => {
    seedClaim(tools, 'src/Form.tsx', ALICE);
    seedClaim(tools, 'src/Api.ts', BOB);

    const result = tools.listClaims({
      space_id: SPACE,
      principal: ALICE,
      scope: 'space'
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { claims } = result.data as { claims: Array<{ principal: string }> };
    expect(claims).toHaveLength(2);
    const principals = new Set(claims.map((c) => c.principal));
    expect(principals.has(ALICE)).toBe(true);
    expect(principals.has(BOB)).toBe(true);
  });

  it('released claims are excluded', () => {
    const claimId = seedClaim(tools, 'src/Form.tsx');
    tools.releaseScope({
      space_id: SPACE,
      principal: ALICE,
      actor: ALICE,
      delegation: `${ALICE}->${ALICE}`,
      claim_id: claimId
    });

    const result = tools.listClaims({
      space_id: SPACE,
      principal: ALICE,
      scope: 'self'
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { claims } = result.data as { claims: unknown[] };
    expect(claims).toHaveLength(0);
  });

  it('paused claims show status=paused with paused_at and paused_reason', () => {
    seedClaim(tools, 'src/Form.tsx');
    tools.pauseClaimsForBranch({
      space_id: SPACE,
      principal: ALICE,
      actor: ALICE,
      delegation: `${ALICE}->${ALICE}`,
      repo_id: REPO,
      branch: BRANCH,
      reason: 'branch_switch'
    });

    const result = tools.listClaims({
      space_id: SPACE,
      principal: ALICE,
      scope: 'self'
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { claims } = result.data as {
      claims: Array<Record<string, unknown>>;
    };
    expect(claims).toHaveLength(1);
    expect(claims[0]?.status).toBe('paused');
    expect(claims[0]?.paused_at).toBeTruthy();
    expect(claims[0]?.paused_reason).toBe('branch_switch');
  });

  it('empty list returns ok with empty array', () => {
    const result = tools.listClaims({
      space_id: SPACE,
      principal: ALICE,
      scope: 'self'
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { claims } = result.data as { claims: unknown[] };
    expect(claims).toHaveLength(0);
  });

  it('invalid scope returns error', () => {
    const result = tools.listClaims({
      space_id: SPACE,
      principal: ALICE,
      scope: 'invalid' as 'self'
    });
    expect(result.ok).toBe(false);
  });

  it('mode field matches auto_release_mode', () => {
    seedClaim(tools, 'src/A.ts', ALICE, 'on_commit');
    seedClaim(tools, 'src/B.ts', ALICE, 'manual_only');

    const result = tools.listClaims({
      space_id: SPACE,
      principal: ALICE,
      scope: 'self'
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { claims } = result.data as {
      claims: Array<{ path: string; mode: string }>;
    };
    const modes = Object.fromEntries(claims.map((c) => [c.path, c.mode]));
    expect(modes['src/A.ts']).toBe('on_commit');
    expect(modes['src/B.ts']).toBe('manual_only');
  });
});
