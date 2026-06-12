import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';

export function createSqliteClient(path = ':memory:'): Database {
  const db = new Database(path);
  // WAL keeps readers unblocked during writes and makes the shutdown
  // `PRAGMA wal_checkpoint(TRUNCATE)` in src/server/index.ts meaningful —
  // Bun does not enable WAL by default. On `:memory:` databases SQLite
  // ignores the request (journal_mode stays `memory`), so this is safe for
  // the in-memory test surface.
  db.exec('PRAGMA journal_mode = WAL');
  // Back off instead of throwing SQLITE_BUSY when another connection holds
  // the write lock (e.g. CLI tooling pointed at the same file).
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

export function runMigration(db: Database, migrationPath: string): void {
  const sql = readFileSync(migrationPath, 'utf-8');
  db.exec(sql);
}
