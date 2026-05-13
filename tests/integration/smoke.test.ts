import { describe, expect, it } from 'bun:test';
import { bootstrap } from '../../src/index.js';

describe('bootstrap', () => {
  it('returns ok status', () => {
    expect(bootstrap().status).toBe('ok');
  });
});
