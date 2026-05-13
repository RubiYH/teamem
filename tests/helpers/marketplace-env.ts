/**
 * Codex F22 process change — sanitized environment for marketplace-shaped
 * end-to-end tests.
 *
 * Background: tests historically passed by injecting `TEAMEM_*` env vars
 * (e.g. `TEAMEM_MEMBER_NAME`) that production never sets. F18 surfaced the
 * worst case: the F15 regression test for `auto-discuss` "passed" because
 * it set `TEAMEM_MEMBER_NAME='alice'`, but the marketplace install never
 * exports that var → the resolver always picked `auto-skip` → Mode 6.C
 * was end-to-end dead in production despite the test going green.
 *
 * Going forward, marketplace-shaped tests MUST use `marketplaceEnv()` (or
 * the explicit `assertMarketplaceEnv()` smoke check) to construct their
 * subprocess env. The helper preserves only the four env vars a real
 * Claude Code marketplace install actually sets, plus the inherited ones
 * needed for the subprocess to function (PATH, HOME). Anything starting
 * with `TEAMEM_` is stripped — if you find yourself wanting to add one
 * back, that is a smell: production won't have it either.
 *
 * The four allowed plugin env vars:
 *   - CLAUDE_PLUGIN_ROOT             — set by the harness on every hook
 *   - CLAUDE_PLUGIN_DATA             — per-install scratch dir
 *   - CLAUDE_PLUGIN_OPTION_DEFAULT_SPACE — manifest default (label or id)
 *   - CLAUDE_SESSION_ID              — current session
 *
 * Tests can supplement with their own purpose-built env vars (e.g.
 * `TEAMEM_HOOK_DISABLE` for disable-only tests, `TEAMEM_MONITOR_POLL_MS`
 * for monitor pacing). Those are explicit per-test additions, not
 * inherited — `marketplaceEnv()` always strips first.
 *
 * **Codex F21 process note** — env sanitization is necessary but not
 * sufficient. Tests must ALSO avoid stubbing event types that no server
 * code emits. F21 caught the second-order failure: the F20 stub test
 * fed the monitor `event_type: 'dispute_move_posted'`, which the server
 * never produces (real moves emit `discussion_posted` with
 * `payload.dispute_move` set per slice #12). The stub passed; production
 * stalled after the first move.
 *
 * Rule of thumb: **dispatch tests must use real server emissions.** Open
 * a real dispute via `tools.openDispute`, post real moves via
 * `tools.disputePostMove`, then read the events back via
 * `tools.getUpdates`. If your test feeds synthetic events into the
 * monitor (or the watcher, or a routing layer), you are testing your
 * own assumption about server output, not server output. Pure-function
 * unit tests of the monitor's classifier are fine — the function under
 * test is the classifier itself, not its routing.
 */

import { describe } from 'bun:test';

const FORBIDDEN_PREFIXES = ['TEAMEM_'] as const;
// Whitelist these even though they share the prefix above — they are
// internal test plumbing, not "production-shaped" production behavior.
// The whitelist is intentionally tight; new entries should be argued.
const TEAMEM_ENV_WHITELIST = new Set<string>([
  'TEAMEM_HOOK_DISABLE', // Some hook-disable tests verify the early exit.
  'TEAMEM_MONITOR_POLL_MS' // Monitor pacing override (no production semantic).
]);

const ALLOWED_PLUGIN_ENV = [
  'CLAUDE_PLUGIN_ROOT',
  'CLAUDE_PLUGIN_DATA',
  'CLAUDE_PLUGIN_OPTION_DEFAULT_SPACE',
  'CLAUDE_SESSION_ID'
] as const;

/**
 * Returns a sanitized environment shaped like a Claude Code marketplace
 * install. Inherits PATH/HOME and `extra` overrides; strips every
 * `TEAMEM_*` env var not in the whitelist.
 */
export function marketplaceEnv(
  extra: Record<string, string | undefined> = {}
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL
  };

  for (const key of ALLOWED_PLUGIN_ENV) {
    const v = process.env[key];
    if (v !== undefined) env[key] = v;
  }

  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) {
      delete env[k];
    } else {
      env[k] = v;
    }
  }

  for (const k of Object.keys(env)) {
    const forbidden = FORBIDDEN_PREFIXES.some((p) => k.startsWith(p));
    if (forbidden && !TEAMEM_ENV_WHITELIST.has(k)) {
      delete env[k];
    }
  }

  return env;
}

/**
 * Asserts that a constructed env looks marketplace-shaped. Use in tests
 * that want a smoke check independent of the construction site (e.g. when
 * an env is built inline and you want to make sure no one sneaks in a
 * forbidden var via copy-paste).
 *
 * Throws on the first violation so the test fails with a clear message.
 */
export function assertMarketplaceEnv(
  env: Record<string, string | undefined>
): void {
  for (const k of Object.keys(env)) {
    if (env[k] === undefined) continue;
    const forbidden = FORBIDDEN_PREFIXES.some((p) => k.startsWith(p));
    if (forbidden && !TEAMEM_ENV_WHITELIST.has(k)) {
      throw new Error(
        `marketplace env contains forbidden var '${k}'. ` +
          `Production marketplace installs do not set this. ` +
          `If your test depends on it, you have a fixture-only behavior ` +
          `that will fail in production. See tests/helpers/marketplace-env.ts.`
      );
    }
  }
}

// Self-test: marketplaceEnv() never returns a forbidden var (the smoke
// catches refactors that drop the strip).
import { it, expect } from 'bun:test';
describe('marketplace-env helper self-test', () => {
  it('strips TEAMEM_* by default', () => {
    const env = marketplaceEnv({ TEAMEM_MEMBER_NAME: 'alice' });
    expect(env.TEAMEM_MEMBER_NAME).toBeUndefined();
  });
  it('keeps whitelisted TEAMEM_HOOK_DISABLE', () => {
    const env = marketplaceEnv({ TEAMEM_HOOK_DISABLE: '1' });
    expect(env.TEAMEM_HOOK_DISABLE).toBe('1');
  });
  it('strips TEAMEM_SPACE (production never sets it)', () => {
    const env = marketplaceEnv({ TEAMEM_SPACE: '01ULID' });
    expect(env.TEAMEM_SPACE).toBeUndefined();
  });
  it('keeps the four allowed plugin env vars when explicitly passed', () => {
    const env = marketplaceEnv({
      CLAUDE_PLUGIN_ROOT: '/p',
      CLAUDE_PLUGIN_DATA: '/d',
      CLAUDE_PLUGIN_OPTION_DEFAULT_SPACE: 'team-a',
      CLAUDE_SESSION_ID: 'sess-1'
    });
    expect(env.CLAUDE_PLUGIN_ROOT).toBe('/p');
    expect(env.CLAUDE_PLUGIN_DATA).toBe('/d');
    expect(env.CLAUDE_PLUGIN_OPTION_DEFAULT_SPACE).toBe('team-a');
    expect(env.CLAUDE_SESSION_ID).toBe('sess-1');
  });
  it('assertMarketplaceEnv throws on forbidden var', () => {
    expect(() =>
      assertMarketplaceEnv({ TEAMEM_MEMBER_NAME: 'alice' })
    ).toThrow();
  });
});
