import { describe, it, expect } from 'bun:test';
import { pathsOverlap } from '../../../src/domain/conflicts/path-match.js';

/**
 * R1/R2 mitigation: over 1k generated *disjoint* literal pairs, the matcher
 * must return false 100% of the time (no false positives on disjoint
 * literals). Symmetry is also asserted property-style.
 */
describe('pathsOverlap property tests (R1/R2)', () => {
  function rng(seed: number): () => number {
    // Mulberry32 — deterministic per-seed.
    let t = seed >>> 0;
    return () => {
      t = (t + 0x6d2b79f5) >>> 0;
      let r = t;
      r = Math.imul(r ^ (r >>> 15), r | 1);
      r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  }

  function literal(rand: () => number): string {
    // generate a literal POSIX path of 2-4 segments, each a 4-8 char a-z run
    const depth = 2 + Math.floor(rand() * 3);
    const parts: string[] = [];
    for (let i = 0; i < depth; i++) {
      const len = 4 + Math.floor(rand() * 5);
      let seg = '';
      for (let j = 0; j < len; j++) {
        seg += String.fromCharCode(97 + Math.floor(rand() * 26));
      }
      parts.push(seg);
    }
    return parts.join('/');
  }

  it('R1: 1000 random disjoint literal pairs return false', () => {
    const rand = rng(42);
    let trials = 0;
    let attempts = 0;
    while (trials < 1000 && attempts < 5000) {
      attempts++;
      const a = literal(rand);
      const b = literal(rand);
      if (a === b) continue; // discard rare collision
      expect(pathsOverlap(a, b)).toBe(false);
      trials++;
    }
    expect(trials).toBe(1000);
  });

  it('R2: symmetry holds for 500 random pairs', () => {
    const rand = rng(7);
    for (let i = 0; i < 500; i++) {
      const a = literal(rand);
      const b = literal(rand);
      expect(pathsOverlap(a, b)).toBe(pathsOverlap(b, a));
    }
  });
});
