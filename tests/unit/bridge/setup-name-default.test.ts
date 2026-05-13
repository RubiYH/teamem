/**
 * Identity onboarding helper — `suggestMemberNameDefault` (issue #8).
 *
 * Drives all branches of the resolution order through a stub probe:
 *   1. git config --global user.name → suggested verbatim (whitespace token).
 *   2. git missing, $USER → suggested.
 *   3. git missing, $USER missing, whoami → suggested.
 *   4. value matches generic-host shortlist → refused (returns null).
 *   5. all sources empty → refused.
 *   6. user override always wins (the helper produces a *suggestion*, not
 *      a binding choice — caller is free to ignore).
 */
import { describe, expect, it } from 'bun:test';
import {
  isGeneric,
  suggestMemberNameDefault,
  type IdentityProbe
} from '../../../src/cli/identity-default.js';

function probeWith(overrides: Partial<IdentityProbe>): IdentityProbe {
  return {
    runGitConfigUserName: () => null,
    runWhoami: () => null,
    envUser: () => null,
    ...overrides
  };
}

describe('suggestMemberNameDefault', () => {
  it('uses git config user.name when present and non-generic', () => {
    const r = suggestMemberNameDefault(
      probeWith({ runGitConfigUserName: () => 'alice' })
    );
    expect(r).toBe('alice');
  });

  it("takes the first whitespace token from git config (e.g. 'Alice Smith' → 'Alice')", () => {
    const r = suggestMemberNameDefault(
      probeWith({ runGitConfigUserName: () => 'Alice Smith' })
    );
    expect(r).toBe('Alice');
  });

  it('falls back to $USER when git config is empty', () => {
    const r = suggestMemberNameDefault(
      probeWith({
        runGitConfigUserName: () => null,
        envUser: () => 'alice',
        runWhoami: () => 'should-not-be-used'
      })
    );
    expect(r).toBe('alice');
  });

  it('falls back to whoami when git and $USER are empty', () => {
    const r = suggestMemberNameDefault(
      probeWith({
        runGitConfigUserName: () => null,
        envUser: () => null,
        runWhoami: () => 'alice'
      })
    );
    expect(r).toBe('alice');
  });

  it('refuses generic shared-host values (returns null) so the user is forced to type a real name', () => {
    for (const generic of ['root', 'ubuntu', 'admin', 'user', 'nobody']) {
      const r = suggestMemberNameDefault(
        probeWith({
          runGitConfigUserName: () => generic,
          envUser: () => generic,
          runWhoami: () => generic
        })
      );
      expect(r).toBeNull();
    }
  });

  it('case-insensitive generic match (UBUNTU is refused too)', () => {
    const r = suggestMemberNameDefault(
      probeWith({
        runGitConfigUserName: () => null,
        envUser: () => null,
        runWhoami: () => 'UBUNTU'
      })
    );
    expect(r).toBeNull();
  });

  it('skips a generic git value but accepts a non-generic env user', () => {
    const r = suggestMemberNameDefault(
      probeWith({
        runGitConfigUserName: () => 'root',
        envUser: () => 'alice',
        runWhoami: () => null
      })
    );
    expect(r).toBe('alice');
  });

  it('returns null when every source is empty (caller will force input)', () => {
    const r = suggestMemberNameDefault(probeWith({}));
    expect(r).toBeNull();
  });
});

describe('isGeneric', () => {
  it.each([
    ['root', true],
    ['ubuntu', true],
    ['admin', true],
    ['user', true],
    ['nobody', true],
    ['Root', true],
    ['  UBUNTU  ', true],
    ['alice', false],
    ['bob', false],
    ['', false]
  ])('isGeneric(%j) === %s', (input, expected) => {
    expect(isGeneric(input)).toBe(expected);
  });
});
