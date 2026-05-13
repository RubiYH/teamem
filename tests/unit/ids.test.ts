import { describe, expect, it } from 'bun:test';
import {
  newEventId,
  newClaimId,
  newIdempotencyKey
} from '../../src/domain/ids.js';

const ULID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/;

describe('ULID id factories', () => {
  it('newEventId returns a valid ULID', () => {
    expect(newEventId()).toMatch(ULID_REGEX);
  });

  it('newClaimId returns a valid ULID', () => {
    expect(newClaimId()).toMatch(ULID_REGEX);
  });

  it('newIdempotencyKey returns a valid ULID', () => {
    expect(newIdempotencyKey()).toMatch(ULID_REGEX);
  });

  it('successive calls produce unique values', () => {
    const ids = new Set(Array.from({ length: 100 }, () => newEventId()));
    expect(ids.size).toBe(100);
  });
});
