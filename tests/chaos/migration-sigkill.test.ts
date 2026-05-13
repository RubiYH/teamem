import { join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'bun:test';
import {
  createSqliteClient,
  runMigration
} from '../../src/infra/db/sqlite-client.js';

const MIGRATIONS_DIR = join(process.cwd(), 'src/infra/db/migrations');

function columnNames(
  db: ReturnType<typeof createSqliteClient>,
  table: string
): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
  }[];
  return rows.map((r) => r.name);
}

describe('chaos: SIGKILL during migration 003', () => {
  it('DB is in clean pre- or post-migration state after SIGKILL (no half-migration)', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'teamem-chaos-'));
    const dbPath = join(tmpDir, 'test.db');

    // Build v5 DB on disk
    const setupDb = createSqliteClient(dbPath);
    runMigration(setupDb, join(MIGRATIONS_DIR, '001_init.sql'));
    runMigration(
      setupDb,
      join(MIGRATIONS_DIR, '002_decisions_kind_and_indexes.sql')
    );
    setupDb.close();

    // Write a child script that opens the DB and runs 003, then sleeps forever
    const childScript = join(tmpDir, 'migrate-child.ts');
    writeFileSync(
      childScript,
      `
import { createSqliteClient, runMigration } from ${JSON.stringify(join(process.cwd(), 'src/infra/db/sqlite-client.js'))};
import { join } from 'node:path';
const db = createSqliteClient(${JSON.stringify(dbPath)});
runMigration(db, ${JSON.stringify(join(MIGRATIONS_DIR, '003_room_codes_and_members.sql'))});
// Signal parent we started migration
process.stdout.write('started\\n');
// Sleep indefinitely so parent can kill us
await new Promise(() => {});
`
    );

    const proc = Bun.spawn(['bun', 'run', childScript], {
      stdout: 'pipe',
      stderr: 'pipe'
    });

    // Wait briefly then SIGKILL
    await new Promise((r) => setTimeout(r, 150));
    proc.kill(9); // SIGKILL
    await proc.exited;

    // Reopen DB and verify it is in a consistent state
    const verifyDb = createSqliteClient(dbPath);

    const evtCols = columnNames(verifyDb, 'events');

    // DB must be in either pre-migration (repo_id) or post-migration (space_id) state
    const hasBefore = evtCols.includes('repo_id');
    const hasAfter = evtCols.includes('space_id');

    // Exactly one of the two must be true — no column means the ALTER was partial (corrupt)
    expect(hasBefore || hasAfter).toBe(true);
    // Both cannot be true simultaneously (would mean partial rename)
    expect(hasBefore && hasAfter).toBe(false);

    verifyDb.close();

    // Cleanup
    try {
      rmSync(tmpDir, { recursive: true });
    } catch {
      /* ignore */
    }
  }, 15000);
});
