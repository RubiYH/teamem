/**
 * Identity onboarding helpers (issue #8).
 *
 * Reduces setup friction by suggesting a `member_name` derived from local
 * identity sources, with sanitization that refuses generic shared-host
 * values. The user can always override the suggestion with free text.
 *
 * Resolution order:
 *   1. `git config --global user.name` (split on whitespace, take first token).
 *   2. `process.env.USER` (or env equivalent passed in).
 *   3. `os.userInfo().username` / `whoami`.
 *
 * Sanitization: any candidate matching `root|ubuntu|admin|user|nobody`
 * (case-insensitive) is refused — the caller forces a manual entry.
 *
 * The helper is dependency-injected so tests can drive every branch
 * without monkey-patching `child_process` or `os`.
 */

const GENERIC_NAMES = new Set(['root', 'ubuntu', 'admin', 'user', 'nobody']);

export interface IdentityProbe {
  /** Returns the trimmed `git config --global user.name` value, or null. */
  runGitConfigUserName(): string | null;
  /** Returns the trimmed `whoami` / username value, or null. */
  runWhoami(): string | null;
  /** Returns the value of process.env.USER (and friends) or null. */
  envUser(): string | null;
}

/**
 * Suggest a default `member_name` from the local environment, or null
 * when the only sources are generic shared-host values that should not
 * be used as a default.
 */
export function suggestMemberNameDefault(probe: IdentityProbe): string | null {
  const fromGit = probe.runGitConfigUserName();
  const gitFirst = fromGit ? firstWhitespaceToken(fromGit) : null;
  if (gitFirst && !isGeneric(gitFirst)) return gitFirst;

  const fromEnv = probe.envUser();
  if (fromEnv && !isGeneric(fromEnv)) return fromEnv;

  const fromWhoami = probe.runWhoami();
  if (fromWhoami && !isGeneric(fromWhoami)) return fromWhoami;

  return null;
}

/**
 * Returns true when the candidate is a generic shared-host value that we
 * refuse to use as a default. Caller behavior on `true`: force the user to
 * type a real name.
 */
export function isGeneric(name: string): boolean {
  return GENERIC_NAMES.has(name.trim().toLowerCase());
}

function firstWhitespaceToken(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const m = trimmed.match(/^\S+/);
  return m ? m[0] : null;
}

/**
 * Default identity probe that reads from the live process environment.
 * Test code should construct a custom IdentityProbe instead.
 */
export function realIdentityProbe(): IdentityProbe {
  return {
    runGitConfigUserName() {
      try {
        // Late require to keep this module pure for unit tests that pass
        // their own probe (no spawn under test).

        const { spawnSync } =
          require('node:child_process') as typeof import('node:child_process');
        const r = spawnSync('git', ['config', '--global', 'user.name'], {
          encoding: 'utf-8',
          timeout: 1000
        });
        if (r.status !== 0) return null;
        const out = (r.stdout ?? '').trim();
        return out.length > 0 ? out : null;
      } catch {
        return null;
      }
    },
    runWhoami() {
      try {
        const { userInfo } = require('node:os') as typeof import('node:os');
        const u = userInfo().username;
        return typeof u === 'string' && u.length > 0 ? u : null;
      } catch {
        return null;
      }
    },
    envUser() {
      const v = process.env.USER ?? process.env.USERNAME ?? '';
      return v.length > 0 ? v : null;
    }
  };
}
