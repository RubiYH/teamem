import { describe, expect, it } from 'bun:test';
import {
  COORD_PREFS,
  isCoordPref,
  isLegacyCoordPref,
  normalizeCoordPref,
  resolveCoordMode,
  type CoordPref
} from '../../../src/domain/conflicts/coord-pref.js';

type Pair = {
  latter: CoordPref;
  incumbent: CoordPref;
  expected: CoordPref;
  rationale: string;
};

const PAIRS: Pair[] = [
  {
    latter: 'auto-skip',
    incumbent: 'auto-skip',
    expected: 'auto-skip',
    rationale: 'both queue and move on'
  },
  {
    latter: 'auto-skip',
    incumbent: 'auto-discuss',
    expected: 'auto-skip',
    rationale: 'auto-discuss requires both parties to opt in'
  },
  {
    latter: 'auto-discuss',
    incumbent: 'auto-skip',
    expected: 'auto-skip',
    rationale: 'one-sided auto-discuss falls back to queue'
  },
  {
    latter: 'auto-discuss',
    incumbent: 'auto-discuss',
    expected: 'auto-discuss',
    rationale: 'mutual opt-in opens autonomous discussion'
  }
];

describe('resolveCoordMode — two-mode matrix', () => {
  for (const pair of PAIRS) {
    it(`(${pair.latter}, ${pair.incumbent}) -> ${pair.expected} — ${pair.rationale}`, () => {
      expect(resolveCoordMode(pair.latter, pair.incumbent)).toBe(pair.expected);
    });
  }

  it('covers all combinations exactly once', () => {
    expect(PAIRS.length).toBe(COORD_PREFS.length * COORD_PREFS.length);
    const seen = new Set<string>();
    for (const p of PAIRS) seen.add(`${p.latter}|${p.incumbent}`);
    expect(seen.size).toBe(4);
  });

  it('exhaustive Cartesian product matches matrix expectations', () => {
    const expectedByKey = new Map<string, CoordPref>();
    for (const p of PAIRS) {
      expectedByKey.set(`${p.latter}|${p.incumbent}`, p.expected);
    }
    for (const latter of COORD_PREFS) {
      for (const incumbent of COORD_PREFS) {
        const key = `${latter}|${incumbent}`;
        const expected = expectedByKey.get(key);
        expect(expected, `missing expectation for ${key}`).toBeDefined();
        expect(resolveCoordMode(latter, incumbent)).toBe(expected!);
      }
    }
  });
});

describe('coord-pref guards and legacy normalization', () => {
  it('accepts only the two user-facing legal values', () => {
    expect(isCoordPref('auto-skip')).toBe(true);
    expect(isCoordPref('auto-discuss')).toBe(true);
    expect(isCoordPref('ask-claimant')).toBe(false);
  });

  it('recognizes ask-claimant as legacy-only data', () => {
    expect(isLegacyCoordPref('ask-claimant')).toBe(true);
    expect(normalizeCoordPref('ask-claimant')).toBe('auto-skip');
  });

  it('normalizes bogus values to auto-skip', () => {
    expect(normalizeCoordPref('AUTO-SKIP')).toBe('auto-skip');
    expect(normalizeCoordPref('skip')).toBe('auto-skip');
    expect(normalizeCoordPref('')).toBe('auto-skip');
    expect(normalizeCoordPref(null)).toBe('auto-skip');
    expect(normalizeCoordPref(undefined)).toBe('auto-skip');
    expect(normalizeCoordPref(0)).toBe('auto-skip');
    expect(normalizeCoordPref({})).toBe('auto-skip');
  });
});
