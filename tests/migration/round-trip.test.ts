import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import Database from 'bun:sqlite';
import {
  createSqliteClient,
  runMigration
} from '../../src/infra/db/sqlite-client.js';

const MIGRATIONS_DIR = join(process.cwd(), 'src/infra/db/migrations');

function applyV5Schema(db: ReturnType<typeof createSqliteClient>) {
  runMigration(db, join(MIGRATIONS_DIR, '001_init.sql'));
  runMigration(db, join(MIGRATIONS_DIR, '002_decisions_kind_and_indexes.sql'));
}

describe('Migration round-trip (003 forward + backup/restore)', () => {
  it('applies 003 migration forward: events.space_id exists, spaces/members/room_codes tables created', () => {
    const db = createSqliteClient(':memory:');
    applyV5Schema(db);

    // Verify pre-migration: events has repo_id (or no space_id yet — 003 renamed it)
    // Actually after 001/002 only, events has repo_id
    const colsBefore = (
      db.query(`PRAGMA table_info(events)`).all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(colsBefore).toContain('repo_id');
    expect(colsBefore).not.toContain('space_id');

    // Apply 003
    runMigration(db, join(MIGRATIONS_DIR, '003_room_codes_and_members.sql'));

    // Post-migration: events.space_id, new tables
    const colsAfter = (
      db.query(`PRAGMA table_info(events)`).all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(colsAfter).toContain('space_id');
    expect(colsAfter).not.toContain('repo_id');

    const tables = (
      db
        .query(`SELECT name FROM sqlite_master WHERE type='table'`)
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(tables).toContain('spaces');
    expect(tables).toContain('members');
    expect(tables).toContain('room_codes');
  });

  it('backup + restore returns DB to pre-003 state (v5 schema intact)', () => {
    const tmpDir = join(tmpdir(), `teamem-migration-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });

    const dbPath = join(tmpDir, 'teamem.db');
    const backupPath = join(tmpDir, 'teamem-backup.db');

    try {
      // Build v5 DB on disk
      const db = new Database(dbPath);
      runMigration(
        db as unknown as ReturnType<typeof createSqliteClient>,
        join(MIGRATIONS_DIR, '001_init.sql')
      );
      runMigration(
        db as unknown as ReturnType<typeof createSqliteClient>,
        join(MIGRATIONS_DIR, '002_decisions_kind_and_indexes.sql')
      );
      db.close();

      // Backup before migration (file copy — documented procedure)
      copyFileSync(dbPath, backupPath);

      // Apply 003 to original
      const db2 = new Database(dbPath);
      runMigration(
        db2 as unknown as ReturnType<typeof createSqliteClient>,
        join(MIGRATIONS_DIR, '003_room_codes_and_members.sql')
      );
      db2.close();

      // Restore from backup (per migrate-v1-to-v2.md procedure)
      copyFileSync(backupPath, dbPath);

      // Verify restored DB is back to v5 schema
      const restored = new Database(dbPath);
      const cols = (
        restored.query(`PRAGMA table_info(events)`).all() as Array<{
          name: string;
        }>
      ).map((r) => r.name);
      expect(cols).toContain('repo_id');
      expect(cols).not.toContain('space_id');

      const tables = (
        restored
          .query(`SELECT name FROM sqlite_master WHERE type='table'`)
          .all() as Array<{ name: string }>
      ).map((r) => r.name);
      expect(tables).not.toContain('spaces');
      expect(tables).not.toContain('members');
      expect(tables).not.toContain('room_codes');
      restored.close();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('003 migration leaves space_id in events after first apply', () => {
    // Note: runMigration is a raw db.exec() with no tracking table.
    // Double-applying 003 throws (RENAME COLUMN repo_id fails: column no longer exists).
    // The idempotency guard is at the server startup level (checks applied migrations).
    // This test verifies the schema is correct after a single forward migration.
    const db = createSqliteClient(':memory:');
    applyV5Schema(db);
    runMigration(db, join(MIGRATIONS_DIR, '003_room_codes_and_members.sql'));

    const cols = (
      db.query(`PRAGMA table_info(events)`).all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(cols).toContain('space_id');
    expect(cols).not.toContain('repo_id');
  });

  it('021 migration rewrites legacy ask-claimant coord prefs to auto-skip', () => {
    const db = createSqliteClient(':memory:');
    applyV5Schema(db);
    runMigration(db, join(MIGRATIONS_DIR, '003_room_codes_and_members.sql'));
    runMigration(db, join(MIGRATIONS_DIR, '011_member_coord_pref.sql'));

    db.exec(`
      INSERT INTO spaces (id, label, creator_member_id, created_at)
        VALUES ('space-021', 'migration test', 'm-alice', '2026-05-10T00:00:00.000Z');
      INSERT INTO members (id, space_id, name, joined_at, is_creator, coord_pref)
        VALUES ('m-alice', 'space-021', 'alice', '2026-05-10T00:00:00.000Z', 1, 'ask-claimant');
    `);

    runMigration(
      db,
      join(MIGRATIONS_DIR, '021_remove_ask_claimant_coord_pref.sql')
    );
    runMigration(
      db,
      join(MIGRATIONS_DIR, '021_remove_ask_claimant_coord_pref.sql')
    );

    const row = db
      .query(
        "SELECT coord_pref FROM members WHERE space_id = 'space-021' AND name = 'alice'"
      )
      .get() as { coord_pref: string };
    expect(row.coord_pref).toBe('auto-skip');
  });
});
