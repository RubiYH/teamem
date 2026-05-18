import { Pool } from 'pg';
import { loadTeamemCloudWebEnv } from '../../../src/cloud/env-contract.js';

const REQUIRED_TABLES = [
  'cloud_accounts',
  'cloud_spaces',
  'cloud_audit_events'
] as const;

const DEFAULT_BETTER_AUTH_TABLES = [
  'user',
  'session',
  'account',
  'verification'
] as const;

const BETTER_AUTH_TABLES_ENV = 'TEAMEM_CLOUD_BETTER_AUTH_TABLES';

export async function runTeamemCloudDeploySmoke(
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const envResult = loadTeamemCloudWebEnv(env);
  if (!envResult.ok) {
    throw new Error(
      `Teamem Cloud deploy smoke failed: missing required env ${envResult.missing.join(', ')}`
    );
  }

  const pool = new Pool({
    connectionString: envResult.value.supabase.postgresUrl
  });

  try {
    await pool.query('SELECT 1 AS ok');
    const betterAuthTables = parseBetterAuthTables(env[BETTER_AUTH_TABLES_ENV]);
    const expectedTables = [...REQUIRED_TABLES, ...betterAuthTables];
    const tableResult = await pool.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_type = 'BASE TABLE'
          AND table_name = ANY($1::text[])`,
      [expectedTables]
    );
    const existingTables = new Set(
      tableResult.rows.map((row) => row.table_name)
    );
    const missingTables = expectedTables.filter(
      (table) => !existingTables.has(table)
    );

    if (missingTables.length > 0) {
      throw new Error(
        `Teamem Cloud deploy smoke failed: missing database tables ${missingTables.join(', ')}. Run the Better Auth migration and apps/web/db/migrations/001_control_plane.sql.`
      );
    }
  } finally {
    await pool.end();
  }

  console.log('Teamem Cloud deploy smoke passed');
  console.log('- required web env is present');
  console.log('- server-side Supabase/Postgres connection succeeded');
  console.log('- Better Auth and control-plane tables are present');
}

if (import.meta.main) {
  try {
    await runTeamemCloudDeploySmoke();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

function parseBetterAuthTables(value: string | undefined): readonly string[] {
  const tables = value
    ?.split(',')
    .map((table) => table.trim())
    .filter(Boolean);

  return tables?.length ? tables : DEFAULT_BETTER_AUTH_TABLES;
}
