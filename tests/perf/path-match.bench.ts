import { describe, it, expect } from 'bun:test';
import { pathsOverlap } from '../../src/domain/conflicts/path-match.js';

/**
 * AC24: 10,000 invocations of `pathsOverlap` on a 6-segment pattern complete
 * in < 50ms total (i.e., p99 match cost < 5µs amortized).
 */
describe('path-match micro-bench (AC24)', () => {
  it('10k pathsOverlap calls on a 6-segment pattern complete in < 50ms', () => {
    const a = 'src/auth/sub/x/y/login.ts';
    const b = 'src/**/login.ts';
    // warm
    for (let i = 0; i < 200; i++) pathsOverlap(a, b);
    const start = performance.now();
    for (let i = 0; i < 10_000; i++) {
      pathsOverlap(a, b);
    }
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(50);
  });
});
