import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';

export function createSqliteClient(path = ':memory:'): Database {
  return new Database(path);
}

export function runMigration(db: Database, migrationPath: string): void {
  const sql = readFileSync(migrationPath, 'utf-8');
  db.exec(sql);
}
