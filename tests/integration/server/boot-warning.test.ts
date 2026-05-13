/**
 * AC14 — Boot guard: spawning the server without TEAMEM_JWT_SECRET aborts
 * startup with a clear error message. (Reframed during v1.5.1 review: the
 * original DEV-ONLY warning was misleading because requireJwtSecret throws
 * before the dev-mode branch is reachable from production startup. The
 * dev-mode auth bypass is reachable only via direct createRouter() use in
 * tests, never via createServer().)
 */
import { describe, it, expect } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function runServer(
  env: Record<string, string>,
  timeoutMs = 3000
): Promise<{ stderr: string; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn('bun', ['run', 'src/server/index.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...env
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });

    // Kill after timeout — we only need the startup output
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
    }, timeoutMs);

    child.on('exit', () => {
      clearTimeout(timer);
      resolve({ stderr, stdout });
    });

    child.on('error', () => {
      clearTimeout(timer);
      resolve({ stderr, stdout });
    });
  });
}

describe('AC14 — boot guard when TEAMEM_JWT_SECRET is absent', () => {
  it('server aborts startup with a clear error when no JWT secret is set', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'teamem-boot-guard-'));
    try {
      const { stderr } = await runServer({
        TEAMEM_DB_PATH: ':memory:',
        TEAMEM_MIGRATIONS_DIR: join(process.cwd(), 'src/infra/db/migrations'),
        PORT: '0',
        // Explicitly unset JWT secret
        TEAMEM_JWT_SECRET: ''
      });

      expect(stderr).toContain('TEAMEM_JWT_SECRET must be set');
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('server rejects the documented example JWT secret placeholder', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'teamem-boot-placeholder-'));
    try {
      const { stderr } = await runServer({
        TEAMEM_DB_PATH: ':memory:',
        TEAMEM_MIGRATIONS_DIR: join(process.cwd(), 'src/infra/db/migrations'),
        PORT: '0',
        TEAMEM_JWT_SECRET: 'replace-with-openssl-rand-hex-32'
      });

      expect(stderr).toContain('TEAMEM_JWT_SECRET must be set');
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('server starts cleanly when JWT secret is set', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'teamem-boot-ok-'));
    try {
      const { stderr } = await runServer({
        TEAMEM_DB_PATH: ':memory:',
        TEAMEM_MIGRATIONS_DIR: join(process.cwd(), 'src/infra/db/migrations'),
        PORT: '0',
        TEAMEM_JWT_SECRET: 'a-valid-secret-that-is-32-chars-xx'
      });

      expect(stderr).not.toContain('TEAMEM_JWT_SECRET must be set');
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
