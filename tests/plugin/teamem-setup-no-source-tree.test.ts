/**
 * Codex F7 regression — `plugin/lib/setup.js` must run without a source
 * tree. The `/teamem-setup` slash command spawns the bundled setup CLI via
 * `bun run "${CLAUDE_PLUGIN_ROOT}/lib/setup.js"`. A marketplace install has
 * no source path; the bundle must be self-contained.
 *
 * This test runs the bundle in non-interactive `--json` mode against an
 * in-process server, with NO `TEAMEM_ROOT` / `CLAUDE_PLUGIN_OPTION_TEAMEM_ROOT`
 * env vars, asserts exit 0 and credentials written. It also asserts the
 * committed bundle exists and is non-trivial.
 */
import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const REPO_ROOT = resolve(import.meta.dir, '../..');
const SETUP_BUNDLE = join(REPO_ROOT, 'plugin/lib/setup.js');

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'teamem-setup-bundle-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('bundled setup CLI works without source-tree config (Codex F7)', () => {
  it('plugin/lib/setup.js exists and is non-trivial', () => {
    expect(existsSync(SETUP_BUNDLE)).toBe(true);
    expect(statSync(SETUP_BUNDLE).size).toBeGreaterThan(10_000);
  });

  it('bundled setup --json create flow exits 0 and writes credentials', async () => {
    const credPath = join(tmpDir, 'credentials.json');
    const preloadPath = join(tmpDir, 'mock-fetch.ts');
    const payload = Buffer.from(
      JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })
    ).toString('base64url');
    await writeFile(
      preloadPath,
      `globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (url.endsWith('/spaces') && init?.method === 'POST') {
    return new Response(JSON.stringify({
      space_id: 'space-bundled-setup',
      label: 'bundled-setup',
      room_code: 'ROOM1234',
      jwt: 'header.${payload}.sig'
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
};
`
    );
    const jsonArgs = {
      serverUrl: 'http://teamem.test',
      flow: 'create',
      memberName: 'alice',
      spaceLabel: 'bundled-setup',
      credPath
    };

    const env: Record<string, string | undefined> = { ...process.env };
    delete env.TEAMEM_BRIDGE_DIR;
    delete env.CLAUDE_PLUGIN_OPTION_TEAMEM_ROOT;
    delete env.TEAMEM_ROOT;

    const child = spawn(
      'bun',
      [
        '--preload',
        preloadPath,
        SETUP_BUNDLE,
        '--json',
        JSON.stringify(jsonArgs)
      ],
      {
        env,
        stdio: ['ignore', 'pipe', 'pipe']
      }
    );

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));

    const code = await new Promise<number>((resolveFn) => {
      child.on('close', (c) => resolveFn(c ?? -1));
    });

    expect(stderr).not.toContain('hook-install');
    expect(stderr).not.toContain('CLAUDE_PLUGIN_OPTION_TEAMEM_ROOT');
    expect(code).toBe(0);
    expect(stdout).toContain('Space created');

    const written = await readFile(credPath, 'utf-8');
    const parsed = JSON.parse(written) as { spaces: Record<string, unknown> };
    expect(Object.keys(parsed.spaces).length).toBeGreaterThan(0);
  }, 30_000);
});
