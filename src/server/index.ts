import { Hono } from 'hono';
import { join } from 'node:path';
import { readdirSync, readFileSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { createSqliteClient } from '../infra/db/sqlite-client.js';
import { SqliteEventStore } from '../infra/db/sqlite-event-store.js';
import { createTeamemTools } from './tools/index.js';
import { createRouter } from './routes.js';
import { requireJwtSecret } from './jwt.js';
import { resolveCloudAdminProvisioningToken } from './cloud-admin-token.js';
import { createRequireMemberMiddleware } from './auth.js';
import { gcDisbandedSpaces } from './spaces.js';
import { gcExpiredPendingEdits } from '../domain/conflicts/pending-edits.js';

function ensureMigrationsTable(db: Database): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS _migrations (
      filename TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`
  );
}

function runMigrations(db: Database, migrationsDir: string): void {
  ensureMigrationsTable(db);
  const applied = new Set<string>(
    (
      db.prepare('SELECT filename FROM _migrations').all() as {
        filename: string;
      }[]
    ).map((r) => r.filename)
  );

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    let sql = readFileSync(join(migrationsDir, file), 'utf-8');
    // Strip the migration's own outer BEGIN/COMMIT — we wrap the entire
    // (sql + ledger insert) in one outer transaction so they succeed or
    // fail together. Without this wrapper, a partial migration apply
    // followed by a failure leaves the ledger un-updated, and the next
    // startup re-runs the already-applied non-idempotent ALTERs and
    // bricks the DB with duplicate-column errors. SQLite forbids nested
    // transactions, so any inner BEGIN/COMMIT must be removed first.
    sql = sql.replace(/^\s*BEGIN(?:\s+TRANSACTION)?\s*;\s*/im, '');
    sql = sql.replace(/\s*COMMIT\s*;\s*$/im, '');
    // Guard: the strip above handles exactly one outer BEGIN/COMMIT pair. A
    // migration with multiple transaction blocks would leave an inner COMMIT
    // behind, committing the wrapper transaction early — the ledger insert
    // then runs outside it, recreating the partial-apply scenario the wrapper
    // exists to prevent. Requiring `;` after BEGIN keeps trigger bodies
    // (`... FOR EACH ROW BEGIN <stmts> END;`) from false-positiving.
    if (/^\s*(?:BEGIN(?:\s+TRANSACTION)?|COMMIT)\s*;/im.test(sql)) {
      throw new Error(
        `Migration ${file} contains more than one BEGIN/COMMIT pair. ` +
          'Migrations must be a single transaction (or none) — the runner ' +
          'wraps each file in its own transaction together with the ledger insert.'
      );
    }
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO _migrations (filename) VALUES (?1)').run(file);
    }).immediate();
  }
}

function getDbEventCount(db: Database): number {
  const row = db.prepare('SELECT COUNT(*) as n FROM events').get() as {
    n: number;
  } | null;
  return row?.n ?? 0;
}

export function createServer(
  env: Record<string, string | undefined> = process.env as Record<
    string,
    string | undefined
  >
) {
  const dbPath = env.TEAMEM_DB_PATH ?? './data/teamem.db';
  const port = Number(env.PORT ?? 3000);
  const migrationsDir =
    env.TEAMEM_MIGRATIONS_DIR ??
    join(import.meta.dir, '../infra/db/migrations');

  const db = createSqliteClient(dbPath);
  runMigrations(db, migrationsDir);

  // requireJwtSecret throws if TEAMEM_JWT_SECRET is missing or shorter than 32 chars.
  // The DEV-ONLY no-auth branch (TEAMEM_ALLOW_NO_AUTH=1) is reachable only via direct
  // createRouter() use in tests — it never fires in production startup, so no boot
  // warning is emitted here.
  const jwtSecret = requireJwtSecret(env);

  // Phase 0 startup assertion (plan §5 Phase 0 step 4): fail fast if the
  // claims table is missing columns required by the pre-claim TOCTOU gate
  // (F-NEW-4 predicate uses space_id/status/released_at/expires_at).
  {
    const cols = (
      db.query('PRAGMA table_info(claims)').all() as { name: string }[]
    ).map((c) => c.name);
    const required = [
      'claim_id',
      'space_id',
      'principal',
      'status',
      'released_at',
      'expires_at',
      'scope_json'
    ];
    const missing = required.filter((c) => !cols.includes(c));
    if (missing.length > 0) {
      throw new Error(
        `claims table is missing required columns for the conflict gate: [${missing.join(', ')}]. Run pending migrations.`
      );
    }
  }

  const store = new SqliteEventStore(db);
  const tools = createTeamemTools({ db, store });
  const trustedOrigins = env.TEAMEM_TRUSTED_ORIGINS?.split(',').filter(Boolean);
  const cloudAdminProvisioningToken = resolveCloudAdminProvisioningToken(env);
  const router = createRouter(tools, db, jwtSecret, trustedOrigins, {
    provisioningToken: cloudAdminProvisioningToken,
    runtimeServerUrl: env.TEAMEM_PUBLIC_URL ?? `http://localhost:${port}`
  });
  const requireMember = createRequireMemberMiddleware(jwtSecret, db);

  const app = new Hono();

  // Health endpoint — no auth required
  app.get('/health', (c) => {
    return c.json({
      ok: true,
      version: '0.2.0',
      db_events: getDbEventCount(db)
    });
  });

  // All /tools/* routes require JWT member auth
  app.use('/tools/*', requireMember);
  app.route('/', router);

  return { app, db, port };
}

