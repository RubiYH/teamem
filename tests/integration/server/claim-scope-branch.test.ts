import { describe, it, expect, beforeEach } from 'bun:test';
import { runAllMigrations } from '../../helpers/migrations.js';
import { createSqliteClient } from '../../../src/infra/db/sqlite-client.js';
import { SqliteEventStore } from '../../../src/infra/db/sqlite-event-store.js';
import { createTeamemTools } from '../../../src/server/tools/index.js';
import { resetRateLimitBuckets } from '../../../src/server/rate-limit.js';

function buildTestDb() {
  const db = createSqliteClient(':memory:');
  runAllMigrations(db);
  return db;
}

const TEST_SPACE = 'space-branch-test';

beforeEach(() => {
  resetRateLimitBuckets();
});

describe('branch isolation', () => {
  it('claim on feature/alice does NOT block claim on main for same path', () => {
    const db = buildTestDb();
    const store = new SqliteEventStore(db);
    const tools = createTeamemTools({ db, store });

    const alice = tools.claimScope({
      space_id: TEST_SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      scope: { paths: ['src/Form.tsx'] },
      repo_id: 'github.com/org/repo',
      branch: 'feature/alice',
      auto_release_mode: 'on_commit'
    });
    expect(alice.ok).toBe(true);

    const bob = tools.claimScope({
      space_id: TEST_SPACE,
      principal: 'bob',
      actor: 'bob',
      delegation: 'bob->bob',
      scope: { paths: ['src/Form.tsx'] },
      repo_id: 'github.com/org/repo',
      branch: 'main',
      auto_release_mode: 'on_commit'
    });
    expect(bob.ok).toBe(true);
  });

  it('claim on feature/alice DOES block claim on feature/alice for same path', () => {
    const db = buildTestDb();
    const store = new SqliteEventStore(db);
    const tools = createTeamemTools({ db, store });

    const alice = tools.claimScope({
      space_id: TEST_SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      scope: { paths: ['src/Form.tsx'] },
      repo_id: 'github.com/org/repo',
      branch: 'feature/alice',
      auto_release_mode: 'on_commit'
    });
    expect(alice.ok).toBe(true);

    const bob = tools.claimScope({
      space_id: TEST_SPACE,
      principal: 'bob',
      actor: 'bob',
      delegation: 'bob->bob',
      scope: { paths: ['src/Form.tsx'] },
      repo_id: 'github.com/org/repo',
      branch: 'feature/alice',
      auto_release_mode: 'on_commit'
    });
    expect(bob.ok).toBe(false);
    if (!bob.ok) {
      expect(bob.error.code).toBe('scope_conflict');
    }
  });
});

describe('validation', () => {
  it('explicit empty repo_id returns INVALID_PAYLOAD error', () => {
    const db = buildTestDb();
    const store = new SqliteEventStore(db);
    const tools = createTeamemTools({ db, store });

    const result = tools.claimScope({
      space_id: TEST_SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      scope: { paths: ['src/foo.ts'] },
      repo_id: '',
      branch: 'main',
      auto_release_mode: 'on_commit'
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_PAYLOAD');
    }
  });

  it('explicit empty branch returns INVALID_PAYLOAD error', () => {
    const db = buildTestDb();
    const store = new SqliteEventStore(db);
    const tools = createTeamemTools({ db, store });

    const result = tools.claimScope({
      space_id: TEST_SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      scope: { paths: ['src/foo.ts'] },
      repo_id: 'github.com/org/repo',
      branch: '',
      auto_release_mode: 'on_commit'
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_PAYLOAD');
    }
  });

  it('invalid auto_release_mode returns INVALID_PAYLOAD error', () => {
    const db = buildTestDb();
    const store = new SqliteEventStore(db);
    const tools = createTeamemTools({ db, store });

    const result = tools.claimScope({
      space_id: TEST_SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      scope: { paths: ['src/foo.ts'] },
      repo_id: 'github.com/org/repo',
      branch: 'main',
      auto_release_mode: 'invalid_mode' as 'on_commit'
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_PAYLOAD');
    }
  });
});

describe('last_edit_at', () => {
  it('is set on fresh claim', () => {
    const db = buildTestDb();
    const store = new SqliteEventStore(db);
    const tools = createTeamemTools({ db, store });

    const before = new Date().toISOString();
    const result = tools.claimScope({
      space_id: TEST_SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      scope: { paths: ['src/Widget.tsx'] },
      repo_id: 'github.com/org/repo',
      branch: 'main',
      auto_release_mode: 'on_commit'
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const row = db
      .query('SELECT last_edit_at FROM claims WHERE claim_id = ?1')
      .get(result.data.claim_id) as { last_edit_at: string | null } | null;
    expect(row).not.toBeNull();
    expect(row!.last_edit_at).toBeTruthy();
    expect(row!.last_edit_at! >= before).toBe(true);
  });

  it('legacy callers without new fields still work', () => {
    const db = buildTestDb();
    const store = new SqliteEventStore(db);
    const tools = createTeamemTools({ db, store });

    const result = tools.claimScope({
      space_id: TEST_SPACE,
      principal: 'alice',
      actor: 'alice',
      delegation: 'alice->alice',
      scope: { paths: ['src/legacy.ts'] }
    });
    expect(result.ok).toBe(true);
  });
});
