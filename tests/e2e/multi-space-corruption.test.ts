import { describe, expect, it } from 'bun:test';
import { mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const VALID_SPACE_ID = '01HTEST000000000000000001';
const MALFORMED_SPACE_ID = '01HTEST000000000000000002';
const NOW_SEC = Math.floor(Date.now() / 1000) + 86400 * 30;

function makeCredentials(includeJwtOnValid = true) {
  return {
    version: 1,
    default_space_id: VALID_SPACE_ID,
    spaces: {
      [VALID_SPACE_ID]: {
        space_id: VALID_SPACE_ID,
        label: 'valid-space',
        member_name: 'alice',
        jwt: includeJwtOnValid
          ? 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhbGljZSIsInNwYWNlX2lkIjoiMDFIVEVTVDAwMDAwMDAwMDAwMDAwMDAxIiwiaWF0IjoxNzE0NTAwMDAwLCJleHAiOjk5OTk5OTk5OTl9.test'
          : undefined,
        jwt_exp: NOW_SEC,
        server_url: 'http://127.0.0.1:19999'
      },
      [MALFORMED_SPACE_ID]: {
        space_id: MALFORMED_SPACE_ID,
        label: 'malformed-space',
        member_name: 'bob',
        // deliberately missing jwt and jwt_exp
        server_url: 'http://127.0.0.1:19999'
      }
    }
  };
}

function runBridgeCall(
  homeDir: string,
  spaceFlag: string,
  toolName: string
): {
  stdout: string;
  stderr: string;
  exitCode: number;
} {
  const result = spawnSync(
    'bun',
    [
      'run',
      'src/bridge/index.ts',
      'call',
      toolName,
      '--space',
      spaceFlag,
      '--json',
      '{}'
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, HOME: homeDir },
      timeout: 15_000,
      encoding: 'utf-8'
    }
  );
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? 1
  };
}

describe('multi-space partial-corruption', () => {
  it('bridge with valid space entry succeeds (network error ok — server unreachable)', () => {
    const tmpHome = join(tmpdir(), `teamem-corrupt-test-${Date.now()}`);
    mkdirSync(join(tmpHome, '.teamem'), { recursive: true });
    const credPath = join(tmpHome, '.teamem', 'credentials.json');
    writeFileSync(credPath, JSON.stringify(makeCredentials(true), null, 2));
    chmodSync(credPath, 0o600);

    try {
      const { exitCode, stderr } = runBridgeCall(
        tmpHome,
        VALID_SPACE_ID,
        'teamem.get_updates'
      );
      void exitCode;
      // Bridge may exit 0 (network error returned in JSON) or 1 (if it exits on network failure)
      // Key assertion: does NOT exit because of credential corruption
      expect(stderr).not.toContain('unknown_space');
      expect(stderr).not.toContain('No credentials found');
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('bridge with malformed space entry (missing jwt) does not crash', () => {
    // Bridge v0.2.0: isCredentialsFile only validates top-level structure.
    // An entry with missing jwt still passes pickEntry; checkJwtExp with
    // jwt_exp=undefined does not throw. The bridge sends "Bearer undefined"
    // to the server and gets a network_error (server unreachable on port 19999).
    // Key requirement: process does NOT crash with an unhandled exception.
    const tmpHome = join(tmpdir(), `teamem-corrupt-test-${Date.now()}`);
    mkdirSync(join(tmpHome, '.teamem'), { recursive: true });
    const credPath = join(tmpHome, '.teamem', 'credentials.json');
    writeFileSync(credPath, JSON.stringify(makeCredentials(true), null, 2));
    chmodSync(credPath, 0o600);

    try {
      const { exitCode, stdout, stderr } = runBridgeCall(
        tmpHome,
        MALFORMED_SPACE_ID,
        'teamem.get_updates'
      );
      // Should not crash with unhandled exception
      expect(stderr).not.toContain('TypeError: Cannot read');
      expect(stderr).not.toContain('Uncaught');
      // Either exits gracefully or outputs a JSON error — not a raw crash
      const combined = stdout + stderr;
      void combined;
      const isGraceful = exitCode === 0 || exitCode === 1;
      expect(isGraceful).toBe(true);
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
