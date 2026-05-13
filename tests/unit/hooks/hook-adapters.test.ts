import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';
import {
  createSqliteClient,
  runMigration
} from '../../../src/infra/db/sqlite-client.js';
import { SqliteEventStore } from '../../../src/infra/db/sqlite-event-store.js';
import { createTeamemTools } from '../../../src/server/tools/index.js';
import { createClaudeHookAdapter } from '../../../src/hooks/claude.js';
import { DeferredQueue } from '../../../src/hooks/core.js';

function setup() {
  const db = createSqliteClient(':memory:');
  runMigration(db, join(process.cwd(), 'src/infra/db/migrations/001_init.sql'));
  runMigration(
    db,
    join(
      process.cwd(),
      'src/infra/db/migrations/002_decisions_kind_and_indexes.sql'
    )
  );
  runMigration(
    db,
    join(
      process.cwd(),
      'src/infra/db/migrations/003_room_codes_and_members.sql'
    )
  );
  const store = new SqliteEventStore(db);
  const tools = createTeamemTools({ db, store });
  return { tools };
}

const ctx = {
  space_id: 'teamem-poc',
  principal: 'alice',
  actor: 'claude/session-1',
  delegation: 'alice->claude'
} as const;

describe('hook adapters', () => {
  it('supports Claude lifecycle calls', () => {
    const { tools } = setup();
    const adapter = createClaudeHookAdapter(tools);

    const start = adapter.onSessionStart(ctx);
    expect(start.ok).toBe(true);
  });

  it('queues failed publish payloads for deferred retry', () => {
    const { tools } = setup();
    const queue = new DeferredQueue();
    const adapter = createClaudeHookAdapter(tools, queue);

    const ok = adapter.onPostAction(ctx, { broken: true });
    expect(ok).toBe(false);
    expect(queue.size()).toBe(1);
  });
});
