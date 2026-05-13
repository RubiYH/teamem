import { describe, it, expect } from 'bun:test';
import {
  canonicalizeRepoId,
  canonicalizePath
} from '../../../src/domain/claim-identity-core.js';

describe('canonicalizeRepoId', () => {
  const cases: [string, string][] = [
    ['https://github.com/Org/Repo.git', 'github.com/org/repo'],
    ['git@github.com:org/repo.git', 'github.com/org/repo'],
    ['https://user:pat@github.com/org/repo', 'github.com/org/repo'],
    ['ssh://git@github.com/org/repo', 'github.com/org/repo'],
    ['https://Github.com/Org/Repo', 'github.com/org/repo'],
    ['ssh://git@example.com:2222/org/repo', 'example.com:2222/org/repo'],
    ['git@github.com:Org/Repo.git', 'github.com/org/repo'],
    ['https://github.com/Org/Repo', 'github.com/org/repo']
  ];

  for (const [input, expected] of cases) {
    it(`canonicalizes ${input}`, () => {
      expect(canonicalizeRepoId(input)).toBe(expected);
    });
  }
});

describe('canonicalizePath', () => {
  it('returns repo-relative path for file in tree', () => {
    expect(
      canonicalizePath('/home/bob/proj/src/Foo.tsx', '/home/bob/proj')
    ).toBe('src/Foo.tsx');
  });

  it('returns null for file outside tree', () => {
    expect(
      canonicalizePath('/home/bob/other/file.ts', '/home/bob/proj')
    ).toBeNull();
  });

  it('returns dot for path equal to toplevel', () => {
    expect(canonicalizePath('/home/bob/proj', '/home/bob/proj')).toBe('.');
  });

  it('returns nested deep path', () => {
    expect(canonicalizePath('/repo/a/b/c/d.ts', '/repo')).toBe('a/b/c/d.ts');
  });

  it('returns null for path that shares prefix but is not a child', () => {
    expect(
      canonicalizePath('/home/bob/proj2/file.ts', '/home/bob/proj')
    ).toBeNull();
  });

  it('handles trailing slash on toplevel', () => {
    expect(
      canonicalizePath('/home/bob/proj/src/foo.ts', '/home/bob/proj/')
    ).toBe('src/foo.ts');
  });
});
