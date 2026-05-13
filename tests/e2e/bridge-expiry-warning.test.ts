/**
 * E2E: PM2 v1 — bridge prints stderr warning when JWT exp - now < 7 days.
 *
 * Plan §2 req 10 + §5 Phase 4 task 4: bridge startup inspects the active
 * credential entry and warns once on stderr if expiry is within 7 days.
 *
 * The warning text MUST:
 *   1. Include the space label.
 *   2. Tell the user to re-run `bun run setup` to refresh.
 *
 * The warning MUST NOT print:
 *   - When `exp - now() >= 7 days`.
 *   - When the entry is already expired (handled by SessionExpiredError).
 *
 * Implementation under test: `emitStartupLogs(entry)` from
 * `src/bridge/index.ts`. We capture stderr writes inline, exercise the
 * function with crafted credential entries, and assert the contract.
 */
import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { emitStartupLogs } from '../../src/bridge/index.js';
import type { CredentialEntry } from '../../src/bridge/credentials.js';

const SECONDS_PER_DAY = 86_400;

let stderrWrites: string[];
let originalWrite: typeof process.stderr.write;

beforeEach(() => {
  stderrWrites = [];
  originalWrite = process.stderr.write.bind(process.stderr);
  (process.stderr as { write: unknown }).write = (msg: string) => {
    stderrWrites.push(msg);
    return true;
  };
});

afterEach(() => {
  (process.stderr as { write: unknown }).write = originalWrite;
});

function makeEntry(secondsUntilExp: number): CredentialEntry {
  return {
    space_id: '01HTEST000000000000000001',
    label: 'demo-space',
    member_name: 'alice',
    jwt: 'header.payload.sig',
    jwt_exp: Math.floor(Date.now() / 1000) + secondsUntilExp,
    server_url: 'http://localhost:3000'
  };
}

describe('bridge JWT-expiry warning (PM2 v1)', () => {
  it('always logs the active space on startup', () => {
    emitStartupLogs(makeEntry(SECONDS_PER_DAY * 30));
    const joined = stderrWrites.join('');
    expect(joined).toContain(
      '[teamem] using space 01HTEST000000000000000001 (demo-space)'
    );
  });

  it('does NOT warn when exp - now() >= 7 days', () => {
    emitStartupLogs(makeEntry(SECONDS_PER_DAY * 30));
    const joined = stderrWrites.join('');
    expect(joined).not.toContain('WARNING');
    expect(joined).not.toContain('expires in');
  });

  it('does NOT warn at exactly 7 days remaining (boundary, exclusive)', () => {
    emitStartupLogs(makeEntry(SECONDS_PER_DAY * 7));
    const joined = stderrWrites.join('');
    expect(joined).not.toContain('WARNING');
  });

  it('warns when exp - now() < 7 days (e.g., 3 days)', () => {
    emitStartupLogs(makeEntry(SECONDS_PER_DAY * 3));
    const joined = stderrWrites.join('');
    expect(joined).toContain('[teamem] WARNING:');
    expect(joined).toContain('JWT for space "demo-space" expires in 3 days');
    expect(joined).toContain("Re-run 'bun run setup'");
  });

  it('warns at 1 day remaining with singular "day"', () => {
    // 23h59m to ensure ceil → 1 (still < 1 full day, > 0 seconds)
    emitStartupLogs(makeEntry(SECONDS_PER_DAY - 60));
    const joined = stderrWrites.join('');
    expect(joined).toContain('expires in 1 day.');
  });

  it('warning is written to stderr only (not stdout)', () => {
    let stdoutWritten = '';
    const origStdoutWrite = process.stdout.write.bind(process.stdout);
    (process.stdout as { write: unknown }).write = (msg: string) => {
      stdoutWritten += msg;
      return true;
    };
    try {
      emitStartupLogs(makeEntry(SECONDS_PER_DAY * 2));
    } finally {
      (process.stdout as { write: unknown }).write = origStdoutWrite;
    }
    expect(stdoutWritten).toBe('');
    expect(stderrWrites.join('')).toContain('WARNING');
  });

  it('does NOT warn for already-expired entries (negative remaining)', () => {
    // emitStartupLogs guards on secondsUntilExp > 0; expired entries are
    // surfaced separately via checkJwtExp → SessionExpiredError before this
    // function runs, so the warning path must not fire for negative deltas.
    emitStartupLogs(makeEntry(-3600));
    const joined = stderrWrites.join('');
    expect(joined).not.toContain('WARNING');
  });

  it('warning text includes the re-join instruction', () => {
    emitStartupLogs(makeEntry(SECONDS_PER_DAY * 5));
    const joined = stderrWrites.join('');
    expect(joined).toMatch(/re-join this space to refresh/);
  });
});
