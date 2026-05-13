/**
 * Codex F11 — `pickEntry` accepts both `space_id` (ULID) and `label`.
 *
 * Pre-#20 the manifest asked for "Default space label" but the bridge keyed
 * `creds.spaces` by ULID, so marketplace users typing their human-readable
 * label hit `UnknownSpaceError` on bridge boot. Fix: try as space_id first,
 * then iterate entries matching `entry.label`. Ambiguous labels throw the
 * typed `AmbiguousSpaceLabelError` listing every matching space_id.
 */
import { describe, expect, it } from 'bun:test';
import {
  pickEntry,
  AmbiguousSpaceLabelError,
  UnknownSpaceError,
  type CredentialsFile,
  type CredentialEntry
} from '../../../src/bridge/credentials.js';

function entry(
  space_id: string,
  label: string,
  member_name = 'alice'
): CredentialEntry {
  return {
    space_id,
    label,
    member_name,
    jwt: 'header.payload.sig',
    jwt_exp: Math.floor(Date.now() / 1000) + 86_400,
    server_url: 'http://localhost:3000'
  };
}

function file(spaces: Record<string, CredentialEntry>): CredentialsFile {
  return {
    version: 1,
    default_space_id: Object.keys(spaces)[0] ?? null,
    spaces
  };
}

describe('pickEntry — space_id and label both accepted (Codex F11)', () => {
  it('happy path: ULID space_id resolves directly (existing behavior)', () => {
    const creds = file({ '01ABCDE': entry('01ABCDE', 'team-alpha') });
    const result = pickEntry({ flag: '01ABCDE', creds });
    expect(result.space_id).toBe('01ABCDE');
    expect(result.label).toBe('team-alpha');
  });

  it('happy path: human-readable label resolves to the matching entry', () => {
    const creds = file({
      '01ABCDE': entry('01ABCDE', 'team-alpha'),
      '01FGHIJ': entry('01FGHIJ', 'kernel-rewrite')
    });
    const result = pickEntry({ flag: 'kernel-rewrite', creds });
    expect(result.space_id).toBe('01FGHIJ');
    expect(result.label).toBe('kernel-rewrite');
  });

  it('label and space_id with same string: space_id wins (try-id-first ordering)', () => {
    // Edge case: a space whose id literally is "team-alpha" + another whose
    // label is "team-alpha". The id lookup wins — pre-#20 behavior is
    // preserved for clients that already passed ULIDs.
    const creds = file({
      'team-alpha': entry('team-alpha', 'something-else'),
      '01XYZ': entry('01XYZ', 'team-alpha')
    });
    const result = pickEntry({ flag: 'team-alpha', creds });
    expect(result.space_id).toBe('team-alpha');
    expect(result.label).toBe('something-else');
  });

  it('ambiguous label across two entries throws AmbiguousSpaceLabelError listing matching_ids', () => {
    const creds = file({
      '01AAA': entry('01AAA', 'shared-label'),
      '01BBB': entry('01BBB', 'shared-label')
    });
    let thrown: unknown;
    try {
      pickEntry({ flag: 'shared-label', creds });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AmbiguousSpaceLabelError);
    if (thrown instanceof AmbiguousSpaceLabelError) {
      expect(thrown.label).toBe('shared-label');
      expect(thrown.matching_ids.sort()).toEqual(['01AAA', '01BBB']);
      expect(thrown.message).toContain('shared-label');
      expect(thrown.message).toContain('01AAA');
      expect(thrown.message).toContain('01BBB');
    }
  });

  it('unknown input (neither space_id nor any label) throws UnknownSpaceError', () => {
    const creds = file({ '01ABCDE': entry('01ABCDE', 'team-alpha') });
    let thrown: unknown;
    try {
      pickEntry({ flag: 'does-not-exist', creds });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(UnknownSpaceError);
  });

  it('TEAMEM_SPACE env with label resolves like --space flag', () => {
    const creds = file({
      '01AAA': entry('01AAA', 'team-alpha'),
      '01BBB': entry('01BBB', 'kernel-rewrite')
    });
    const result = pickEntry({ env: 'kernel-rewrite', creds });
    expect(result.space_id).toBe('01BBB');
  });

  it('default_space_id resolution via label still works', () => {
    const creds: CredentialsFile = {
      version: 1,
      default_space_id: 'team-alpha', // user typed label as default
      spaces: {
        '01CCC': entry('01CCC', 'team-alpha')
      }
    };
    const result = pickEntry({ creds });
    expect(result.space_id).toBe('01CCC');
  });

  it('no input + no default throws UnknownSpaceError("(none)")', () => {
    const creds: CredentialsFile = {
      version: 1,
      default_space_id: null,
      spaces: {}
    };
    let thrown: unknown;
    try {
      pickEntry({ creds });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(UnknownSpaceError);
  });
});
