import type { Database } from 'bun:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Run every `*.sql` file under `src/infra/db/migrations/` against the given
 * database, in lexicographic order — matching the production migration
 * runner in `src/server/index.ts`.
 *
 * Tests that hand-rolled their own migration list became fragile when each
 * new migration shipped: they had to be edited in lockstep with every PR,
 * or the integration suite broke against new columns. Use this helper
 * instead — it stays current automatically.
 */
export function runAllMigrations(db: Database): void {
  const migDir = join(process.cwd(), 'src/infra/db/migrations');
  const files = readdirSync(migDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const f of files) {
    const sql = readFileSync(join(migDir, f), 'utf-8');
    db.exec(sql);
  }
}