// Entry point when run directly
if (import.meta.main) {
  const { app, db, port } = createServer();
  // Plumb the Bun.serve `server` into Hono's `c.env` so the rate-limit
  // middleware can resolve the peer IP via `server.requestIP(req)` instead
  // of trusting client-supplied `X-Forwarded-For` headers (security review
  // P1#2 — default off; flip on with TEAMEM_TRUST_PROXY=1 behind a proxy).
  const server = Bun.serve({
    port,
    fetch: (req, srv) => app.fetch(req, { server: srv })
  });
  console.log(`teamem-server listening on :${port}`);

  // Periodic GC sweep for soft-disbanded spaces past their grace window.
  // Runs every hour in production. Each sweep wraps each candidate's hard
  // cascade in `BEGIN IMMEDIATE` so a parallel `restoreSpace` cannot race
  // (Pre-mortem F4).
  const GC_INTERVAL_MS = Number(
    process.env.TEAMEM_DISBAND_GC_INTERVAL_MS ?? 60 * 60 * 1000
  );
  const gcInterval = setInterval(() => {
    try {
      const swept = gcDisbandedSpaces(db);
      if (swept.length > 0) {
        console.log(
          JSON.stringify({
            event: 'disband_gc_sweep',
            swept_count: swept.length,
            space_ids: swept
          })
        );
      }
    } catch (err) {
      console.error('disband_gc_sweep_error', (err as Error).message);
    }
  }, GC_INTERVAL_MS);
  if (typeof gcInterval.unref === 'function') gcInterval.unref();

  // Issue #10 — periodic GC sweep for expired, unresolved pending_edits.
  // Runs at the same hourly cadence as the disband sweep. Cleared rows
  // produce no peer event (CONTEXT.md "Cancel" lifecycle); this sweep
  // only deletes rows whose `expires_at` is in the past AND whose
  // `resolved_at IS NULL` — successful resolves are kept for audit.
  const PENDING_GC_INTERVAL_MS = Number(
    process.env.TEAMEM_PENDING_EDITS_GC_INTERVAL_MS ?? 60 * 60 * 1000
  );
  const pendingGcInterval = setInterval(() => {
    try {
      const swept = gcExpiredPendingEdits(db, new Date().toISOString());
      if (swept > 0) {
        console.log(
          JSON.stringify({
            event: 'pending_edits_gc_sweep',
            swept_count: swept
          })
        );
      }
    } catch (err) {
      console.error('pending_edits_gc_sweep_error', (err as Error).message);
    }
  }, PENDING_GC_INTERVAL_MS);
  if (typeof pendingGcInterval.unref === 'function') pendingGcInterval.unref();

  // Graceful shutdown: flush WAL and close SQLite before exit
  function shutdown() {
    console.log('teamem-server shutting down...');
    clearInterval(gcInterval);
    clearInterval(pendingGcInterval);
    server.stop(true);
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      /* ignore */
    }
    db.close();
    process.exit(0);
  }

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
