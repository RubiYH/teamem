import { describe, it, expect } from 'bun:test';
import {
  pathsOverlap,
  findOverlaps,
  normalizePathPattern
} from '../../../src/domain/conflicts/path-match.js';

describe('pathsOverlap — truth table (AC1-AC15)', () => {
  // AC1
  it('AC1: literal vs literal — equal', () => {
    expect(pathsOverlap('src/a.ts', 'src/a.ts')).toBe(true);
  });

  // AC2
  it('AC2: literal vs literal — different', () => {
    expect(pathsOverlap('src/a.ts', 'src/b.ts')).toBe(false);
  });

  // AC3
  it('AC3: literal vs `**` — match inside subtree', () => {
    expect(pathsOverlap('src/auth/login.ts', 'src/auth/**')).toBe(true);
  });

  // AC4
  it('AC4: literal vs `**` — outside subtree', () => {
    expect(pathsOverlap('src/api/user.ts', 'src/auth/**')).toBe(false);
  });

  // AC5
  it('AC5: literal vs `*` (single segment) — match', () => {
    expect(pathsOverlap('src/auth/login.ts', 'src/auth/*.ts')).toBe(true);
  });

  // AC6
  it('AC6: literal vs `*` — too many segments', () => {
    expect(pathsOverlap('src/auth/sub/login.ts', 'src/auth/*.ts')).toBe(false);
  });

  // AC7
  it('AC7: glob vs literal symmetry of AC3', () => {
    expect(pathsOverlap('src/auth/**', 'src/auth/login.ts')).toBe(true);
  });

  // AC8
  it('AC8: glob vs glob — overlapping prefixes', () => {
    expect(pathsOverlap('src/auth/**', 'src/auth/*.ts')).toBe(true);
  });

  // AC9
  it('AC9: glob vs glob — disjoint', () => {
    expect(pathsOverlap('src/auth/**', 'src/api/**')).toBe(false);
  });

  // AC10
  it('AC10: glob vs glob — `**/login.ts` overlaps `src/auth/**`', () => {
    expect(pathsOverlap('src/**/login.ts', 'src/auth/**')).toBe(true);
  });
  it('AC10b: literal vs `**`-in-middle', () => {
    expect(pathsOverlap('src/**/login.ts', 'src/auth/login.ts')).toBe(true);
  });

  // AC11 — `?`
  it('AC11: `?` matches one char', () => {
    expect(pathsOverlap('src/v1/x.ts', 'src/v?/x.ts')).toBe(true);
    expect(pathsOverlap('src/v10/x.ts', 'src/v?/x.ts')).toBe(false);
  });

  // AC12
  it('AC12: normalization strips leading `./`', () => {
    expect(pathsOverlap('./src/a.ts', 'src/a.ts')).toBe(true);
  });

  // AC13
  it('AC13: trailing slash on a directory pattern is stripped — pattern is literal "src/auth", not a glob', () => {
    expect(pathsOverlap('src/auth/', 'src/auth/login.ts')).toBe(false);
    // Self-equality after normalization still holds.
    expect(pathsOverlap('src/auth/', 'src/auth')).toBe(true);
  });

  // AC14 — symmetry property over the truth table
  it('AC14: pathsOverlap is symmetric', () => {
    const pairs: Array<[string, string]> = [
      ['src/a.ts', 'src/a.ts'],
      ['src/a.ts', 'src/b.ts'],
      ['src/auth/login.ts', 'src/auth/**'],
      ['src/api/user.ts', 'src/auth/**'],
      ['src/auth/login.ts', 'src/auth/*.ts'],
      ['src/auth/sub/login.ts', 'src/auth/*.ts'],
      ['src/auth/**', 'src/auth/*.ts'],
      ['src/auth/**', 'src/api/**'],
      ['src/**/login.ts', 'src/auth/**'],
      ['src/v1/x.ts', 'src/v?/x.ts'],
      ['src/v10/x.ts', 'src/v?/x.ts'],
      ['./src/a.ts', 'src/a.ts'],
      ['src/auth/', 'src/auth/login.ts']
    ];
    for (const [a, b] of pairs) {
      expect(pathsOverlap(a, b)).toBe(pathsOverlap(b, a));
    }
  });

  // AC15
  it('AC15: findOverlaps returns sorted unique target patterns', () => {
    const result = findOverlaps(
      ['src/auth/login.ts', 'src/api/user.ts', 'src/auth/login.ts'],
      ['src/auth/**']
    );
    expect(result).toEqual(['src/auth/login.ts']);
  });

  it('AC15b: findOverlaps sorts lexicographically', () => {
    const result = findOverlaps(
      ['src/z.ts', 'src/a.ts', 'src/m.ts'],
      ['src/**']
    );
    expect(result).toEqual(['src/a.ts', 'src/m.ts', 'src/z.ts']);
  });

  it('AC15c: findOverlaps with no overlap returns empty array', () => {
    const result = findOverlaps(['src/a.ts'], ['src/b.ts']);
    expect(result).toEqual([]);
  });
});

describe('normalizePathPattern (F6)', () => {
  it('strips leading ./', () => {
    expect(normalizePathPattern('./src/a.ts')).toBe('src/a.ts');
  });
  it('collapses double slashes', () => {
    expect(normalizePathPattern('src//a.ts')).toBe('src/a.ts');
  });
  it('strips trailing slash', () => {
    expect(normalizePathPattern('src/auth/')).toBe('src/auth');
  });
  it('preserves a bare /', () => {
    expect(normalizePathPattern('/')).toBe('/');
  });
  it('trims whitespace', () => {
    expect(normalizePathPattern('  src/a.ts  ')).toBe('src/a.ts');
  });
  it('does NOT translate backslashes (POSIX-only per Q8)', () => {
    expect(normalizePathPattern('src\\a.ts')).toBe('src\\a.ts');
  });
});

describe('pathsOverlap edge cases', () => {
  it('** at start of pattern matches any depth', () => {
    expect(pathsOverlap('**/login.ts', 'src/auth/login.ts')).toBe(true);
    expect(pathsOverlap('**/login.ts', 'login.ts')).toBe(true);
  });

  it('multi-glob *.test.ts pattern', () => {
    expect(
      pathsOverlap('tests/**/*.test.ts', 'tests/unit/conflicts/x.test.ts')
    ).toBe(true);
    expect(pathsOverlap('tests/**/*.test.ts', 'src/x.test.ts')).toBe(false);
  });

  it('glob-vs-glob with ** in middle of both', () => {
    expect(pathsOverlap('src/**/x.ts', 'src/**/y.ts')).toBe(false);
    expect(pathsOverlap('src/**/login.ts', 'src/auth/**/login.ts')).toBe(true);
  });

  it('* on filename overlaps literal extension', () => {
    expect(pathsOverlap('src/auth/*.ts', 'src/auth/index.ts')).toBe(true);
    expect(pathsOverlap('src/auth/*.js', 'src/auth/index.ts')).toBe(false);
  });
});
