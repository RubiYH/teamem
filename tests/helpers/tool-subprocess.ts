import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSqliteClient } from '../../src/infra/db/sqlite-client.js';
import { SqliteEventStore } from '../../src/infra/db/sqlite-event-store.js';
import { createTeamemTools } from '../../src/server/tools/index.js';

export type SubprocessToolName = 'claim' | 'release';

const SUBPROCESS_USAGE =
  'usage: tool-subprocess.ts <claim|release> <dbPath> <json>';

export function createTempDbFile(prefix: string): {
  dbPath: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  return {
    dbPath: join(dir, 'teamem.sqlite'),
    cleanup: () => rmSync(dir, { recursive: true, force: true })
  };
}

export async function runToolSubprocess(
  tool: SubprocessToolName,
  dbPath: string,
  input: Record<string, unknown>
): Promise<{ status: number; body: unknown }> {
  const proc = Bun.spawn(
    [
      process.execPath,
      new URL(import.meta.url).pathname,
      tool,
      dbPath,
      JSON.stringify(input)
    ],
    {
      stdout: 'pipe',
      stderr: 'pipe'
    }
  );

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ]);

  if (exitCode !== 0) {
    throw new Error(
      stderr.trim() || `Subprocess ${tool} failed with exit code ${exitCode}`
    );
  }

  return JSON.parse(stdout) as { status: number; body: unknown };
}

function resultErrorCode(result: unknown): unknown {
  if (typeof result !== 'object' || result === null || !('error' in result)) {
    return null;
  }
  const error = (result as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return null;
  }
  return (error as { code?: unknown }).code ?? null;
}

function toHttpLikeStatus(result: unknown): number {
  if (
    typeof result === 'object' &&
    result !== null &&
    'ok' in result &&
    (result as { ok: boolean }).ok === true
  ) {
    return 200;
  }
  return resultErrorCode(result) === 'scope_conflict' ? 409 : 400;
}

function runToolInProcess(
  tool: SubprocessToolName,
  dbPath: string,
  input: Record<string, unknown>
): unknown {
  const db = createSqliteClient(dbPath);
  db.exec('PRAGMA busy_timeout = 5000');
  const store = new SqliteEventStore(db);
  const tools = createTeamemTools({ db, store });

  switch (tool) {
    case 'claim':
      return tools.claimScope(input as Parameters<typeof tools.claimScope>[0]);
    case 'release':
      return tools.releaseScope(
        input as Parameters<typeof tools.releaseScope>[0]
      );
  }
}

if (import.meta.main) {
  const [, , tool, dbPath, inputJson] = process.argv;
  if (
    (tool !== 'claim' && tool !== 'release') ||
    !dbPath ||
    typeof inputJson !== 'string'
  ) {
    console.error(SUBPROCESS_USAGE);
    process.exit(2);
  }

  const input = JSON.parse(inputJson) as Record<string, unknown>;
  const result = runToolInProcess(tool, dbPath, input);

  process.stdout.write(
    JSON.stringify({
      status: toHttpLikeStatus(result),
      body: result
    })
  );
}
